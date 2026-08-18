"""HO expenses — accountant/admin only (removed from POS)."""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..auth import CurrentUser, require_role
from ..database import get_db
from ..models import Expense
from ..schemas import ExpenseIn
from ..services.accounting import post_expense_journal
from ..utils import today_str

router = APIRouter(prefix="/api", tags=["expenses"])


@router.post("/expenses")
def create_expense(
    body: ExpenseIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    exp_id = body.id or f"EXP-{int(__import__('time').time() * 1000)}"
    if db.query(Expense).filter(Expense.exp_id == exp_id).first():
        return {"ok": True, "status": "duplicate", "id": exp_id}
    row = Expense(
        exp_id=exp_id,
        date=body.date or today_str(),
        store_id=body.storeId or user.store_id or "HO",
        store=body.store or user.store_name or "HO",
        category=body.category,
        sub_category=body.subCategory or "",
        description=body.description or "",
        amount=body.amount,
        pay_method=body.payMethod or "Cash",
        reference=body.reference or "",
        notes=body.notes or "",
    )
    db.add(row)
    post_expense_journal(db, row)
    db.commit()
    return {"ok": True, "status": "ok", "id": exp_id}


@router.get("/expenses")
def list_expenses(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant", "manager"))],
    limit: int = 200,
    store_id: Optional[str] = Query(None),
):
    q = db.query(Expense)
    if user.role == "manager":
        q = q.filter(Expense.store_id == user.store_id)
    elif store_id:
        q = q.filter(Expense.store_id == store_id)
    rows = q.order_by(Expense.id.desc()).limit(limit).all()
    data = [
        {
            "id": r.exp_id,
            "date": r.date,
            "storeId": r.store_id,
            "store": r.store,
            "category": r.category,
            "subCategory": r.sub_category,
            "description": r.description,
            "amount": r.amount,
            "payMethod": r.pay_method,
            "reference": r.reference,
            "notes": r.notes,
            "synced": True,
        }
        for r in rows
    ]
    return {"ok": True, "data": data}
