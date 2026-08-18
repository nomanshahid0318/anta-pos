"""Head Office APIs: warehouse, GRNs, transfer, P&L, accounting."""
from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import CurrentUser, require_role
from ..database import get_db
from ..models import (
    Expense, HOWarehouse, Inventory, Product, Return, Sale, Store, StoreGRN, SupplierGRN, Transfer,
)
from ..models_accounting import BSEntry, CapitalEntry, CFItem, Supplier, SupplierTxn
from ..services.inventory import update_ho_warehouse, update_inv
from ..utils import today_str

router = APIRouter(prefix="/api/ho", tags=["head-office"])


def _admin(user: CurrentUser = Depends(require_role("admin", "manager", "accountant"))) -> CurrentUser:
    return user


def _stock_admin(user: CurrentUser = Depends(require_role("admin", "manager"))) -> CurrentUser:
    return user


class SGRNLine(BaseModel):
    barcode: str
    name: str = ""
    qty: int = 0
    cost: float = 0


class SGRNIn(BaseModel):
    grnId: Optional[str] = None
    date: Optional[str] = None
    supplier: str = ""
    invoiceNo: str = ""
    notes: str = ""
    lines: list[SGRNLine]


class StGRNLine(BaseModel):
    barcode: str
    name: str = ""
    qty: int = 0


class StGRNIn(BaseModel):
    grnId: Optional[str] = None
    date: Optional[str] = None
    storeId: str
    storeName: str = ""
    notes: str = ""
    lines: list[StGRNLine]


class TransferLine(BaseModel):
    barcode: str
    name: str = ""
    qty: int = 1
    notes: str = ""


class TransferIn(BaseModel):
    date: Optional[str] = None
    fromStoreId: str
    fromStore: str = ""
    toStoreId: str
    toStore: str = ""
    lines: list[TransferLine]


class SupplierIn(BaseModel):
    supplierId: Optional[str] = None
    name: str
    contact: str = ""
    limit: float = 0
    terms: str = "Net 30"


class SupplierTxnIn(BaseModel):
    supplierId: str
    date: Optional[str] = None
    type: str = "invoice"
    amount: float
    ref: str = ""
    notes: str = ""


class CapitalIn(BaseModel):
    date: Optional[str] = None
    type: str
    amount: float
    description: str = ""


class BSIn(BaseModel):
    date: Optional[str] = None
    type: str
    description: str
    amount: float


class CFIn(BaseModel):
    section: str
    label: str
    value: float
    date: Optional[str] = None


@router.get("/warehouse")
def warehouse(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """HO Warehouse stock listing. Brand is looked up with ONE query for
    all barcodes instead of one query per row — the old version issued a
    Product query per HOWarehouse row (thousands of queries on a big
    catalog), and this endpoint is part of the main dashboard load that
    runs on every login and every 90s auto-refresh.
    """
    rows = db.query(HOWarehouse).order_by(HOWarehouse.name).all()
    barcodes = [r.barcode for r in rows]
    brand_by_barcode = {
        b: (brand or "ANTA")
        for b, brand in db.query(Product.barcode, Product.brand).filter(Product.barcode.in_(barcodes)).all()
    } if barcodes else {}
    out = [{
        "Barcode": r.barcode, "Name": r.name, "Brand": brand_by_barcode.get(r.barcode, "ANTA"),
        "Supplier_In": r.supplier_in, "Store_Out": r.store_out, "OnHand": r.on_hand,
    } for r in rows]
    return {"ok": True, "status": "ok", "data": out}


@router.delete("/warehouse/all")
def delete_all_warehouse(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Wipe ALL HO Warehouse stock rows (does not touch Product Master —
    products stay, only their warehouse stock counters are cleared). Use
    this to clean up after a bad bulk upload before re-importing fresh.
    """
    n = db.query(HOWarehouse).count()
    db.query(HOWarehouse).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "status": "ok", "deleted": n}


@router.post("/warehouse/bulk-delete")
def bulk_delete_warehouse(barcodes: list[str], db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Delete selected HO Warehouse stock rows by barcode (Products stay,
    only the warehouse stock counters for these barcodes are removed)."""
    if not barcodes:
        return {"ok": True, "status": "ok", "deleted": 0}
    n = db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(barcodes)).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "status": "ok", "deleted": n}


@router.get("/supplier-grns")
def list_supplier_grns(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(_admin)],
    q: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
):
    """Supplier GRN line history, searchable and paginated.

    A single bulk upload creates ONE grn_id shared across thousands of
    lines, so browsing/fixing individual lines needs search + paging here
    — the same way Product Master works — rather than only being able to
    delete an entire GRN (which could mean thousands of lines) at once.
    """
    query = db.query(SupplierGRN)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (SupplierGRN.barcode.ilike(like)) | (SupplierGRN.name.ilike(like)) | (SupplierGRN.grn_id.ilike(like))
        )
    rows = query.order_by(SupplierGRN.id.desc()).offset(offset).limit(limit).all()
    data = [{
        "id": r.id, "GRNID": r.grn_id, "Date": r.date, "Supplier": r.supplier, "InvoiceNo": r.invoice_no,
        "Barcode": r.barcode, "Name": r.name, "Qty": r.qty, "UnitCost": r.unit_cost,
        "TotalCost": r.total_cost, "Notes": r.notes or "",
    } for r in rows]
    return {"ok": True, "status": "ok", "data": data}


