"""Payroll — a monthly record per employee showing base salary, any
deductions (from outstanding Employee Advances, e.g. stock shortages
they're responsible for), and net pay. Finalizing a deduction actually
calls the existing Employee Advance repayment mechanism, so there's one
single source of truth for what's still owed.
"""
from __future__ import annotations

import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import CurrentUser, require_role
from ..database import get_db
from ..models import User
from ..models_accounting import EmployeeAdvance, EmployeeAdvanceRepayment
from ..models_payroll import PayrollEntry, PayrollRun

router = APIRouter(prefix="/api/payroll", tags=["payroll"])


class StartRunIn(BaseModel):
    storeId: str
    storeName: str = ""
    month: str  # YYYY-MM


class EntryIn(BaseModel):
    employeeUserId: str
    baseSalary: float = 0.0
    deductionAmount: float = 0.0
    notes: str = ""


class SaveEntriesIn(BaseModel):
    entries: list[EntryIn] = Field(default_factory=list)


def _run_out(r: PayrollRun) -> dict:
    return {
        "id": r.run_id, "storeId": r.store_id, "storeName": r.store_name, "month": r.month,
        "status": r.status, "createdAt": r.created_at.isoformat() if r.created_at else "",
        "finalizedAt": r.finalized_at.isoformat() if r.finalized_at else "",
    }


@router.get("/runs")
def list_runs(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))], store_id: Optional[str] = None):
    q = db.query(PayrollRun)
    if store_id:
        q = q.filter(PayrollRun.store_id == store_id)
    rows = q.order_by(PayrollRun.id.desc()).all()
    return {"ok": True, "data": [_run_out(r) for r in rows]}


@router.post("/runs")
def start_run(body: StartRunIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))]):
    existing = db.query(PayrollRun).filter(PayrollRun.store_id == body.storeId, PayrollRun.month == body.month).first()
    if existing:
        return {"ok": True, "status": "already_exists", "id": existing.run_id}
    rid = f"PR-{int(time.time()*1000)}"
    row = PayrollRun(run_id=rid, store_id=body.storeId, store_name=body.storeName or body.storeId, month=body.month)
    db.add(row)
    db.commit()
    return {"ok": True, "status": "ok", "id": rid}


@router.get("/runs/{run_id}")
def get_run(run_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))]):
    row = db.query(PayrollRun).filter(PayrollRun.run_id == run_id).first()
    if not row:
        raise HTTPException(404, "Payroll run not found")
    employees = db.query(User).filter(User.store_id == row.store_id, User.active.is_(True)).all()
    entries_by_emp = {e.employee_user_id: e for e in db.query(PayrollEntry).filter(PayrollEntry.run_id == run_id).all()}
    out_entries = []
    for emp in employees:
        advances = db.query(EmployeeAdvance).filter(EmployeeAdvance.employee_name == emp.name, EmployeeAdvance.written_off.is_(False)).all()
        outstanding = round(sum((a.amount or 0) - (a.repaid_amount or 0) for a in advances), 2)
        # Advances specifically tagged for THIS month (from a stock-count allocation's deduction_month) surface first as the suggested deduction.
        month_tagged = round(sum(
            (a.amount or 0) - (a.repaid_amount or 0) for a in advances if f"deduct from {row.month} payroll" in (a.reason or "")
        ), 2)
        existing_entry = entries_by_emp.get(emp.user_id)
        out_entries.append({
            "employeeUserId": emp.user_id, "employeeName": emp.name, "role": emp.role,
            "outstandingAdvances": outstanding,
            "suggestedDeduction": month_tagged if month_tagged > 0 else 0,
            "baseSalary": existing_entry.base_salary if existing_entry else 0,
            "deductionAmount": existing_entry.deduction_amount if existing_entry else 0,
            "netPay": existing_entry.net_pay if existing_entry else 0,
            "notes": existing_entry.notes if existing_entry else "",
            "saved": existing_entry is not None,
        })
    return {"ok": True, **_run_out(row), "entries": out_entries}


@router.put("/runs/{run_id}/entries")
def save_entries(
    run_id: str, body: SaveEntriesIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
):
    row = db.query(PayrollRun).filter(PayrollRun.run_id == run_id).first()
    if not row:
        raise HTTPException(404, "Payroll run not found")
    if row.status != "draft":
        raise HTTPException(400, "This payroll run is already finalized")
    for e in body.entries:
        emp = db.query(User).filter(User.user_id == e.employeeUserId).first()
        outstanding = 0.0
        if emp:
            advances = db.query(EmployeeAdvance).filter(EmployeeAdvance.employee_name == emp.name, EmployeeAdvance.written_off.is_(False)).all()
            outstanding = sum((a.amount or 0) - (a.repaid_amount or 0) for a in advances)
        if e.deductionAmount > outstanding + 0.005:
            raise HTTPException(400, f"Deduction for {emp.name if emp else e.employeeUserId} ({e.deductionAmount}) exceeds their outstanding advance balance ({round(outstanding,2)})")
        existing = db.query(PayrollEntry).filter(PayrollEntry.run_id == run_id, PayrollEntry.employee_user_id == e.employeeUserId).first()
        net_pay = round(e.baseSalary - e.deductionAmount, 2)
        if existing:
            existing.base_salary, existing.deduction_amount, existing.net_pay, existing.notes = e.baseSalary, e.deductionAmount, net_pay, e.notes
        else:
            db.add(PayrollEntry(
                run_id=run_id, employee_user_id=e.employeeUserId, employee_name=emp.name if emp else e.employeeUserId,
                base_salary=e.baseSalary, deduction_amount=e.deductionAmount, net_pay=net_pay, notes=e.notes,
            ))
    db.commit()
    return {"ok": True, "status": "ok"}


@router.post("/runs/{run_id}/finalize")
def finalize_run(run_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))]):
    """Locks the run and actually applies every entry's deduction as a
    real Salary Deduction repayment against the employee's Advance(s) —
    oldest advance first — so Employee Advances stays the single source
    of truth for what's still owed.
    """
    row = db.query(PayrollRun).filter(PayrollRun.run_id == run_id).first()
    if not row:
        raise HTTPException(404, "Payroll run not found")
    if row.status != "draft":
        raise HTTPException(400, "Already finalized")
    entries = db.query(PayrollEntry).filter(PayrollEntry.run_id == run_id).all()
    for e in entries:
        remaining = e.deduction_amount
        if remaining <= 0:
            continue
        advances = (
            db.query(EmployeeAdvance)
            .filter(EmployeeAdvance.employee_name == e.employee_name, EmployeeAdvance.written_off.is_(False))
            .order_by(EmployeeAdvance.id.asc())
            .all()
        )
        for adv in advances:
            if remaining <= 0.005:
                break
            balance = round((adv.amount or 0) - (adv.repaid_amount or 0), 2)
            if balance <= 0:
                continue
            take = min(balance, remaining)
            rep_id = f"ADVR-{int(time.time()*1000)}-{adv.id}"
            db.add(EmployeeAdvanceRepayment(
                repayment_id=rep_id, advance_id=adv.advance_id, date=f"{row.month}-28",
                amount=take, method="Salary Deduction", notes=f"Payroll {run_id} ({row.month})",
            ))
            adv.repaid_amount = round((adv.repaid_amount or 0) + take, 2)
            remaining = round(remaining - take, 2)
    row.status = "finalized"
    from datetime import datetime
    row.finalized_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": "ok"}
