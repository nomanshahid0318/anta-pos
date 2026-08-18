"""Chart of Accounts + journal entries."""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import CurrentUser, require_role
from ..database import get_db
from ..models import Account, JournalEntry, JournalLine
from ..services.accounting import ensure_coa, post_journal
from ..utils import today_str

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


class AccountIn(BaseModel):
    code: str
    name: str
    type: str = "asset"
    active: bool = True


class JELineIn(BaseModel):
    accountCode: str
    debit: float = 0
    credit: float = 0
    memo: str = ""


class JournalIn(BaseModel):
    date: Optional[str] = None
    memo: str = ""
    lines: list[JELineIn] = Field(default_factory=list)


@router.get("/coa")
def list_coa(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant", "manager"))],
):
    ensure_coa(db)
    db.commit()
    rows = db.query(Account).order_by(Account.code).all()
    return {
        "ok": True,
        "data": [
            {"code": r.code, "name": r.name, "type": r.type, "active": r.active}
            for r in rows
        ],
    }


@router.post("/coa")
def save_account(
    body: AccountIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    row = db.query(Account).filter(Account.code == body.code).first()
    if row:
        row.name = body.name
        row.type = body.type
        row.active = body.active
    else:
        db.add(Account(code=body.code, name=body.name, type=body.type, active=body.active))
    db.commit()
    return {"ok": True}


@router.get("/journals")
def list_journals(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant", "manager"))],
    limit: int = 100,
    source_type: Optional[str] = None,
):
    q = db.query(JournalEntry).order_by(JournalEntry.id.desc())
    if source_type:
        q = q.filter(JournalEntry.source_type == source_type)
    rows = q.limit(limit).all()
    data = []
    for je in rows:
        lines = db.query(JournalLine).filter(JournalLine.entry_id == je.id).all()
        acc_map = {a.id: a for a in db.query(Account).all()}
        data.append(
            {
                "id": je.entry_no,
                "date": je.date,
                "memo": je.memo,
                "sourceType": je.source_type,
                "sourceId": je.source_id,
                "lines": [
                    {
                        "accountCode": acc_map[l.account_id].code if l.account_id in acc_map else "",
                        "accountName": acc_map[l.account_id].name if l.account_id in acc_map else "",
                        "debit": l.debit,
                        "credit": l.credit,
                        "memo": l.memo,
                    }
                    for l in lines
                ],
            }
        )
    return {"ok": True, "data": data}


@router.post("/journals")
def create_journal(
    body: JournalIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    if len(body.lines) < 2:
        raise HTTPException(400, "Need at least 2 lines")
    src = f"MAN-{int(__import__('time').time() * 1000)}"
    je = post_journal(
        db,
        date=body.date or today_str(),
        memo=body.memo or "Manual entry",
        source_type="manual",
        source_id=src,
        lines=[(l.accountCode, l.debit, l.credit, l.memo) for l in body.lines],
    )
    if not je:
        raise HTTPException(400, "Unbalanced or invalid journal")
    db.commit()
    return {"ok": True, "id": je.entry_no}