@router.get("/supplier-grns/count")
def count_supplier_grns(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(_admin)],
    q: Optional[str] = None,
):
    query = db.query(SupplierGRN)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (SupplierGRN.barcode.ilike(like)) | (SupplierGRN.name.ilike(like)) | (SupplierGRN.grn_id.ilike(like))
        )
    return {"ok": True, "count": query.count()}


@router.get("/store-grns")
def list_all_store_grns(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(_admin)],
    status: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 300,
    offset: int = 0,
):
    """Send-to-Store GRN line history, searchable + paginated (same pattern
    as Product Master / Supplier GRN History) — a big consolidated upload
    can put thousands of lines under one status, so this needs to page
    through them server-side rather than dumping everything at once.
    """
    query = db.query(StoreGRN)
    if status:
        query = query.filter(StoreGRN.status == status)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (StoreGRN.barcode.ilike(like)) | (StoreGRN.name.ilike(like)) | (StoreGRN.grn_id.ilike(like)) | (StoreGRN.store_name.ilike(like))
        )
    rows = query.order_by(StoreGRN.id.desc()).offset(offset).limit(limit).all()
    data = [{
        "id": r.id, "GRNID": r.grn_id, "Date": r.date, "StoreID": r.store_id, "StoreName": r.store_name,
        "Barcode": r.barcode, "Name": r.name, "QtyIssued": r.qty_issued, "QtyReceived": r.qty_received,
        "Status": r.status, "Notes": r.notes or "",
    } for r in rows]
    return {"ok": True, "status": "ok", "data": data}


@router.get("/store-grns/count")
def count_store_grns(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(_admin)],
    status: Optional[str] = None,
    q: Optional[str] = None,
):
    query = db.query(StoreGRN)
    if status:
        query = query.filter(StoreGRN.status == status)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (StoreGRN.barcode.ilike(like)) | (StoreGRN.name.ilike(like)) | (StoreGRN.grn_id.ilike(like)) | (StoreGRN.store_name.ilike(like))
        )
    return {"ok": True, "count": query.count()}


@router.get("/transfers")
def list_transfers(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)], limit: int = 200):
    rows = db.query(Transfer).order_by(Transfer.id.desc()).limit(limit).all()
    data = [{
        "RefID": r.ref_id, "Date": r.date, "FromStoreID": r.from_store_id, "FromStore": r.from_store,
        "ToStoreID": r.to_store_id, "ToStore": r.to_store, "Barcode": r.barcode, "Name": r.name,
        "Qty": r.qty, "Notes": r.notes or "", "Status": r.status,
    } for r in rows]
    return {"ok": True, "status": "ok", "data": data}


@router.get("/inventory-all")
def inventory_all(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(_admin)],
    q: Optional[str] = None,
    limit: Optional[int] = None,
    offset: int = 0,
):
    """All-store inventory grid, paginated + searchable (same pattern as
    Product Master). Old version ran a query per (product x store) pair —
    for 6,687 products x 3 stores that's 20,000+ queries. Now: one query
    for the page of products, one for stores, one for ALL inventory rows,
    one for ALL warehouse rows — 4 total, regardless of catalog size.
    """
    query = db.query(Product).filter(Product.active.is_(True))
    if q:
        like = f"%{q}%"
        query = query.filter((Product.name.ilike(like)) | (Product.barcode.ilike(like)))
    query = query.order_by(Product.name)
    if limit is not None:
        query = query.offset(offset).limit(limit)
    products = query.all()
    stores = db.query(Store).filter(Store.store_id != "HO", Store.active.is_(True)).all()

    inv_by_key: dict[tuple, int] = {
        (barcode, store_id): int(on_hand or 0)
        for barcode, store_id, on_hand in db.query(Inventory.barcode, Inventory.store_id, Inventory.on_hand).all()
    }
    ho_by_barcode: dict[str, int] = {
        barcode: int(on_hand or 0)
        for barcode, on_hand in db.query(HOWarehouse.barcode, HOWarehouse.on_hand).all()
    }

    rows = []
    for p in products:
        store_cols = {}
        total = 0
        for s in stores:
            # No Inventory row = this store has never received this
            # product, so its stock here is 0 — NOT Product.opening
            # (that's HO Warehouse's starting stock, not a per-store one;
            # this was the same phantom-stock bug fixed elsewhere, missed
            # here originally).
            oh = inv_by_key.get((p.barcode, s.store_id), 0)
            store_cols[s.store_id] = oh
            total += oh
        ho = ho_by_barcode.get(p.barcode, 0)
        rows.append({"barcode": p.barcode, "name": p.name, "cost": p.cost or 0, "retail": p.retail or 0, "ho": ho, "stores": store_cols, "total": total + ho})
    return {"ok": True, "status": "ok", "stores": [{"store_id": s.store_id, "name": s.name} for s in stores], "data": rows}


