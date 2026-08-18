"""Products, banks, stores CRUD."""
from __future__ import annotations
 
from typing import Annotated, Optional
 
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy import case
from sqlalchemy.orm import Session
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
 
import json
import re
from datetime import datetime
 
from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import Bank, HOWarehouse, Inventory, Product, Setting, Store
from ..schemas import BankIn, BankOut, ProductIn, ProductOut, StoreIn, StoreOut
from ..services.inventory import get_stock, set_ho_warehouse_qty
 
router = APIRouter(prefix="/api", tags=["catalog"])
 
CATEGORIES_SETTING_KEY = "product_categories"
DEFAULT_CATEGORIES = ["Running", "Casual", "Basketball", "Training", "Kids", "Slippers", "Other"]
 
 
def _load_categories(db: Session) -> list[str]:
    row = db.query(Setting).filter(Setting.key == CATEGORIES_SETTING_KEY).first()
    if not row or not row.value:
        return list(DEFAULT_CATEGORIES)
    try:
        cats = json.loads(row.value)
        if isinstance(cats, list) and cats:
            return [str(c) for c in cats]
    except Exception:  # noqa: BLE001
        pass
    return list(DEFAULT_CATEGORIES)
 
 
def _save_categories(db: Session, cats: list[str]) -> None:
    row = db.query(Setting).filter(Setting.key == CATEGORIES_SETTING_KEY).first()
    value = json.dumps(cats)
    if row:
        row.value = value
    else:
        db.add(Setting(key=CATEGORIES_SETTING_KEY, value=value))
 
 
