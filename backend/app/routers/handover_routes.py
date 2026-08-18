"""Day-end cash handover: a store generates a handover form from that
day's actual sales, submits it, and an accountant at HO (or the store)
marks it received after counting the physical cash — recording any
variance between what was expected and what was actually counted.
"""
from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import CashHandover, Return, Sale
from ..utils import today_str

router = APIRouter(prefix="/api/handover", tags=["handover"])


class HandoverSubmitIn(BaseModel):
    date: Optional[str] = None  # defaults to today


class HandoverReceiveIn(BaseModel):
    handoverId: str
    countedCash: float
    notes: Optional[str] = ""


def _row_to_dict(r: CashHandover) -> dict:
    return {
        "handoverId": r.handover_id,
        "date": r.date,
        "storeId": r.store_id,
        "storeName": r.store_name,
        "invoiceCount": r.invoice_count,
        "unitsSold": r.units_sold,
        "totalSales": r.total_sales,
        "cashSales": r.cash_sales,
        "bankSales": json.loads(r.bank_sales_json or "[]"),
        "returnsTotal": r.returns_total,
        "submittedBy": r.submitted_by,
        "submittedAt": r.submitted_at.strftime("%Y-%m-%d %H:%M") if r.submitted_at else "",
        "status": r.status,
        "countedCash": r.counted_cash,
        "variance": r.variance,
        "varianceNotes": r.variance_notes,
        "receivedBy": r.received_by,
        "receivedAt": r.received_at.strftime("%Y-%m-%d %H:%M") if r.received_at else "",
    }


@router.post("/submit")
def submit_handover(
    body: HandoverSubmitIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    """Generate and submit a day-end handover for the cashier's store.
    Totals are computed server-side from actual Sale/Return rows — never
    trusted from the client — so the form always matches what's really in
    the system.
    """
    if not user.store_id or user.store_id == "HO":
        raise HTTPException(status_code=400, detail="Only a store login can submit a handover")
    date = body.date or today_str()

    existing = db.query(CashHandover).filter(CashHandover.store_id == user.store_id, CashHandover.date == date).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"A handover for {date} was already submitted ({existing.handover_id}, status: {existing.status})")

    sales = db.query(Sale).filter(Sale.store_id == user.store_id, Sale.date == date).all()
    invoice_count = len(sales)
    units_sold = 0
    total_sales = 0.0
    cash_sales = 0.0
    bank_totals: dict[str, float] = {}
    for s in sales:
        total_sales += s.total or 0
        try:
            items = json.loads(s.items_json or "[]")
        except Exception:
            items = []
        units_sold += sum(int(it.get("qty") or 0) for it in items)
        pay = (s.payment or "Cash").strip()
        if pay.lower() == "cash":
            cash_sales += s.total or 0
        else:
            bank_totals[pay] = bank_totals.get(pay, 0.0) + (s.total or 0)

    returns = db.query(Return).filter(Return.store_id == user.store_id, Return.date == date).all()
    returns_total = sum(r.amount or 0 for r in returns)

    handover_id = f"HO-{date}-{user.store_id}-{int(time.time())}"
    row = CashHandover(
        handover_id=handover_id,
        date=date,
        store_id=user.store_id,
        store_name=user.store_name,
        invoice_count=invoice_count,
        units_sold=units_sold,
        total_sales=total_sales,
        cash_sales=cash_sales,
        bank_sales_json=json.dumps([{"bank": k, "amount": v} for k, v in bank_totals.items()]),
        returns_total=returns_total,
        submitted_by=user.name,
        submitted_at=datetime.utcnow(),
        status="pending",
    )
    db.add(row)
    db.commit()
    return {"ok": True, "status": "ok", "handover": _row_to_dict(row)}


@router.get("/mine")
def my_handovers(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: int = 30,
):
    """This store's own handover history — lets a cashier/manager see
    what they've submitted and whether it's been received yet."""
    if not user.store_id or user.store_id == "HO":
        return {"ok": True, "data": []}
    rows = (
        db.query(CashHandover)
        .filter(CashHandover.store_id == user.store_id)
        .order_by(CashHandover.id.desc())
        .limit(limit)
        .all()
    )
    return {"ok": True, "data": [_row_to_dict(r) for r in rows]}


@router.get("/list")
def list_handovers(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    status: Optional[str] = None,
    store_id: Optional[str] = None,
):
    """All stores' handovers, for HO/accountant review."""
    q = db.query(CashHandover)
    if status:
        q = q.filter(CashHandover.status == status)
    if store_id:
        q = q.filter(CashHandover.store_id == store_id)
    rows = q.order_by(CashHandover.id.desc()).all()
    return {"ok": True, "data": [_row_to_dict(r) for r in rows]}


@router.post("/receive")
def receive_handover(
    body: HandoverReceiveIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    """Accountant confirms the physical cash count against the expected
    cash sales total, recording any variance either way."""
    row = db.query(CashHandover).filter(CashHandover.handover_id == body.handoverId).first()
    if not row:
        raise HTTPException(status_code=404, detail="Handover not found")
    if row.status == "received":
        raise HTTPException(status_code=400, detail="Already received")

    row.counted_cash = body.countedCash
    row.variance = round(body.countedCash - row.cash_sales, 2)
    row.variance_notes = body.notes or ""
    row.status = "received"
    row.received_by = user.name
    row.received_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": "ok", "handover": _row_to_dict(row)}
