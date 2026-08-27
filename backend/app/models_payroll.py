"""Payroll — monthly per-employee record showing base salary, any
deductions (from stock-shortage Employee Advances repaid via salary),
and net pay. Finalizing an entry's deduction actually calls the existing
Employee Advance repayment mechanism (method='Salary Deduction'), so
there's one single source of truth for what an employee still owes.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _now() -> datetime:
    return datetime.utcnow()


class PayrollRun(Base):
    __tablename__ = "payroll_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    store_name: Mapped[str] = mapped_column(String(128), default="")
    month: Mapped[str] = mapped_column(String(7), index=True)  # YYYY-MM
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | finalized
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    finalized_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class PayrollEntry(Base):
    __tablename__ = "payroll_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(64), index=True)
    employee_user_id: Mapped[str] = mapped_column(String(32), index=True)
    employee_name: Mapped[str] = mapped_column(String(128), default="")
    employee_code: Mapped[str] = mapped_column(String(16), default="")
    role: Mapped[str] = mapped_column(String(32), default="")
    base_salary: Mapped[float] = mapped_column(Float, default=0.0)
    allowances: Mapped[float] = mapped_column(Float, default=0.0)
    gross_pay: Mapped[float] = mapped_column(Float, default=0.0)
    advance_deduction: Mapped[float] = mapped_column(Float, default=0.0)  # from Employee Advance repayment (stock shortages etc.)
    deduction_amount: Mapped[float] = mapped_column(Float, default=0.0)  # legacy field name, kept for any already-saved draft rows
    other_deduction: Mapped[float] = mapped_column(Float, default=0.0)  # manual — uniform cost, lateness, etc.
    other_deduction_note: Mapped[str] = mapped_column(String(255), default="")
    total_deductions: Mapped[float] = mapped_column(Float, default=0.0)
    net_pay: Mapped[float] = mapped_column(Float, default=0.0)
    payment_method: Mapped[str] = mapped_column(String(32), default="Cash")  # Cash | Bank Transfer
    notes: Mapped[str] = mapped_column(String(255), default="")