@router.get("/inventory-all/count")
def inventory_all_count(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)], q: Optional[str] = None):
    query = db.query(Product).filter(Product.active.is_(True))
    if q:
        like = f"%{q}%"
        query = query.filter((Product.name.ilike(like)) | (Product.barcode.ilike(like)))
    return {"ok": True, "count": query.count()}


GRN_CHUNK_SIZE = 500


def _apply_grn_line(db: Session, grn_id: str, date: str, body: "SGRNIn", line, existing_wh: dict, existing_products: dict, seen_new_barcodes: set) -> float:
    """Apply one Supplier GRN line to the session (no commit). Returns the
    line's total cost. Raises on failure — caller decides how to handle it.
    """
    tc = (line.qty or 0) * (line.cost or 0)
    db.add(SupplierGRN(
        grn_id=grn_id, date=date, supplier=body.supplier or "", invoice_no=body.invoiceNo or "",
        barcode=line.barcode, name=line.name or "", qty=line.qty or 0, unit_cost=line.cost or 0,
        total_cost=tc, notes=body.notes or "",
    ))
    wh = existing_wh.get(line.barcode)
    if wh:
        wh.supplier_in = (wh.supplier_in or 0) + int(line.qty or 0)
        wh.recalc()
        wh.updated_at = datetime.utcnow()
        if line.name:
            wh.name = line.name
    else:
        wh = HOWarehouse(barcode=line.barcode, name=line.name or "", supplier_in=int(line.qty or 0), store_out=0)
        wh.recalc()
        db.add(wh)
        existing_wh[line.barcode] = wh
    prod = existing_products.get(line.barcode)
    if not prod and line.barcode not in seen_new_barcodes:
        prod = Product(barcode=line.barcode, name=line.name or line.barcode, cost=line.cost or 0, retail=0, active=True)
        db.add(prod)
        existing_products[line.barcode] = prod
        seen_new_barcodes.add(line.barcode)
    elif prod and line.cost and (not prod.cost or prod.cost == 0):
        prod.cost = line.cost
    return tc


