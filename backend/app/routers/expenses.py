"""HO expenses — accountant/admin only (removed from POS)."""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..auth import CurrentUser, require_role
from ..database import get_db
from ..models import Expense, JournalEntry, JournalLine
from ..schemas import ExpenseIn
from ..services.accounting import post_expense_journal
from ..services.audit import log_audit
from ..utils import today_str

router = APIRouter(prefix="/api", tags=["expenses"])


def _delete_journal_for(db: Session, source_type: str, source_id: str) -> None:
    je = db.query(JournalEntry).filter(JournalEntry.source_type == source_type, JournalEntry.source_id == source_id).first()
    if not je:
        return
    db.query(JournalLine).filter(JournalLine.entry_id == je.id).delete()
    db.delete(je)


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
        cost_center_id=body.costCenterId or "",
        project_id=body.projectId or "",
    )
    db.add(row)
    post_expense_journal(db, row)
    log_audit(db, user, "create", "expense", exp_id, f"Created expense: {body.category} — {body.amount}", new_value=body.model_dump())
    db.commit()
    return {"ok": True, "status": "ok", "id": exp_id}


@router.put("/expenses/{exp_id}")
def update_expense(
    exp_id: str,
    body: ExpenseIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    row = db.query(Expense).filter(Expense.exp_id == exp_id).first()
    if not row:
        raise HTTPException(404, "Expense not found")
    old_value = {"date": row.date, "category": row.category, "description": row.description, "amount": row.amount, "payMethod": row.pay_method}
    row.date = body.date or row.date
    row.store_id = body.storeId or row.store_id
    row.store = body.store or row.store
    row.category = body.category
    row.sub_category = body.subCategory or ""
    row.description = body.description or ""
    row.amount = body.amount
    row.pay_method = body.payMethod or "Cash"
    row.reference = body.reference or ""
    row.notes = body.notes or ""
    row.cost_center_id = body.costCenterId or row.cost_center_id
    row.project_id = body.projectId or row.project_id
    # post_journal() is a no-op if a journal already exists for this
    # source_id, so a straight re-post would keep the OLD amount — delete
    # the old journal entry first so the corrected figures actually post.
    _delete_journal_for(db, "expense", exp_id)
    post_expense_journal(db, row)
    log_audit(db, user, "update", "expense", exp_id, f"Updated expense: {row.category} — {row.amount}", old_value=old_value, new_value=body.model_dump())
    db.commit()
    return {"ok": True, "status": "ok"}


@router.delete("/expenses/{exp_id}")
def delete_expense(
    exp_id: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    row = db.query(Expense).filter(Expense.exp_id == exp_id).first()
    if not row:
        raise HTTPException(404, "Expense not found")
    _delete_journal_for(db, "expense", exp_id)
    log_audit(db, user, "delete", "expense", exp_id, f"Deleted expense: {row.category} — {row.amount}", old_value={"date": row.date, "category": row.category, "description": row.description, "amount": row.amount})
    db.delete(row)
    db.commit()
    return {"ok": True, "status": "ok"}


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
            "costCenterId": r.cost_center_id,
            "projectId": r.project_id,
            "synced": True,
        }
        for r in rows
    ]
    return {"ok": True, "data": data}
