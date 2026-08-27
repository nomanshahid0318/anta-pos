"""Attendance — daily per-employee record (Present/Absent/Half-Day/Leave)
that Payroll uses to compute an Earned Salary from each employee's
Standard Salary, instead of assuming a full month was worked. If no
attendance was marked for a given store+month at all, Payroll falls back
to the full Standard Salary (so nothing breaks for stores that haven't
started using Attendance yet).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _now() -> datetime:
    return datetime.utcnow()


class AttendanceRecord(Base):
    __tablename__ = "attendance_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    record_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    employee_user_id: Mapped[str] = mapped_column(String(32), index=True)
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)  # YYYY-MM-DD
    status: Mapped[str] = mapped_column(String(16), default="present")  # present | absent | half_day | leave | late
    notes: Mapped[str] = mapped_column(String(255), default="")
    marked_by: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
