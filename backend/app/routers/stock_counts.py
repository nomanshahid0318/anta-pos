"""Stock Adjustments / Physical Count endpoints."""
from __future__ import annotations

import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import Inventory, Product
from ..models_stockcount import StockCount, StockCountLine
from ..services.audit import log_audit
from ..services.inventory import get_or_create_inv
from ..utils import today_str

router = APIRouter(prefix="/api/stock-counts", tags=["stock-counts"])


class StartCountIn(BaseModel):
    storeId: str
    storeName: str = ""
    barcodes: Optional[list[str]] = None  # omit = full count of everything with stock
    notes: str = ""


class CountLineUpdate(BaseModel):
    barcode: str
    physicalQty: int
    reason: str = ""


class SubmitCountIn(BaseModel):
    lines: list[CountLineUpdate] = Field(default_factory=list)


class QuickAdjustIn(BaseModel):
    barcode: str
    storeId: str
    storeName: str = ""
    name: str = ""
    newQty: int
    reason: str


def _line_out(l: StockCountLine) -> dict:
    variance = None if l.physical_qty is None else (l.physical_qty - l.system_qty)
    return {
        "barcode": l.barcode, "name": l.name, "systemQty": l.system_qty,
        "physicalQty": l.physical_qty, "variance": variance, "reason": l.reason,
    }


@router.post("/start")
def start_count(body: StartCountIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))]):
    cid = f"CNT-{int(time.time() * 1000)}"
    row = StockCount(count_id=cid, store_id=body.storeId, store_name=body.storeName or body.storeId, date=today_str(), counted_by=user.name, notes=body.notes or "")
    db.add(row)
    q = db.query(Inventory).filter(Inventory.store_id == body.storeId)
    if body.barcodes:
        q = q.filter(Inventory.barcode.in_(body.barcodes))
    inv_rows = q.all()
    for inv in inv_rows:
        db.add(StockCountLine(count_id=cid, barcode=inv.barcode, name=inv.name, system_qty=inv.on_hand or 0))
    db.commit()
    return {"ok": True, "status": "ok", "id": cid, "lineCount": len(inv_rows)}


@router.get("/{count_id}")
def get_count(count_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))]):
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    lines = db.query(StockCountLine).filter(StockCountLine.count_id == count_id).order_by(StockCountLine.id.asc()).all()
    return {
        "ok": True, "id": row.count_id, "storeId": row.store_id, "storeName": row.store_name,
        "date": row.date, "status": row.status, "countedBy": row.counted_by, "approvedBy": row.approved_by,
        "notes": row.notes, "lines": [_line_out(l) for l in lines],
    }


@router.get("")
def list_counts(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))], status: Optional[str] = None, limit: int = 50):
    q = db.query(StockCount)
    if status:
        q = q.filter(StockCount.status == status)
    rows = q.order_by(StockCount.id.desc()).limit(limit).all()
    out = []
    for r in rows:
        lines = db.query(StockCountLine).filter(StockCountLine.count_id == r.count_id).all()
        counted_lines = [l for l in lines if l.physical_qty is not None]
        variance_lines = [l for l in counted_lines if l.physical_qty != l.system_qty]
        out.append({
            "id": r.count_id, "storeId": r.store_id, "storeName": r.store_name, "date": r.date,
            "status": r.status, "countedBy": r.counted_by, "approvedBy": r.approved_by,
            "totalLines": len(lines), "countedLines": len(counted_lines), "varianceLines": len(variance_lines),
        })
    return {"ok": True, "data": out}


class UploadCountLine(BaseModel):
    barcode: str
    qty: int = 1


class UploadCountIn(BaseModel):
    lines: list[UploadCountLine] = Field(default_factory=list)


