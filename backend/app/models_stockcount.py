"""Stock Adjustments / Physical Count — the professional-retail internal
control that a Chart of Accounts alone can't give you: proving that what
the system THINKS is on the shelf actually matches what's physically
there, with every correction requiring a stated reason and manager
sign-off before it silently changes stock (and therefore Balance Sheet
inventory value).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _now() -> datetime:
    return datetime.utcnow()


class StockCount(Base):
    __tablename__ = "stock_counts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    count_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    store_name: Mapped[str] = mapped_column(String(128), default="")
    date: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)  # draft | approved
    counted_by: Mapped[str] = mapped_column(String(128), default="")
    approved_by: Mapped[str] = mapped_column(String(128), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    approved_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class StockCountLine(Base):
    __tablename__ = "stock_count_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    count_id: Mapped[str] = mapped_column(String(64), index=True)
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    system_qty: Mapped[int] = mapped_column(Integer, default=0)
    physical_qty: Mapped[int] = mapped_column(Integer, nullable=True)
    reason: Mapped[str] = mapped_column(String(255), default="")
    category: Mapped[str] = mapped_column(String(24), default="shrinkage")  # shrinkage | employee_fault | investigation — only meaningful for a shortage (negative variance)
    employee_user_id: Mapped[str] = mapped_column(String(32), default="")  # set when category == employee_fault
