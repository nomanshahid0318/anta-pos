"""Cashier Shift / Register Management — per-cashier, per-shift cash
accountability. Separate from the whole-store Day-End Handover: a shift
belongs to ONE cashier, tracks their opening float, any cash added or
removed mid-shift (with a reason), and closes with a counted-vs-expected
cash variance — the standard retail register-close model.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _now() -> datetime:
    return datetime.utcnow()


class Shift(Base):
    __tablename__ = "shifts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    shift_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    store_name: Mapped[str] = mapped_column(String(128), default="")
    cashier_id: Mapped[str] = mapped_column(String(64), index=True)
    cashier_name: Mapped[str] = mapped_column(String(128), default="")
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    opening_cash: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open | closed
    closed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    cash_sales: Mapped[float] = mapped_column(Float, default=0.0)
    cash_refunds: Mapped[float] = mapped_column(Float, default=0.0)
    cash_additions: Mapped[float] = mapped_column(Float, default=0.0)
    cash_withdrawals: Mapped[float] = mapped_column(Float, default=0.0)
    expected_cash: Mapped[float] = mapped_column(Float, default=0.0)
    counted_cash: Mapped[float] = mapped_column(Float, nullable=True)
    variance: Mapped[float] = mapped_column(Float, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")


class ShiftCashMovement(Base):
    __tablename__ = "shift_cash_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    movement_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    shift_id: Mapped[str] = mapped_column(String(64), index=True)
    type: Mapped[str] = mapped_column(String(16))  # addition | withdrawal
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    reason: Mapped[str] = mapped_column(String(255), default="")
    recorded_by: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