@router.post("/supplier-grn")
def supplier_grn(body: SGRNIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Save a Supplier GRN, processed in memory-bounded chunks, with a
    per-line pass/fail result so the caller knows exactly which barcode (if
    any) failed and why — not just an overall count.

    Fast path: each chunk of GRN_CHUNK_SIZE (500) lines is applied and
    committed together (one round trip), then `expunge_all()` frees that
    chunk's objects before the next one — this is what keeps memory bounded
    and thousands of lines fast.

    If a chunk's commit fails (bad barcode, constraint violation, etc.),
    that chunk — and only that chunk, max 500 lines — is retried one line
    at a time so we can report exactly which line(s) failed without paying
    the per-line round-trip cost on the normal, all-good path.
    """
    grn_id = body.grnId or f"SGRN-{int(time.time())}"
    date = body.date or today_str()
    lines = [l for l in body.lines if l.barcode and l.qty]

    count = 0
    total_cost = 0.0
    results: list[dict] = []

    for i in range(0, len(lines), GRN_CHUNK_SIZE):
        chunk = lines[i:i + GRN_CHUNK_SIZE]
        chunk_barcodes = list({l.barcode for l in chunk})
        existing_products = {p.barcode: p for p in db.query(Product).filter(Product.barcode.in_(chunk_barcodes)).all()}
        existing_wh = {w.barcode: w for w in db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(chunk_barcodes)).all()}
        seen_new_barcodes = set()

        try:
            chunk_cost = 0.0
            for line in chunk:
                chunk_cost += _apply_grn_line(db, grn_id, date, body, line, existing_wh, existing_products, seen_new_barcodes)
            db.commit()
            total_cost += chunk_cost
            count += len(chunk)
            for line in chunk:
                results.append({"barcode": line.barcode, "name": line.name or "", "status": "saved", "reason": ""})
        except Exception:  # noqa: BLE001 — isolate the bad line(s) in this chunk only
            db.rollback()
            existing_products = {p.barcode: p for p in db.query(Product).filter(Product.barcode.in_(chunk_barcodes)).all()}
            existing_wh = {w.barcode: w for w in db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(chunk_barcodes)).all()}
            seen_new_barcodes = set()
            for line in chunk:
                try:
                    tc = _apply_grn_line(db, grn_id, date, body, line, existing_wh, existing_products, seen_new_barcodes)
                    db.commit()
                    total_cost += tc
                    count += 1
                    results.append({"barcode": line.barcode, "name": line.name or "", "status": "saved", "reason": ""})
                except Exception as line_err:  # noqa: BLE001
                    db.rollback()
                    results.append({"barcode": line.barcode, "name": line.name or "", "status": "failed", "reason": str(line_err)})
        db.expunge_all()  # release this chunk's objects so memory doesn't accumulate

    if body.supplier and total_cost > 0:
        sup = db.query(Supplier).filter(Supplier.name == body.supplier).first()
        if not sup:
            sid = f"SUP{int(time.time())}"
            sup = Supplier(supplier_id=sid, name=body.supplier, terms="Net 30")
            db.add(sup)
            db.flush()
        db.add(SupplierTxn(
            txn_id=f"STXN-{int(time.time()*1000)}", supplier_id=sup.supplier_id, supplier_name=sup.name,
            date=date, type="invoice", amount=total_cost, reference=body.invoiceNo or grn_id,
            notes=f"Auto from supplier GRN {grn_id}",
        ))
        db.commit()

    failed = sum(1 for r in results if r["status"] == "failed")
    return {"ok": True, "status": "ok", "count": count, "grnId": grn_id, "results": results, "errors": [f"{r['barcode']}: {r['reason']}" for r in results if r["status"] == "failed"]}


@router.delete("/supplier-grn/{grn_id}")
def delete_supplier_grn(grn_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Undo a Supplier GRN: reverses its effect on HO Warehouse stock, then
    deletes its line rows and the auto-created supplier ledger entry.

    This is the safe way to fix a mistake in a saved GRN — rather than
    editing warehouse numbers in place (where a small bug could silently
    corrupt stock), delete the wrong GRN (which correctly reverses what it
    added) and re-upload the corrected file.

    Processed in memory-bounded chunks — a GRN from a big bulk upload can
    have thousands of lines, and deleting them all in one transaction is
    what caused deletes to hang/time out before.
    """
    total = db.query(SupplierGRN).filter(SupplierGRN.grn_id == grn_id).count()
    if total == 0:
        raise HTTPException(status_code=404, detail=f"No GRN found with ID {grn_id}")

    deleted = 0
    while True:
        chunk = db.query(SupplierGRN).filter(SupplierGRN.grn_id == grn_id).limit(GRN_CHUNK_SIZE).all()
        if not chunk:
            break
        barcodes = list({r.barcode for r in chunk})
        wh_by_barcode = {w.barcode: w for w in db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(barcodes)).all()}
        for r in chunk:
            wh = wh_by_barcode.get(r.barcode)
            if wh:
                wh.supplier_in = max(0, (wh.supplier_in or 0) - int(r.qty or 0))
                wh.recalc()
                wh.updated_at = datetime.utcnow()
            db.delete(r)
            deleted += 1
        db.commit()
        db.expunge_all()

    # Remove the auto-created supplier ledger entry for this GRN, if any.
    db.query(SupplierTxn).filter(SupplierTxn.notes == f"Auto from supplier GRN {grn_id}").delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "status": "ok", "deleted": deleted, "grnId": grn_id}


@router.delete("/supplier-grn-line/{line_id}")
def delete_supplier_grn_line(line_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Delete ONE Supplier GRN line (not the whole GRN it belongs to) and
    reverse just that line's effect on HO Warehouse stock. This is what
    fixes a single bad row (e.g. a stray 'Grand Total' row from a pivot
    table export) without touching the thousands of correct lines that
    share the same GRN ID from one bulk upload.
    """
    row = db.query(SupplierGRN).filter(SupplierGRN.id == line_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="GRN line not found")
    wh = db.query(HOWarehouse).filter(HOWarehouse.barcode == row.barcode).first()
    if wh:
        wh.supplier_in = max(0, (wh.supplier_in or 0) - int(row.qty or 0))
        wh.recalc()
        wh.updated_at = datetime.utcnow()
    db.delete(row)
    db.commit()
    return {"ok": True, "status": "ok", "deleted": 1}


@router.post("/supplier-grn-lines/bulk-delete")
def bulk_delete_supplier_grn_lines(line_ids: list[int], db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Delete many Supplier GRN lines at once (e.g. from 'Select All
    Matching' in the History table), reversing each one's HO Warehouse
    effect. Processed in memory-bounded chunks like the other bulk
    operations, so this stays safe even for thousands of ids.
    """
    deleted = 0
    for i in range(0, len(line_ids), GRN_CHUNK_SIZE):
        chunk_ids = line_ids[i:i + GRN_CHUNK_SIZE]
        rows = db.query(SupplierGRN).filter(SupplierGRN.id.in_(chunk_ids)).all()
        if not rows:
            continue
        barcodes = list({r.barcode for r in rows})
        wh_by_barcode = {w.barcode: w for w in db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(barcodes)).all()}
        for r in rows:
            wh = wh_by_barcode.get(r.barcode)
            if wh:
                wh.supplier_in = max(0, (wh.supplier_in or 0) - int(r.qty or 0))
                wh.recalc()
                wh.updated_at = datetime.utcnow()
            db.delete(r)
            deleted += 1
        db.commit()
        db.expunge_all()
    return {"ok": True, "status": "ok", "deleted": deleted}