@router.post("/{count_id}/upload")
def upload_count(
    count_id: str, body: UploadCountIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))],
):
    """Bulk-load a physical count from a scanned Excel/CSV file — the real
    workflow: staff scans every barcode on the shelf (a barcode scanner
    just types the number + Enter into Excel, so scanning the same item
    twice = two rows / a qty of 2), then this file gets uploaded here
    instead of anyone typing quantities by hand.

    Duplicate barcodes in the file are summed. A barcode that was never
    in the original system snapshot (something physically found that the
    system didn't expect at all) gets a new line with systemQty=0, so it
    still shows up as a positive variance rather than being silently
    dropped.
    """
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "draft":
        raise HTTPException(400, "This count is already approved and locked")
    scanned: dict[str, int] = {}
    for l in body.lines:
        if not l.barcode:
            continue
        scanned[l.barcode] = scanned.get(l.barcode, 0) + int(l.qty or 1)
    lines_by_barcode = {l.barcode: l for l in db.query(StockCountLine).filter(StockCountLine.count_id == count_id).all()}
    matched = 0
    new_items = 0
    for barcode, qty in scanned.items():
        line = lines_by_barcode.get(barcode)
        if line:
            line.physical_qty = qty
            matched += 1
        else:
            prod = db.query(Product).filter(Product.barcode == barcode).first()
            db.add(StockCountLine(count_id=count_id, barcode=barcode, name=(prod.name if prod else barcode), system_qty=0, physical_qty=qty))
            new_items += 1
    db.commit()
    return {"ok": True, "status": "ok", "matched": matched, "newItemsFound": new_items, "totalScanned": len(scanned)}


@router.put("/{count_id}/lines")
def update_count_lines(
    count_id: str, body: SubmitCountIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))],
):
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "draft":
        raise HTTPException(400, "This count is already approved and locked")
    lines_by_barcode = {l.barcode: l for l in db.query(StockCountLine).filter(StockCountLine.count_id == count_id).all()}
    updated = 0
    for u in body.lines:
        line = lines_by_barcode.get(u.barcode)
        if not line:
            continue
        line.physical_qty = u.physicalQty
        line.reason = u.reason or ""
        updated += 1
    db.commit()
    return {"ok": True, "status": "ok", "updated": updated}


@router.post("/{count_id}/approve")
def approve_count(
    count_id: str, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    """Manager/admin-only — this is the actual internal control: a
    warehouse/cashier can COUNT and enter physical quantities, but only a
    manager or admin can APPROVE the count, which is the moment the
    variance actually changes real inventory (and therefore Balance Sheet
    stock value). Lines without a physical count entered are skipped
    (treated as "not yet counted", not zero).
    """
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "draft":
        raise HTTPException(400, "Already approved")
    lines = db.query(StockCountLine).filter(StockCountLine.count_id == count_id).all()
    applied = 0
    for l in lines:
        if l.physical_qty is None:
            continue
        variance = l.physical_qty - l.system_qty
        if variance == 0:
            continue
        inv = get_or_create_inv(db, l.barcode, row.store_name, row.store_id, l.name)
        inv.adjustments = (inv.adjustments or 0) + variance
        inv.recalc()
        applied += 1
        log_audit(
            db, user, "update", "stock_adjustment", l.barcode,
            f"Stock count adjustment: {l.name} — system {l.system_qty}, counted {l.physical_qty} ({'+' if variance > 0 else ''}{variance})",
            old_value={"systemQty": l.system_qty}, new_value={"physicalQty": l.physical_qty, "variance": variance, "reason": l.reason},
        )
    row.status = "approved"
    row.approved_by = user.name
    from datetime import datetime
    row.approved_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": "ok", "linesAdjusted": applied}


@router.post("/quick-adjust")
def quick_adjust(
    body: QuickAdjustIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    """A single-item correction outside a full count — e.g. one damaged
    pair found on the shelf. Manager/admin only, reason required, and
    logged to the Audit Log just like a full count's approval.
    """
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required for any stock adjustment")
    inv = get_or_create_inv(db, body.barcode, body.storeName or body.storeId, body.storeId, body.name)
    old_qty = inv.on_hand or 0
    variance = body.newQty - old_qty
    if variance == 0:
        return {"ok": True, "status": "no_change"}
    inv.adjustments = (inv.adjustments or 0) + variance
    inv.recalc()
    log_audit(
        db, user, "update", "stock_adjustment", body.barcode,
        f"Quick adjustment: {body.name or body.barcode} — {old_qty} → {body.newQty} ({'+' if variance > 0 else ''}{variance}) — {body.reason}",
        old_value={"qty": old_qty}, new_value={"qty": body.newQty, "reason": body.reason},
    )
    db.commit()
    return {"ok": True, "status": "ok", "newQty": inv.on_hand}
