"""Attendance tracking — daily marking + monthly summary that Payroll
reads to compute an Earned Salary ratio.
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
from ..models_attendance import AttendanceRecord

router = APIRouter(prefix="/api/attendance", tags=["attendance"])

VALID_STATUSES = ("present", "absent", "half_day", "leave", "late", "day_off")
# present/late/day_off = full pay. half_day = half pay. absent/leave = unpaid.
# day_off is the entitled rotating rest day (e.g. 4/month) — NOT the same
# as "leave", which is unpaid time beyond that entitlement.
PAID_STATUSES = ("present", "late", "day_off")


class MarkOne(BaseModel):
    employeeUserId: str
    status: str = "present"
    notes: str = ""


class MarkIn(BaseModel):
    storeId: str
    date: str  # YYYY-MM-DD
    records: list[MarkOne] = Field(default_factory=list)


class UploadRow(BaseModel):
    employeeCode: str = ""
    employeeUserId: str = ""
    date: str
    status: str = "present"


class UploadIn(BaseModel):
    storeId: str
    rows: list[UploadRow] = Field(default_factory=list)


def _row_out(r: AttendanceRecord) -> dict:
    return {"employeeUserId": r.employee_user_id, "date": r.date, "status": r.status, "notes": r.notes}


@router.post("/mark")
def mark_attendance(
    body: MarkIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))],
):
    saved = 0
    for rec in body.records:
        if rec.status not in VALID_STATUSES:
            raise HTTPException(400, f"Invalid status '{rec.status}'")
        existing = (
            db.query(AttendanceRecord)
            .filter(AttendanceRecord.employee_user_id == rec.employeeUserId, AttendanceRecord.date == body.date)
            .first()
        )
        if existing:
            existing.status = rec.status
            existing.notes = rec.notes
            existing.marked_by = user.name
        else:
            db.add(AttendanceRecord(
                record_id=f"ATT-{int(time.time()*1000)}-{rec.employeeUserId}",
                employee_user_id=rec.employeeUserId, store_id=body.storeId, date=body.date,
                status=rec.status, notes=rec.notes, marked_by=user.name,
            ))
        saved += 1
    db.commit()
    return {"ok": True, "status": "ok", "saved": saved}


@router.get("/day")
def get_day(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))],
    storeId: str, date: str,
):
    employees = db.query(User).filter(User.store_id == storeId, User.active.is_(True)).all()
    marks = {
        r.employee_user_id: r
        for r in db.query(AttendanceRecord).filter(AttendanceRecord.store_id == storeId, AttendanceRecord.date == date).all()
    }
    out = []
    for emp in employees:
        m = marks.get(emp.user_id)
        out.append({
            "employeeUserId": emp.user_id, "employeeCode": emp.employee_code, "employeeName": emp.name,
            "status": m.status if m else "present", "notes": m.notes if m else "",
        })
    return {"ok": True, "date": date, "storeId": storeId, "data": out}


@router.post("/upload")
def upload_attendance(
    body: UploadIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))],
):
    """Bulk-load attendance from Excel/CSV — Employee Code (or User ID) +
    Date + Status per row, matching the same scan-and-upload pattern used
    for Stock Take.
    """
    employees_by_code = {u.employee_code: u for u in db.query(User).filter(User.store_id == body.storeId).all() if u.employee_code}
    employees_by_id = {u.user_id: u for u in db.query(User).filter(User.store_id == body.storeId).all()}
    saved, skipped = 0, 0
    for row in body.rows:
        status = (row.status or "present").strip().lower().replace(" ", "_").replace("-", "_")
        if status not in VALID_STATUSES:
            skipped += 1
            continue
        emp = employees_by_id.get(row.employeeUserId) or employees_by_code.get((row.employeeCode or "").strip().upper())
        if not emp:
            skipped += 1
            continue
        existing = (
            db.query(AttendanceRecord)
            .filter(AttendanceRecord.employee_user_id == emp.user_id, AttendanceRecord.date == row.date)
            .first()
        )
        if existing:
            existing.status = status
            existing.marked_by = user.name
        else:
            db.add(AttendanceRecord(
                record_id=f"ATT-{int(time.time()*1000)}-{emp.user_id}-{row.date}",
                employee_user_id=emp.user_id, store_id=body.storeId, date=row.date,
                status=status, marked_by=user.name,
            ))
        saved += 1
    db.commit()
    return {"ok": True, "status": "ok", "saved": saved, "skipped": skipped}


@router.get("/summary")
def attendance_summary(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    storeId: str, month: str,
):
    """Per-employee summary for a store+month — this is what Payroll
    reads to compute Earned Salary. If nothing was marked for an
    employee, their entry just isn't in the result (Payroll then falls
    back to their full Standard Salary).
    """
    from ..models import Setting
    settings_map = {s.key: s.value for s in db.query(Setting).filter(Setting.key.in_(["monthly_dayoff_entitlement", "late_fine_amount"])).all()}
    dayoff_entitlement = float(settings_map.get("monthly_dayoff_entitlement", 4))
    late_fine = float(settings_map.get("late_fine_amount", 10))

    employees = db.query(User).filter(User.store_id == storeId, User.active.is_(True)).all()
    records = db.query(AttendanceRecord).filter(AttendanceRecord.store_id == storeId, AttendanceRecord.date.like(f"{month}%")).all()
    by_emp: dict = {}
    total_marked_days_all = set()
    for r in records:
        by_emp.setdefault(r.employee_user_id, []).append(r)
        total_marked_days_all.add(r.date)
    total_working_days = len(total_marked_days_all)  # days ANYONE at this store was marked — the store's own working-day count for the month
    out = []
    for emp in employees:
        recs = by_emp.get(emp.user_id, [])
        present = sum(1 for r in recs if r.status == "present")
        late = sum(1 for r in recs if r.status == "late")
        half = sum(1 for r in recs if r.status == "half_day")
        absent = sum(1 for r in recs if r.status == "absent")
        leave = sum(1 for r in recs if r.status == "leave")
        day_off = sum(1 for r in recs if r.status == "day_off")
        marked = len(recs)
        # present/late/day_off are all full-paid days; half_day is half;
        # absent/leave are unpaid — this is the earned-salary ratio.
        effective_present = present + late + day_off + (half * 0.5)
        ratio = round(effective_present / marked, 4) if marked > 0 else None
        over_entitlement = max(0, day_off - dayoff_entitlement)
        late_fine_total = round(late * late_fine, 2)
        out.append({
            "employeeUserId": emp.user_id, "employeeName": emp.name, "employeeCode": emp.employee_code,
            "present": present, "late": late, "halfDay": half, "absent": absent, "leave": leave, "dayOff": day_off,
            "dayOffEntitlement": dayoff_entitlement, "dayOffOverEntitlement": over_entitlement,
            "lateFineAmount": late_fine, "lateFineTotal": late_fine_total,
            "markedDays": marked, "totalWorkingDays": total_working_days, "attendanceRatio": ratio,
        })
    return {"ok": True, "storeId": storeId, "month": month, "totalWorkingDays": total_working_days, "dayoffEntitlement": dayoff_entitlement, "lateFineAmount": late_fine, "data": out}