@router.delete("/supplier-grn-lines/all")
def delete_all_supplier_grn_lines(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Delete ALL Supplier GRN lines and reset supplier_in to 0 on every
    HO Warehouse row (store_out / stock already sent to stores is left
    untouched). Use this to wipe a bad bulk upload and start fresh.
    """
    n = db.query(SupplierGRN).count()
    db.query(SupplierGRN).delete(synchronize_session=False)
    db.query(SupplierTxn).filter(SupplierTxn.notes.ilike("Auto from supplier GRN%")).delete(synchronize_session=False)
    for wh in db.query(HOWarehouse).all():
        wh.supplier_in = 0
        wh.recalc()
        wh.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": "ok", "deleted": n}


@router.post("/reset-all-product-stock-data")
def reset_all_product_stock_data(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin"))]):
    """FULL RESET of everything product/stock/GRN related, for starting
    completely fresh after test data got messy.

    Deletes: Products (Product Master), HO Warehouse stock, Supplier GRN
    history, Store GRN history, every store's Inventory, Stock Transfers
    between stores, and Supplier ledger entries (Supplier accounts are
    kept, only their transaction history is cleared since it was tied to
    the GRNs being wiped).

    Left completely untouched: Users & PINs, Stores, Banks, Capital
    entries, Balance Sheet / Cash Flow entries, Expenses, and past Sales /
    Returns / Exchanges / Claims (those are real sales history, not
    product/stock setup data).
    """
    counts = {
        "products": db.query(Product).count(),
        "ho_warehouse": db.query(HOWarehouse).count(),
        "supplier_grn": db.query(SupplierGRN).count(),
        "store_grn": db.query(StoreGRN).count(),
        "inventory": db.query(Inventory).count(),
        "transfers": db.query(Transfer).count(),
        "supplier_txns": db.query(SupplierTxn).count(),
    }
    db.query(SupplierGRN).delete(synchronize_session=False)
    db.query(StoreGRN).delete(synchronize_session=False)
    db.query(HOWarehouse).delete(synchronize_session=False)
    db.query(Inventory).delete(synchronize_session=False)
    db.query(Transfer).delete(synchronize_session=False)
    db.query(SupplierTxn).delete(synchronize_session=False)
    db.query(Product).delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "status": "ok", "deleted": counts}


@router.post("/store-grn")
def issue_store_grn(body: StGRNIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Issue stock to a store, processed in memory-bounded chunks (see the
    supplier-grn endpoint above for why), with per-line pass/fail results.
    """
    grn_id = body.grnId or f"GRN-{int(time.time())}"
    date = body.date or today_str()
    count = 0
    results: list[dict] = []
    lines = [l for l in body.lines if l.barcode and l.qty]

    for i in range(0, len(lines), GRN_CHUNK_SIZE):
        chunk = lines[i:i + GRN_CHUNK_SIZE]
        chunk_barcodes = list({l.barcode for l in chunk})
        existing_wh = {
            w.barcode: w for w in db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(chunk_barcodes)).all()
        }

        for line in chunk:
            wh = existing_wh.get(line.barcode)
            ho_stock = int(wh.on_hand) if wh else 0
            if wh is not None and ho_stock < (line.qty or 0):
                results.append({"barcode": line.barcode, "name": line.name or "", "status": "failed", "reason": f"insufficient HO stock ({ho_stock} available, {line.qty} requested)"})
                continue
            db.add(StoreGRN(
                grn_id=grn_id, date=date, store_id=body.storeId, store_name=body.storeName,
                barcode=line.barcode, name=line.name or "", qty_issued=line.qty or 0, qty_received=0,
                status="pending", notes=body.notes or "",
            ))
            if wh:
                wh.store_out = (wh.store_out or 0) + int(line.qty or 0)
                wh.recalc()
                wh.updated_at = datetime.utcnow()
                if line.name:
                    wh.name = line.name
            else:
                wh = HOWarehouse(barcode=line.barcode, name=line.name or "", supplier_in=0, store_out=int(line.qty or 0))
                wh.recalc()
                db.add(wh)
                existing_wh[line.barcode] = wh
            count += 1
            results.append({"barcode": line.barcode, "name": line.name or "", "status": "saved", "reason": ""})

        db.commit()
        db.expunge_all()  # release this chunk's objects so memory doesn't accumulate

    errors = [f"{r['barcode']}: {r['reason']}" for r in results if r["status"] == "failed"]
    return {"ok": True, "status": "ok", "count": count, "grnId": grn_id, "results": results, "errors": errors}


