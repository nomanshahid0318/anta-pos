"""Customer / Loyalty (CRM) models."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _now() -> datetime:
    return datetime.utcnow()


class Customer(Base):
    """A customer record shared across all stores. Phone number is the
    normal lookup key at checkout (a cashier types/scans it to find or
    create a customer in a couple of seconds).
    """

    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    phone: Mapped[str] = mapped_column(String(32), index=True, default="")
    email: Mapped[str] = mapped_column(String(128), default="")
    birthday: Mapped[str] = mapped_column(String(16), default="")  # MM-DD or full YYYY-MM-DD
    notes: Mapped[str] = mapped_column(Text, default="")
    loyalty_points: Mapped[float] = mapped_column(Float, default=0.0)
    total_spent: Mapped[float] = mapped_column(Float, default=0.0)
    visit_count: Mapped[int] = mapped_column(Integer, default=0)
    first_visit: Mapped[str] = mapped_column(String(16), default="")
    last_visit: Mapped[str] = mapped_column(String(16), default="")
    home_store_id: Mapped[str] = mapped_column(String(32), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
