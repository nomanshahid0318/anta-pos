"""Payroll — a proper monthly payroll sheet per employee: base salary,
allowances, gross pay, deductions broken into "Advance" (from Employee
Advances — e.g. stock shortages they're responsible for) and "Other"
(manual — uniform cost, lateness, etc. with its own note), total
deductions, and net pay. Finalizing a run's advance deductions actually
calls the existing Employee Advance repayment mechanism, so Employee
Advances stays the single source of truth for what's still owed.
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
from ..models_attendance import AttendanceRecord
from ..models_payroll import PayrollEntry, PayrollRun

router = APIRouter(prefix="/api/payroll", tags=["payroll"])


class StartRunIn(BaseModel):
    storeId: str
    storeName: str = ""
    month: str  # YYYY-MM


class EntryIn(BaseModel):
    employeeUserId: str
    baseSalary: float = 0.0
    allowances: float = 0.0
    advanceDeduction: float = 0.0
    otherDeduction: float = 0.0
    otherDeductionNote: str = ""
    paymentMethod: str = "Cash"
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
    out = []
    for r in rows:
        entries = db.query(PayrollEntry).filter(PayrollEntry.run_id == r.run_id).all()
        out.append({**_run_out(r), "employeeCount": len(entries), "totalNetPay": round(sum(e.net_pay or 0 for e in entries), 2)})
    return {"ok": True, "data": out}


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
    from ..models import Setting
    late_fine_row = db.query(Setting).filter(Setting.key == "late_fine_amount").first()
    late_fine = float(late_fine_row.value) if late_fine_row else 10.0
    employees = db.query(User).filter(User.store_id == row.store_id, User.active.is_(True)).all()
    entries_by_emp = {e.employee_user_id: e for e in db.query(PayrollEntry).filter(PayrollEntry.run_id == run_id).all()}

    # Attendance → earned-salary ratio per employee for this store+month.
    # If nobody's attendance was marked at all, everyone falls back to
    # their full Standard Salary (so stores that haven't started using
    # Attendance yet see no change in behavior).
    att_records = db.query(AttendanceRecord).filter(AttendanceRecord.store_id == row.store_id, AttendanceRecord.date.like(f"{row.month}%")).all()
    att_by_emp: dict = {}
    for a in att_records:
        att_by_emp.setdefault(a.employee_user_id, []).append(a)

    out_entries = []
    totals = {"baseSalary": 0.0, "allowances": 0.0, "grossPay": 0.0, "advanceDeduction": 0.0, "otherDeduction": 0.0, "totalDeductions": 0.0, "netPay": 0.0}
    for emp in employees:
        advances = db.query(EmployeeAdvance).filter(EmployeeAdvance.employee_name == emp.name, EmployeeAdvance.written_off.is_(False)).all()
        outstanding = round(sum((a.amount or 0) - (a.repaid_amount or 0) for a in advances), 2)
        month_tagged = round(sum(
            (a.amount or 0) - (a.repaid_amount or 0) for a in advances if f"deduct from {row.month} payroll" in (a.reason or "")
        ), 2)
        e = entries_by_emp.get(emp.user_id)

        emp_att = att_by_emp.get(emp.user_id, [])
        marked = len(emp_att)
        present = sum(1 for a in emp_att if a.status in ("present", "late", "day_off"))
        half = sum(0.5 for a in emp_att if a.status == "half_day")
        late_count = sum(1 for a in emp_att if a.status == "late")
        attendance_ratio = round((present + half) / marked, 4) if marked > 0 else None
        late_fine_total = round(late_count * late_fine, 2)

        if e:
            base = e.base_salary
        elif attendance_ratio is not None:
            base = round((emp.standard_salary or 0) * attendance_ratio, 2)
        else:
            base = emp.standard_salary or 0
        allow = e.allowances if e else 0
        gross = e.gross_pay if e else round(base + allow, 2)
        adv_ded = e.advance_deduction if e else 0
        # Suggest the late fine as a starting point for Other Deduction —
        # still editable/overridable, matching how Advance Deduction is
        # only ever a suggestion until Save is clicked.
        other_ded = e.other_deduction if e else late_fine_total
        other_note = e.other_deduction_note if e else (f"{late_count} late day(s) × {late_fine} fine" if late_fine_total > 0 else "")
        total_ded = e.total_deductions if e else round(adv_ded + other_ded, 2)
        net = e.net_pay if e else round(gross - total_ded, 2)
        out_entries.append({
            "employeeUserId": emp.user_id, "employeeCode": emp.employee_code, "employeeName": emp.name, "role": emp.role,
            "outstandingAdvances": outstanding,
            "attendanceMarkedDays": marked, "attendancePresent": present, "attendanceRatio": attendance_ratio,
            "lateCount": late_count, "lateFineTotal": late_fine_total,
            "suggestedDeduction": month_tagged if month_tagged > 0 else 0,
            "baseSalary": base, "allowances": allow, "grossPay": gross,
            "advanceDeduction": adv_ded, "otherDeduction": other_ded, "otherDeductionNote": other_note,
            "totalDeductions": total_ded, "netPay": net,
            "paymentMethod": e.payment_method if e else "Cash", "notes": e.notes if e else "",
            "saved": e is not None,
        })
        if e:
            totals["baseSalary"] += base
            totals["allowances"] += allow
            totals["grossPay"] += gross
            totals["advanceDeduction"] += adv_ded
            totals["otherDeduction"] += other_ded
            totals["totalDeductions"] += total_ded
            totals["netPay"] += net
    totals = {k: round(v, 2) for k, v in totals.items()}
    return {"ok": True, **_run_out(row), "entries": out_entries, "totals": totals}


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
        if e.advanceDeduction > outstanding + 0.005:
            raise HTTPException(400, f"Advance deduction for {emp.name if emp else e.employeeUserId} ({e.advanceDeduction}) exceeds their outstanding advance balance ({round(outstanding,2)})")
        if e.otherDeduction > 0 and not e.otherDeductionNote.strip():
            raise HTTPException(400, f"A note is required for {emp.name if emp else e.employeeUserId}'s Other Deduction")
        gross_pay = round(e.baseSalary + e.allowances, 2)
        total_deductions = round(e.advanceDeduction + e.otherDeduction, 2)
        net_pay = round(gross_pay - total_deductions, 2)
        existing = db.query(PayrollEntry).filter(PayrollEntry.run_id == run_id, PayrollEntry.employee_user_id == e.employeeUserId).first()
        if existing:
            existing.base_salary = e.baseSalary
            existing.allowances = e.allowances
            existing.gross_pay = gross_pay
            existing.advance_deduction = e.advanceDeduction
            existing.deduction_amount = e.advanceDeduction
            existing.other_deduction = e.otherDeduction
            existing.other_deduction_note = e.otherDeductionNote
            existing.total_deductions = total_deductions
            existing.net_pay = net_pay
            existing.payment_method = e.paymentMethod
            existing.notes = e.notes
            existing.employee_code = emp.employee_code if emp else ""
            existing.role = emp.role if emp else ""
        else:
            db.add(PayrollEntry(
                run_id=run_id, employee_user_id=e.employeeUserId, employee_name=emp.name if emp else e.employeeUserId,
                employee_code=emp.employee_code if emp else "", role=emp.role if emp else "",
                base_salary=e.baseSalary, allowances=e.allowances, gross_pay=gross_pay,
                advance_deduction=e.advanceDeduction, deduction_amount=e.advanceDeduction,
                other_deduction=e.otherDeduction, other_deduction_note=e.otherDeductionNote,
                total_deductions=total_deductions, net_pay=net_pay,
                payment_method=e.paymentMethod, notes=e.notes,
            ))
    db.commit()
    return {"ok": True, "status": "ok"}


@router.post("/runs/{run_id}/finalize")
def finalize_run(run_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))]):
    """Locks the run and actually applies every entry's Advance Deduction
    as a real Salary Deduction repayment against the employee's
    Advance(s) — oldest advance first. Other Deductions are just recorded
    on the payslip (they're not tied to any Advance, nothing to repay).
    """
    row = db.query(PayrollRun).filter(PayrollRun.run_id == run_id).first()
    if not row:
        raise HTTPException(404, "Payroll run not found")
    if row.status != "draft":
        raise HTTPException(400, "Already finalized")
    entries = db.query(PayrollEntry).filter(PayrollEntry.run_id == run_id).all()
    for e in entries:
        remaining = e.advance_deduction
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