@router.delete("/store-grn/{grn_id}")
def delete_store_grn(grn_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    """Undo a Send-to-Store GRN that hasn't been received yet: reverses the
    HO Warehouse stock it reserved and deletes its lines. Only works while
    status is still 'pending' — once a store has received stock, deleting
    it here would silently disagree with what physically happened, so that
    case is rejected instead.

    Processed in memory-bounded chunks (same pattern as the other bulk GRN
    operations) — a GRN from a big "send whole catalog to store" upload
    can have thousands of lines, and deleting them all in one transaction
    is exactly what hung/timed out before.
    """
    total = db.query(StoreGRN).filter(StoreGRN.grn_id == grn_id).count()
    if total == 0:
        raise HTTPException(status_code=404, detail=f"No GRN found with ID {grn_id}")
    bad_status = db.query(StoreGRN).filter(StoreGRN.grn_id == grn_id, StoreGRN.status != "pending").first()
    if bad_status:
        raise HTTPException(status_code=400, detail="This GRN has already been received by the store and can't be deleted — use a Stock Transfer to correct it instead")

    deleted = 0
    while True:
        chunk = db.query(StoreGRN).filter(StoreGRN.grn_id == grn_id).limit(GRN_CHUNK_SIZE).all()
        if not chunk:
            break
        barcodes = list({r.barcode for r in chunk})
        wh_by_barcode = {w.barcode: w for w in db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(barcodes)).all()}
        for r in chunk:
            wh = wh_by_barcode.get(r.barcode)
            if wh:
                wh.store_out = max(0, (wh.store_out or 0) - int(r.qty_issued or 0))
                wh.recalc()
                wh.updated_at = datetime.utcnow()
            db.delete(r)
            deleted += 1
        db.commit()
        db.expunge_all()
    return {"ok": True, "status": "ok", "deleted": deleted, "grnId": grn_id}


@router.post("/transfer")
def stock_transfer(body: TransferIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    if body.fromStoreId == body.toStoreId:
        raise HTTPException(400, "From and To cannot be the same")
    date = body.date or today_str()
    count = 0
    for line in body.lines:
        if not line.barcode or not line.qty:
            continue
        ref = f"TR-{int(time.time()*1000)}-{count}"
        update_inv(db, line.barcode, body.fromStore, body.fromStoreId, line.name or "", "claim", line.qty)
        update_inv(db, line.barcode, body.toStore, body.toStoreId, line.name or "", "grn", line.qty)
        db.add(Transfer(
            ref_id=ref, date=date, from_store_id=body.fromStoreId, from_store=body.fromStore,
            to_store_id=body.toStoreId, to_store=body.toStore, barcode=line.barcode, name=line.name or "",
            qty=line.qty, notes=line.notes or "", status="done",
        ))
        count += 1
    db.commit()
    return {"ok": True, "status": "ok", "count": count}


@router.get("/pl")
def profit_loss(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)],
    date_from: Optional[str] = Query(None, alias="from"), date_to: Optional[str] = Query(None, alias="to"),
    store: Optional[str] = "all",
):
    sq, eq, rq = db.query(Sale), db.query(Expense), db.query(Return)
    if store and store not in ("all", "HO", ""):
        sq = sq.filter((Sale.store_id == store) | (Sale.store == store))
        eq = eq.filter((Expense.store_id == store) | (Expense.store == store))
        rq = rq.filter((Return.store_id == store) | (Return.store == store))
    if date_from:
        sq, eq, rq = sq.filter(Sale.date >= date_from), eq.filter(Expense.date >= date_from), rq.filter(Return.date >= date_from)
    if date_to:
        sq, eq, rq = sq.filter(Sale.date <= date_to), eq.filter(Expense.date <= date_to), rq.filter(Return.date <= date_to)
    sales, expenses, rets = sq.all(), eq.all(), rq.all()
    revenue = sum(s.total or 0 for s in sales)
    returns = sum(r.amount or 0 for r in rets)
    net_revenue = revenue - returns
    cogs = 0.0
    for s in sales:
        try:
            items = json.loads(s.items_json or "[]")
        except Exception:
            items = []
        for i in items:
            cost = float(i.get("cost") or 0)
            qty = int(i.get("qty") or 0)
            if not cost and i.get("barcode"):
                p = db.query(Product).filter(Product.barcode == str(i.get("barcode"))).first()
                cost = float(p.cost or 0) if p else 0
            cogs += cost * qty
    total_expenses = sum(e.amount or 0 for e in expenses)
    gross = net_revenue - cogs
    ebitda = gross - total_expenses
    gm = (gross / net_revenue) if net_revenue else 0
    return {
        "ok": True, "status": "ok", "revenue": revenue, "returns": returns, "netRevenue": net_revenue,
        "cogs": cogs, "grossProfit": gross, "grossMargin": gm, "totalExpenses": total_expenses, "ebitda": ebitda,
    }


