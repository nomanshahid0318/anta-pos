"""Cashier Shift / Register Management."""
from __future__ import annotations

import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import Return, Sale
from ..models_shifts import Shift, ShiftCashMovement
from ..utils import today_str

router = APIRouter(prefix="/api/shifts", tags=["shifts"])


class ShiftOpenIn(BaseModel):
    openingCash: float = 0.0


class ShiftCashMovementIn(BaseModel):
    type: str  # addition | withdrawal
    amount: float
    reason: str = ""


class ShiftCloseIn(BaseModel):
    countedCash: float
    notes: str = ""


def _shift_out(s: Shift) -> dict:
    return {
        "id": s.shift_id, "storeId": s.store_id, "storeName": s.store_name,
        "cashierId": s.cashier_id, "cashierName": s.cashier_name,
        "openedAt": s.opened_at.isoformat() if s.opened_at else "",
        "openingCash": s.opening_cash, "status": s.status,
        "closedAt": s.closed_at.isoformat() if s.closed_at else "",
        "cashSales": s.cash_sales, "cashRefunds": s.cash_refunds,
        "cashAdditions": s.cash_additions, "cashWithdrawals": s.cash_withdrawals,
        "expectedCash": s.expected_cash, "countedCash": s.counted_cash, "variance": s.variance,
        "notes": s.notes,
    }


@router.post("/open")
def open_shift(body: ShiftOpenIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(get_current_user)]):
    existing = db.query(Shift).filter(Shift.cashier_id == user.user_id, Shift.status == "open").first()
    if existing:
        return {"ok": True, "status": "already_open", "id": existing.shift_id, **_shift_out(existing)}
    sid = f"SHF-{int(time.time() * 1000)}"
    row = Shift(
        shift_id=sid, store_id=user.store_id, store_name=user.store_name,
        cashier_id=user.user_id, cashier_name=user.name, opening_cash=body.openingCash or 0.0,
    )
    db.add(row)
    db.commit()
    return {"ok": True, "status": "ok", "id": sid, **_shift_out(row)}


@router.get("/current")
def current_shift(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(get_current_user)]):
    row = db.query(Shift).filter(Shift.cashier_id == user.user_id, Shift.status == "open").first()
    if not row:
        return {"ok": True, "data": None}
    movements = db.query(ShiftCashMovement).filter(ShiftCashMovement.shift_id == row.shift_id).order_by(ShiftCashMovement.id.desc()).all()
    return {"ok": True, "data": {
        **_shift_out(row),
        "movements": [{"id": m.movement_id, "type": m.type, "amount": m.amount, "reason": m.reason, "recordedBy": m.recorded_by} for m in movements],
    }}


@router.post("/{shift_id}/cash-movement")
def add_cash_movement(
    shift_id: str, body: ShiftCashMovementIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    row = db.query(Shift).filter(Shift.shift_id == shift_id).first()
    if not row:
        raise HTTPException(404, "Shift not found")
    if row.status != "open":
        raise HTTPException(400, "Shift is already closed")
    if body.type not in ("addition", "withdrawal"):
        raise HTTPException(400, "type must be 'addition' or 'withdrawal'")
    if body.amount <= 0:
        raise HTTPException(400, "Amount must be greater than 0")
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required for any mid-shift cash movement")
    mid = f"SCM-{int(time.time() * 1000)}"
    db.add(ShiftCashMovement(
        movement_id=mid, shift_id=shift_id, type=body.type, amount=body.amount,
        reason=body.reason.strip(), recorded_by=user.name,
    ))
    if body.type == "addition":
        row.cash_additions = (row.cash_additions or 0) + body.amount
    else:
        row.cash_withdrawals = (row.cash_withdrawals or 0) + body.amount
    db.commit()
    return {"ok": True, "status": "ok", "id": mid}


@router.post("/{shift_id}/close")
def close_shift(
    shift_id: str, body: ShiftCloseIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    row = db.query(Shift).filter(Shift.shift_id == shift_id).first()
    if not row:
        raise HTTPException(404, "Shift not found")
    if row.status != "open":
        raise HTTPException(400, "Shift is already closed")
    cash_sales = sum(
        s.total or 0 for s in db.query(Sale).filter(Sale.shift_id == shift_id, Sale.type == "sale", Sale.payment == "Cash").all()
    )
    cash_refunds = sum(
        r.amount or 0 for r in db.query(Return).filter(Return.shift_id == shift_id, Return.method == "Cash").all()
    )
    expected = round(
        (row.opening_cash or 0) + cash_sales + (row.cash_additions or 0) - cash_refunds - (row.cash_withdrawals or 0), 2
    )
    row.cash_sales = round(cash_sales, 2)
    row.cash_refunds = round(cash_refunds, 2)
    row.expected_cash = expected
    row.counted_cash = body.countedCash
    row.variance = round(body.countedCash - expected, 2)
    row.notes = body.notes or ""
    row.status = "closed"
    from datetime import datetime
    row.closed_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": "ok", **_shift_out(row)}


@router.get("")
def list_shifts(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    store_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100,
):
    q = db.query(Shift)
    if store_id:
        q = q.filter(Shift.store_id == store_id)
    if status:
        q = q.filter(Shift.status == status)
    rows = q.order_by(Shift.id.desc()).limit(limit).all()
    return {"ok": True, "data": [_shift_out(r) for r in rows]}


@router.get("/{shift_id}")
def get_shift(
    shift_id: str, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
):
    row = db.query(Shift).filter(Shift.shift_id == shift_id).first()
    if not row:
        raise HTTPException(404, "Shift not found")
    movements = db.query(ShiftCashMovement).filter(ShiftCashMovement.shift_id == shift_id).order_by(ShiftCashMovement.id.asc()).all()
    return {"ok": True, **_shift_out(row), "movements": [
        {"id": m.movement_id, "type": m.type, "amount": m.amount, "reason": m.reason, "recordedBy": m.recorded_by} for m in movements
    ]}
