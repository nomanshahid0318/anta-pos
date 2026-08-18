"""Inventory, GRN, warehouse routes."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import HOWarehouse, Inventory, Product, StoreGRN, SupplierGRN
from ..schemas import GRNIssueIn, GRNReceiveIn, SupplierGRNIn
from ..services.inventory import get_or_create_inv, get_stock, update_ho_warehouse, update_inv
from ..utils import today_str

router = APIRouter(prefix="/api", tags=["inventory"])


@router.get("/inventory")
def list_inventory(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    store_id: Optional[str] = None,
    q: Optional[str] = None,
):
    """Store inventory listing (POS 'Inventory' screen).

    Two fixes:
    1. Old version ran one Inventory query PER active product (up to
       6,000+ queries on a big catalog) — this is what made the screen
       hang/come back empty. Now: one query for the store's inventory
       rows, one for the matching products.
    2. Only products this store has actually received at least once
       (grn_in > 0) are shown — a store's inventory screen shouldn't list
       the entire company-wide catalog with 0 stock for everything it was
       never sent.
    """
    sid = store_id or user.store_id
    inv_rows = db.query(Inventory).filter(Inventory.store_id == str(sid)).all()
    received = [r for r in inv_rows if (r.grn_in or 0) > 0]
    if not received:
        return {"ok": True, "data": []}

    barcodes = [r.barcode for r in received]
    products_by_barcode = {
        p.barcode: p for p in db.query(Product).filter(Product.barcode.in_(barcodes)).all()
    }

    rows = []
    for inv in received:
        p = products_by_barcode.get(inv.barcode)
        if not p:
            continue
        if q and q.lower() not in (p.name or "").lower() and q not in p.barcode:
            continue
        on_hand = int(inv.on_hand or 0)
        reorder = p.reorder or 5
        status = "OUT" if on_hand <= 0 else ("LOW" if on_hand <= reorder else "OK")
        rows.append({
            "barcode": p.barcode,
            "name": p.name,
            "opening": p.opening or 0,
            "grnIn": int(inv.grn_in or 0),
            "sold": int(inv.sales_out or 0),
            "returns": int(inv.returns_in or 0),
            "claims": int(inv.claims or 0),
            "onHand": on_hand,
            "reorder": reorder,
            "status": status,
            "cost": p.cost or 0,
            "retail": p.retail or 0,
        })
    return {"ok": True, "data": rows}


@router.get("/grns")
def list_store_grns(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    status: Optional[str] = "pending",
    store_id: Optional[str] = None,
):
    q = db.query(StoreGRN)
    sid = store_id or user.store_id
    if user.role != "admin" or store_id:
        if sid and sid != "HO":
            q = q.filter(StoreGRN.store_id == sid)
    if status:
        q = q.filter(StoreGRN.status == status)
    rows = q.order_by(StoreGRN.id.desc()).all()
    data = [
        {
            "GRNID": r.grn_id,
            "Date": r.date,
            "StoreID": r.store_id,
            "StoreName": r.store_name,
            "Barcode": r.barcode,
            "Name": r.name,
            "QtyIssued": r.qty_issued,
            "QtyReceived": r.qty_received,
            "Status": r.status,
            "Notes": r.notes or "",
            "ReceivedBy": r.received_by or "",
            "ReceivedAt": r.received_at.strftime("%Y-%m-%d %H:%M") if r.received_at else "",
        }
        for r in rows
    ]
    return {"ok": True, "data": data}


@router.post("/grns/receive")
def receive_grn(
    body: GRNReceiveIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    row = (
        db.query(StoreGRN)
        .filter(
            StoreGRN.grn_id == body.grnId,
            StoreGRN.barcode == body.barcode,
            StoreGRN.store_id == body.storeId,
        )
        .first()
    )
    if not row:
        # try without store match
        row = (
            db.query(StoreGRN)
            .filter(StoreGRN.grn_id == body.grnId, StoreGRN.barcode == body.barcode)
            .first()
        )
    if not row:
        raise HTTPException(status_code=404, detail="GRN line not found")
    if row.status == "received":
        raise HTTPException(status_code=400, detail="GRN already received")

    qty = int(body.qty or 0)
    row.qty_received = qty
    row.status = "received"
    row.received_at = datetime.utcnow()
    row.received_by = user.name or user.user_id
    store_name = body.storeName or row.store_name or user.store_name
    store_id = body.storeId or row.store_id or user.store_id
    update_inv(db, body.barcode, store_name, store_id, row.name or "", "grn", qty)
    db.commit()
    return {"ok": True, "status": "ok"}


@router.post("/grns/issue")
def issue_grn(
    body: GRNIssueIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    grn_id = body.grnId or f"GRN-{int(__import__('time').time())}"
    date = body.date or today_str()
    count = 0
    errors = []
    for line in body.lines:
        wh = db.query(HOWarehouse).filter(HOWarehouse.barcode == line.barcode).first()
        ho_stock = int(wh.on_hand) if wh else 0
        # Allow issue even if HO empty when no warehouse tracking yet — use product opening as soft stock
        if wh and ho_stock < (line.qty or 0):
            errors.append(f"{line.barcode} insufficient ({ho_stock})")
            continue
        db.add(
            StoreGRN(
                grn_id=grn_id,
                date=date,
                store_id=body.storeId,
                store_name=body.storeName,
                barcode=line.barcode,
                name=line.name or "",
                qty_issued=line.qty or 0,
                qty_received=0,
                status="pending",
                notes=body.notes or "",
            )
        )
        if line.qty:
            update_ho_warehouse(db, line.barcode, line.name or "", line.qty, "out")
        count += 1
    db.commit()
    return {"ok": True, "status": "ok", "count": count, "grnId": grn_id, "errors": errors}


@router.post("/grns/supplier")
def supplier_grn(
    body: SupplierGRNIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    grn_id = body.grnId or f"SGRN-{int(__import__('time').time())}"
    date = body.date or today_str()
    count = 0
    for line in body.lines:
        total = (line.qty or 0) * (line.cost or 0)
        db.add(
            SupplierGRN(
                grn_id=grn_id,
                date=date,
                supplier=body.supplier or "",
                invoice_no=body.invoiceNo or "",
                barcode=line.barcode,
                name=line.name or "",
                qty=line.qty or 0,
                unit_cost=line.cost or 0,
                total_cost=total,
                notes=body.notes or "",
            )
        )
        update_ho_warehouse(db, line.barcode, line.name or "", line.qty or 0, "in")
        # Ensure product exists lightly
        if not db.query(Product).filter(Product.barcode == line.barcode).first():
            db.add(
                Product(
                    barcode=line.barcode,
                    name=line.name or line.barcode,
                    cost=line.cost or 0,
                    retail=0,
                    active=True,
                )
            )
        count += 1
    db.commit()
    return {"ok": True, "status": "ok", "count": count, "grnId": grn_id}


@router.get("/warehouse")
def list_warehouse(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    rows = db.query(HOWarehouse).order_by(HOWarehouse.name).all()
    data = [
        {
            "barcode": r.barcode,
            "name": r.name,
            "supplierIn": r.supplier_in,
            "storeOut": r.store_out,
            "onHand": r.on_hand,
        }
        for r in rows
    ]
    return {"ok": True, "data": data}


@router.post("/inventory/ensure")
def ensure_opening_stock(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    store_id: Optional[str] = None,
):
    """Materialize an (empty) inventory row for a store's products (first-time).

    NOTE: this used to seed on_hand from Product.opening — that was a bug,
    since `opening` is HO Warehouse's starting stock, not a per-store
    quantity (see get_or_create_inv). It now just makes sure a zeroed row
    exists; real stock only ever arrives via a received Store GRN.
    """
    sid = store_id or user.store_id
    if sid == "HO":
        return {"ok": True, "count": 0}
    store_name = user.store_name
    products = db.query(Product).filter(Product.active.is_(True)).all()
    n = 0
    for p in products:
        get_or_create_inv(db, p.barcode, store_name, sid, p.name)
        n += 1
    db.commit()
    return {"ok": True, "count": n}


@router.post("/inventory/recalculate")
def recalculate_store_inventory(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
    store_id: Optional[str] = None,
):
    """Fix a store's inventory after the Product.opening phantom-stock bug:
    rebuilds `grn_in` for every product in this store strictly from actual
    received Store GRN history (StoreGRN rows with status='received'),
    replacing whatever phantom value got seeded by the old /inventory/ensure
    behavior. Sales, returns, exchanges, and claims are left completely
    untouched — those are real transaction history, not part of the bug.

    Safe to run more than once; it always recomputes from the same source
    of truth (received GRNs), so it converges to the correct number.
    """
    sid = store_id
    if not sid or sid == "HO":
        raise HTTPException(status_code=400, detail="Choose a specific store")

    received_rows = (
        db.query(StoreGRN.barcode, func.sum(StoreGRN.qty_received))
        .filter(StoreGRN.store_id == sid, StoreGRN.status == "received")
        .group_by(StoreGRN.barcode)
        .all()
    )
    received_by_barcode = {barcode: int(total or 0) for barcode, total in received_rows}

    inv_rows = db.query(Inventory).filter(Inventory.store_id == sid).all()
    updated = 0
    for row in inv_rows:
        correct_grn_in = received_by_barcode.get(row.barcode, 0)
        if row.grn_in != correct_grn_in:
            row.grn_in = correct_grn_in
            row.recalc()
            row.updated_at = datetime.utcnow()
            updated += 1
    db.commit()
    return {"ok": True, "status": "ok", "updated": updated, "storeId": sid}


@router.post("/inventory/reset-all-stores")
def reset_all_stores(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin"))]):
    """Zero out EVERY store's inventory in one click (all stores, not HO).
    This deletes the Inventory rows entirely — next time a store receives
    a GRN, a fresh row is created. Sale/Return/Exchange transaction
    records themselves are untouched; this only resets the stock counters.
    """
    n = db.query(Inventory).filter(Inventory.store_id != "HO").count()
    db.query(Inventory).filter(Inventory.store_id != "HO").delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "status": "ok", "deleted": n}