@router.get("/suppliers")
def list_suppliers(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    rows = db.query(Supplier).filter(Supplier.active.is_(True)).order_by(Supplier.name).all()
    txns = db.query(SupplierTxn).all()
    data = []
    for s in rows:
        st = [t for t in txns if t.supplier_id == s.supplier_id]
        invoiced = sum(t.amount for t in st if t.type == "invoice")
        paid = sum(t.amount for t in st if t.type == "payment")
        credits = sum(t.amount for t in st if t.type == "credit")
        data.append({
            "id": s.supplier_id, "name": s.name, "contact": s.contact or "", "limit": s.credit_limit or 0,
            "terms": s.terms or "", "invoiced": invoiced, "paid": paid, "credits": credits,
            "balance": invoiced - paid - credits,
        })
    return {"ok": True, "data": data}


@router.post("/suppliers")
def save_supplier(body: SupplierIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    row = db.query(Supplier).filter(Supplier.name == body.name).first()
    if body.supplierId:
        row = db.query(Supplier).filter(Supplier.supplier_id == body.supplierId).first() or row
    if row:
        row.name, row.contact, row.credit_limit, row.terms = body.name, body.contact, body.limit, body.terms
    else:
        sid = body.supplierId or f"SUP{int(time.time())}"
        row = Supplier(supplier_id=sid, name=body.name, contact=body.contact, credit_limit=body.limit, terms=body.terms)
        db.add(row)
    db.commit()
    return {"ok": True, "status": "ok", "id": row.supplier_id}


@router.get("/supplier-txns")
def list_supplier_txns(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)], limit: int = 100):
    rows = db.query(SupplierTxn).order_by(SupplierTxn.id.desc()).limit(limit).all()
    return {"ok": True, "data": [{
        "id": r.txn_id, "supplierId": r.supplier_id, "supplierName": r.supplier_name, "date": r.date,
        "type": r.type, "amount": r.amount, "ref": r.reference,
    } for r in rows]}