@router.get("/categories")
def list_categories(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    return {"ok": True, "status": "ok", "categories": _load_categories(db)}
 
 
@router.post("/categories")
def add_category(
    body: dict,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category name is required")
    cats = _load_categories(db)
    if not any(c.lower() == name.lower() for c in cats):
        cats.append(name)
        _save_categories(db, cats)
        db.commit()
    return {"ok": True, "status": "ok", "categories": cats}
 
 
@router.delete("/categories/{name}")
def delete_category(
    name: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    cats = _load_categories(db)
    cats = [c for c in cats if c.lower() != name.lower()]
    if not cats:
        cats = list(DEFAULT_CATEGORIES)
    _save_categories(db, cats)
    db.commit()
    return {"ok": True, "status": "ok", "categories": cats}
 
 
@router.get("/products")
def list_products(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    q: Optional[str] = None,
    store_id: Optional[str] = None,
    active_only: bool = True,
    limit: Optional[int] = None,
    offset: int = 0,
):
    """List products.

    For a STORE login (not HO), this only returns products that store has
    actually received via a completed GRN (Inventory.grn_in > 0) — a
    store's POS shouldn't show the entire company-wide catalog, only what
    it's actually been sent. HO / Product Master (store_id resolves to
    "HO") is unaffected and still sees everything.

    Perf notes (matter once the catalog has thousands of rows):
    1. Stock is computed with ONE query for the whole store instead of a
       query per product (was up to 2 queries per product = 13,000+ queries
       on a 6,687-product catalog on every sync).
    2. Results bypass Pydantic's response_model validation, which has a
       real CPU cost for thousands of rows on a throttled free instance.

    `limit`/`offset` are optional — omit for the full (store-scoped) list;
    pass them to page through the list server-side (HO Product Master).
    """
    query = db.query(Product)
    if active_only:
        query = query.filter(Product.active.is_(True))
    if q:
        like = f"%{q}%"
        query = query.filter((Product.name.ilike(like)) | (Product.barcode.ilike(like)))

    sid = store_id or user.store_id
    is_store_scoped = bool(sid) and sid != "HO"

    stock_by_barcode: dict[str, int] = {}
    if is_store_scoped:
        inv_rows = (
            db.query(Inventory.barcode, Inventory.on_hand, Inventory.grn_in)
            .filter(Inventory.store_id == str(sid))
            .all()
        )
        stock_by_barcode = {barcode: int(on_hand or 0) for barcode, on_hand, grn_in in inv_rows}
        received_barcodes = [barcode for barcode, on_hand, grn_in in inv_rows if (grn_in or 0) > 0]
        query = query.filter(Product.barcode.in_(received_barcodes))

    query = query.order_by(Product.name)
    if limit is not None:
        query = query.offset(offset).limit(limit)
    rows = query.all()

    out = []
    for p in rows:
        stock = stock_by_barcode.get(p.barcode, 0) if is_store_scoped else None
        out.append({
            "barcode": p.barcode,
            "name": p.name,
            "brand": p.brand or "ANTA",
            "category": p.category or "",
            "size": p.size or "",
            "color": getattr(p, "color", "") or "",
            "department": getattr(p, "department", "") or "",
            "season": getattr(p, "season", "") or "",
            "gender": getattr(p, "gender", "") or "",
            "cost": p.cost or 0,
            "retail": p.retail or 0,
            "originalPrice": getattr(p, "original_price", 0) or 0,
            "reorder": p.reorder or 5,
            "opening": p.opening or 0,
            "active": bool(p.active),
            "stock": stock,
        })
    return out


@router.get("/products/count")
def count_products(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    q: Optional[str] = None,
    active_only: bool = True,
):
    """Total matching product count, for building pagination UI without
    having to fetch every row just to count them."""
    query = db.query(Product)
    if active_only:
        query = query.filter(Product.active.is_(True))
    if q:
        like = f"%{q}%"
        query = query.filter((Product.name.ilike(like)) | (Product.barcode.ilike(like)))
    return {"ok": True, "count": query.count()}


@router.get("/products/lookup/{barcode}")
def lookup_product(
    barcode: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    """Look up a single product by exact barcode — used by GRN/Transfer
    forms to auto-fill name/cost as you type a barcode, without needing
    the whole catalog loaded client-side."""
    p = db.query(Product).filter(Product.barcode == barcode).first()
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    return {
        "ok": True,
        "barcode": p.barcode,
        "name": p.name,
        "cost": p.cost or 0,
        "retail": p.retail or 0,
    }
 
 
@router.post("/products", response_model=ProductOut)
def save_product(
    body: ProductIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    lookup_barcode = body.old_barcode or body.barcode
    row = db.query(Product).filter(Product.barcode == lookup_barcode).first()
    renaming = bool(body.old_barcode and body.old_barcode != body.barcode)
    if renaming:
        clash = db.query(Product).filter(Product.barcode == body.barcode).first()
        if clash and (not row or clash.id != row.id):
            raise HTTPException(status_code=400, detail=f"Barcode {body.barcode} is already used by another product")
    if row:
        if renaming:
            row.barcode = body.barcode
            db.query(Inventory).filter(Inventory.barcode == lookup_barcode).update(
                {Inventory.barcode: body.barcode}, synchronize_session=False
            )
            db.query(HOWarehouse).filter(HOWarehouse.barcode == lookup_barcode).update(
                {HOWarehouse.barcode: body.barcode}, synchronize_session=False
            )
        row.name = body.name
        row.brand = body.brand
        row.category = body.category
        row.size = body.size
        row.color = body.color
        row.department = body.department
        row.season = body.season
        row.gender = body.gender
        row.cost = body.cost
        row.retail = body.retail
        # Original Price is set once and stays fixed — only touch it if
        # the caller explicitly sent a value (edit form deliberately
        # correcting it), or if this product never had one yet.
        if body.originalPrice is not None:
            row.original_price = body.originalPrice
        elif not getattr(row, "original_price", 0):
            row.original_price = row.retail
        row.reorder = body.reorder
        row.opening = body.opening
        row.active = body.active
    else:
        row = Product(
            barcode=body.barcode,
            name=body.name,
            brand=body.brand,
            category=body.category,
            color=body.color,
            department=body.department,
            season=body.season,
            gender=body.gender,
            size=body.size,
            cost=body.cost,
            retail=body.retail,
            original_price=body.originalPrice if body.originalPrice is not None else body.retail,
            reorder=body.reorder,
            opening=body.opening,
            active=body.active,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    if body.qty is not None:
        set_ho_warehouse_qty(db, body.barcode, body.name, body.qty)
        db.commit()
    return ProductOut(
        barcode=row.barcode,
        name=row.name,
        brand=row.brand,
        category=row.category,
        size=row.size,
        color=getattr(row, "color", "") or "",
        department=getattr(row, "department", "") or "",
        season=getattr(row, "season", "") or "",
        gender=getattr(row, "gender", "") or "",
        cost=row.cost,
        retail=row.retail,
        originalPrice=getattr(row, "original_price", 0) or 0,
        reorder=row.reorder,
        opening=row.opening,
        active=row.active,
    )
 
 
PRODUCT_UPSERT_COLS = [
    "name", "brand", "category", "size", "color", "department",
    "season", "gender", "cost", "retail", "reorder", "opening", "active",
]
 
 
def _bulk_upsert_products(db: Session, rows: list[dict]) -> None:
    """Upsert many products in chunked INSERT ... ON CONFLICT statements.
 
    One round trip per chunk of 500 rows instead of one round trip per row —
    this is what makes imports of thousands of rows fast on a networked
    (Render/Postgres) database instead of only fast on local SQLite.
    """
    if not rows:
        return
    insert_fn = pg_insert if db.bind.dialect.name == "postgresql" else sqlite_insert
    CHUNK = 500
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i + CHUNK]
        stmt = insert_fn(Product).values(chunk)
        set_dict = {c: getattr(stmt.excluded, c) for c in PRODUCT_UPSERT_COLS}
        set_dict["updated_at"] = datetime.utcnow()
        # Original Price is set once and stays fixed on re-uploads — a
        # bulk re-import (e.g. fixing a typo in one column) must NOT
        # silently reset every product's original price. Only overwrite
        # it when the incoming row explicitly carries a positive value
        # (see the 0-sentinel logic in bulk_save_products above); 0 means
        # "not specified", so the existing stored value is kept.
        set_dict["original_price"] = case(
            (stmt.excluded.original_price > 0, stmt.excluded.original_price),
            else_=Product.original_price,
        )
        stmt = stmt.on_conflict_do_update(index_elements=["barcode"], set_=set_dict)
        db.execute(stmt)
 
 
def _bulk_upsert_ho_qty(db: Session, qty_updates: dict[str, tuple[int, str]]) -> None:
    """Batched version of set_ho_warehouse_qty for many barcodes at once,
    processed in memory-bounded chunks of 500 (commit + expunge_all per
    chunk) so a large product import can't hold thousands of HOWarehouse
    ORM objects in RAM at once — that's what crashes a 512MB instance.
    """
    if not qty_updates:
        return
    items = list(qty_updates.items())
    CHUNK = 500
    for i in range(0, len(items), CHUNK):
        chunk = items[i:i + CHUNK]
        barcodes = [bc for bc, _ in chunk]
        existing_wh = {
            w.barcode: w
            for w in db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(barcodes)).all()
        }
        for bc, (qty, name) in chunk:
            row = existing_wh.get(bc)
            if not row:
                row = HOWarehouse(barcode=bc, name=name or "", supplier_in=0, store_out=0, on_hand=0)
                db.add(row)
            row.supplier_in = int(qty or 0) + (row.store_out or 0)
            row.recalc()
            if name:
                row.name = name
        db.commit()
        db.expunge_all()
 
@router.post("/products/bulk")
def bulk_save_products(
    body: list[dict],
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    """Upsert many products fast, while still isolating bad rows.
 
    Every row is validated in pure Python first (no DB touched), so a bad
    row is reported and skipped without affecting any other row — same
    safety guarantee as before. Valid rows are then written in chunked
    INSERT ... ON CONFLICT statements (see _bulk_upsert_products) instead
    of one SAVEPOINT + flush + commit per row, which is what made large
    imports slow on a networked database.
 
    Returns per-row results (`results`) in the same order as the input,
    so the caller can build a full pass/fail event log — not just totals.
    """
    raw_barcodes = [str((r or {}).get("barcode", "")).strip() for r in body]
    existing_barcodes: set[str] = {
        b for (b,) in db.query(Product.barcode)
        .filter(Product.barcode.in_([b for b in raw_barcodes if b]))
        .all()
    }
 
    created = 0
    updated = 0
    errors: list[str] = []
    results: list[dict] = []
    valid_rows: list[dict] = []
    qty_updates: dict[str, tuple[int, str]] = {}
 
    for raw in body:
        bc_for_error = str((raw or {}).get("barcode", "?")).strip() or "?"
        name_for_error = str((raw or {}).get("name", "")).strip()
        try:
            item = ProductIn(**(raw or {}))
        except Exception as e:  # noqa: BLE001 — pydantic ValidationError etc.
            # Extract a cleaner error message from Pydantic validation errors
            error_msg = str(e)
            if 'validation error' in error_msg.lower():
                try:
                    if 'Input should be' in error_msg:
                        match = re.search(r'(\w+)\s+Input should be', error_msg)
                        if match:
                            field = match.group(1)
                            error_msg = f"Invalid {field} — {error_msg.split('Input should be')[1].split('[')[0].strip()}"
                except Exception:
                    pass
            msg = f"{bc_for_error}: {error_msg}"
            errors.append(msg)
            results.append({"barcode": bc_for_error, "name": name_for_error, "status": "failed", "reason": error_msg})
            continue
        if not item.barcode or not item.name:
            msg = f"{bc_for_error}: missing barcode or name"
            errors.append(msg)
            results.append({"barcode": bc_for_error, "name": name_for_error, "status": "failed", "reason": "missing barcode or name"})
            continue
 
        is_update = item.barcode in existing_barcodes
        explicit_original = item.originalPrice if (item.originalPrice or 0) > 0 else None
        if explicit_original is not None:
            row_original_price = explicit_original
        elif is_update:
            # Existing product, no Original Price given in this row — send
            # 0 as a "don't touch it" sentinel; _bulk_upsert_products only
            # overwrites the stored Original Price when the incoming value
            # is positive, so this preserves whatever it already was.
            row_original_price = 0
        else:
            # Brand-new product with no Original Price specified — there's
            # nothing existing to preserve, so it starts equal to the
            # current retail price (same as the single add/edit form).
            row_original_price = item.retail
        valid_rows.append({
            "barcode": item.barcode, "name": item.name, "brand": item.brand, "category": item.category,
            "size": item.size, "color": item.color, "department": item.department, "season": item.season,
            "gender": item.gender, "cost": item.cost, "retail": item.retail, "reorder": item.reorder,
            "opening": item.opening, "active": item.active,
            "original_price": row_original_price,
        })
        existing_barcodes.add(item.barcode)  # dedupe within the same batch
        if is_update:
            updated += 1
            results.append({"barcode": item.barcode, "name": item.name, "status": "updated", "reason": ""})
        else:
            created += 1
            results.append({"barcode": item.barcode, "name": item.name, "status": "created", "reason": ""})
        if item.qty is not None:
            qty_updates[item.barcode] = (item.qty, item.name)
 
    try:
        _bulk_upsert_products(db, valid_rows)
        db.commit()
    except Exception as e:  # noqa: BLE001 — a DB-level failure here is real, surface it
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Bulk product write failed: {e}")
 
    try:
        _bulk_upsert_ho_qty(db, qty_updates)
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        errors.append(f"Stock quantities not fully updated — {e}")
 
    return {"ok": True, "status": "ok", "created": created, "updated": updated, "errors": errors, "results": results}
 
 
@router.delete("/products/{barcode}")
def delete_product(
    barcode: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    row = db.query(Product).filter(Product.barcode == barcode).first()
    if not row:
        raise HTTPException(status_code=404, detail="Product not found")
    db.delete(row)
    db.commit()
    return {"ok": True, "status": "ok"}
 
 
@router.post("/products/bulk-delete")
def bulk_delete_products(
    barcodes: list[str],
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    n = db.query(Product).filter(Product.barcode.in_(barcodes)).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "status": "ok", "deleted": n}
 
 
@router.get("/banks", response_model=list[BankOut])
def list_banks(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    rows = db.query(Bank).filter(Bank.active.is_(True)).order_by(Bank.id).all()
    return [
        BankOut(
            bank_id=b.bank_id,
            name=b.name,
            account_no=b.account_no or "",
            device=b.device or "",
            active=b.active,
            icon=b.icon or "💳",
        )
        for b in rows
    ]
 
 
@router.post("/banks", response_model=BankOut)
def save_bank(
    body: BankIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
):
    bid = body.bank_id or f"B{int(__import__('time').time())}"
    row = db.query(Bank).filter(Bank.bank_id == bid).first()
    if row:
        row.name = body.name
        row.account_no = body.account_no
        row.device = body.device
        row.active = body.active
        row.icon = body.icon
    else:
        row = Bank(
            bank_id=bid,
            name=body.name,
            account_no=body.account_no,
            device=body.device,
            active=body.active,
            icon=body.icon,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    return BankOut(
        bank_id=row.bank_id,
        name=row.name,
        account_no=row.account_no or "",
        device=row.device or "",
        active=row.active,
        icon=row.icon or "💳",
    )
 
 
@router.get("/stores/all", response_model=list[StoreOut])
def all_stores(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    rows = db.query(Store).order_by(Store.store_id).all()
    return [
        StoreOut(
            store_id=r.store_id,
            name=r.name,
            city=r.city or "",
            address=r.address or "",
            manager=r.manager or "",
            phone=r.phone or "",
            active=r.active,
        )
        for r in rows
    ]
 
 
@router.post("/stores", response_model=StoreOut)
def save_store(
    body: StoreIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
):
    row = db.query(Store).filter(Store.store_id == body.store_id).first()
    if row:
        row.name = body.name
        row.city = body.city
        row.address = body.address
        row.manager = body.manager
        row.phone = body.phone
        row.active = body.active
    else:
        row = Store(
            store_id=body.store_id,
            name=body.name,
            city=body.city,
            address=body.address,
            manager=body.manager,
            phone=body.phone,
            active=body.active,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    return StoreOut(
        store_id=row.store_id,
        name=row.name,
        city=row.city or "",
        address=row.address or "",
        manager=row.manager or "",
        phone=row.phone or "",
        active=row.active,
    )
 