@router.post("/supplier-txns")
def save_supplier_txn(body: SupplierTxnIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    sup = db.query(Supplier).filter(Supplier.supplier_id == body.supplierId).first()
    if not sup:
        raise HTTPException(404, "Supplier not found")
    tid = f"STXN-{int(time.time()*1000)}"
    db.add(SupplierTxn(
        txn_id=tid, supplier_id=body.supplierId, supplier_name=sup.name, date=body.date or today_str(),
        type=body.type, amount=body.amount, reference=body.ref or "", notes=body.notes or "",
    ))
    db.commit()
    return {"ok": True, "status": "ok", "id": tid}


@router.get("/capital")
def list_capital(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    rows = db.query(CapitalEntry).order_by(CapitalEntry.id.desc()).all()
    return {"ok": True, "data": [{"id": r.entry_id, "date": r.date, "type": r.type, "amount": r.amount, "desc": r.description} for r in rows]}


@router.post("/capital")
def save_capital(body: CapitalIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    eid = f"CAP-{int(time.time()*1000)}"
    db.add(CapitalEntry(entry_id=eid, date=body.date or today_str(), type=body.type, amount=body.amount, description=body.description or ""))
    db.commit()
    return {"ok": True, "status": "ok", "id": eid}


@router.get("/bs-entries")
def list_bs(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    rows = db.query(BSEntry).order_by(BSEntry.id.desc()).all()
    return {"ok": True, "data": [{"id": r.entry_id, "date": r.date, "type": r.type, "desc": r.description, "amount": r.amount} for r in rows]}


@router.post("/bs-entries")
def save_bs(body: BSIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    eid = f"BS-{int(time.time()*1000)}"
    db.add(BSEntry(entry_id=eid, date=body.date or today_str(), type=body.type, description=body.description, amount=body.amount))
    db.commit()
    return {"ok": True, "status": "ok", "id": eid}


@router.get("/cf-items")
def list_cf(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    rows = db.query(CFItem).order_by(CFItem.id.desc()).all()
    return {"ok": True, "data": [{"id": r.item_id, "section": r.section, "label": r.label, "value": r.value, "date": r.date} for r in rows]}


@router.post("/cf-items")
def save_cf(body: CFIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    iid = f"CF-{int(time.time()*1000)}"
    db.add(CFItem(item_id=iid, section=body.section, label=body.label, value=body.value, date=body.date or today_str()))
    db.commit()
    return {"ok": True, "status": "ok", "id": iid}


@router.get("/balance-sheet")
def balance_sheet(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)]):
    sales, rets, exps = db.query(Sale).all(), db.query(Return).all(), db.query(Expense).all()
    revenue = sum(s.total or 0 for s in sales)
    returns = sum(r.amount or 0 for r in rets)
    net_rev = revenue - returns
    total_exp = sum(e.amount or 0 for e in exps)
    net_profit = net_rev - total_exp
    stock_value = 0.0
    for inv in db.query(Inventory).all():
        p = db.query(Product).filter(Product.barcode == inv.barcode).first()
        stock_value += (inv.on_hand or 0) * float(p.cost or 0 if p else 0)
    for wh in db.query(HOWarehouse).all():
        p = db.query(Product).filter(Product.barcode == wh.barcode).first()
        stock_value += (wh.on_hand or 0) * float(p.cost or 0 if p else 0)
    cash_sales = sum(s.total or 0 for s in sales if (s.payment or "") == "Cash")
    cash_est = max(cash_sales - total_exp, 0)
    bs_rows = db.query(BSEntry).all()
    current_assets = [
        {"label": "Cash & Bank (estimated)", "value": cash_est, "auto": True},
        {"label": "Inventory / Stock Value", "value": stock_value, "auto": True},
    ] + [{"label": r.description, "value": r.amount, "auto": False} for r in bs_rows if r.type == "asset-current"]
    fixed_assets = [{"label": r.description, "value": r.amount, "auto": False} for r in bs_rows if r.type == "asset-fixed"]
    sup_pay = 0.0
    for s in db.query(Supplier).all():
        st = db.query(SupplierTxn).filter(SupplierTxn.supplier_id == s.supplier_id).all()
        bal = sum(t.amount for t in st if t.type == "invoice") - sum(t.amount for t in st if t.type == "payment") - sum(t.amount for t in st if t.type == "credit")
        if bal > 0:
            sup_pay += bal
    liabilities = [{"label": "Supplier Payables", "value": sup_pay, "auto": True}] + [
        {"label": r.description, "value": r.amount, "auto": False} for r in bs_rows if r.type == "liability"
    ]
    caps = db.query(CapitalEntry).all()
    invested = sum(c.amount for c in caps if c.type in ("investment", "loan"))
    withdrawn = sum(c.amount for c in caps if c.type in ("withdrawal", "loan-repay"))
    equity = [
        {"label": "Owner Capital", "value": invested - withdrawn, "auto": True},
        {"label": "Retained Earnings", "value": net_profit, "auto": True},
    ] + [{"label": r.description, "value": r.amount, "auto": False} for r in bs_rows if r.type == "equity"]
    tca, tfa = sum(i["value"] for i in current_assets), sum(i["value"] for i in fixed_assets)
    tl, te = sum(i["value"] for i in liabilities), sum(i["value"] for i in equity)
    return {
        "ok": True, "status": "ok", "currentAssets": current_assets, "fixedAssets": fixed_assets,
        "liabilities": liabilities, "equity": equity, "totalCurrentAssets": tca, "totalFixedAssets": tfa,
        "totalAssets": tca + tfa, "totalLiabilities": tl, "totalEquity": te, "totalLiabEquity": tl + te,
        "netProfit": net_profit, "stockValue": stock_value,
    }


@router.get("/cashflow")
def cashflow(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_admin)],
    date_from: Optional[str] = Query(None, alias="from"), date_to: Optional[str] = Query(None, alias="to"),
    opening: float = 0,
):
    sq, eq = db.query(Sale), db.query(Expense)
    if date_from:
        sq, eq = sq.filter(Sale.date >= date_from), eq.filter(Expense.date >= date_from)
    if date_to:
        sq, eq = sq.filter(Sale.date <= date_to), eq.filter(Expense.date <= date_to)
    sales, expenses = sq.all(), eq.all()
    cash_in = sum(s.total or 0 for s in sales if (s.payment or "") == "Cash")
    bank_in = sum(s.total or 0 for s in sales if (s.payment or "") != "Cash")
    total_exp = sum(e.amount or 0 for e in expenses)
    tq = db.query(SupplierTxn).filter(SupplierTxn.type == "payment")
    if date_from:
        tq = tq.filter(SupplierTxn.date >= date_from)
    if date_to:
        tq = tq.filter(SupplierTxn.date <= date_to)
    sup_paid = sum(t.amount or 0 for t in tq.all())
    operating = [
        {"label": "Cash Sales Received", "value": cash_in},
        {"label": "Bank/Digital Payments Received", "value": bank_in},
        {"label": "Operating Expenses Paid", "value": -total_exp},
        {"label": "Supplier Payments", "value": -sup_paid},
    ]
    op_total = sum(i["value"] for i in operating)
    cf = db.query(CFItem).all()
    investing = [{"label": c.label, "value": c.value} for c in cf if c.section == "investing"]
    financing = [{"label": c.label, "value": c.value} for c in cf if c.section == "financing"]
    inv_total = sum(i["value"] for i in investing)
    fin_total = sum(i["value"] for i in financing)
    net = op_total + inv_total + fin_total
    return {
        "ok": True, "status": "ok", "operating": operating, "operatingTotal": op_total,
        "investing": investing, "investingTotal": inv_total, "financing": financing, "financingTotal": fin_total,
        "netCashFlow": net, "opening": opening, "closing": opening + net,
    }
