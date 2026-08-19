"""HO accounting models — suppliers, capital, balance sheet, cash flow extras."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _now() -> datetime:
    return datetime.utcnow()


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    supplier_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    contact: Mapped[str] = mapped_column(String(128), default="")
    credit_limit: Mapped[float] = mapped_column(Float, default=0.0)
    terms: Mapped[str] = mapped_column(String(64), default="Net 30")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class SupplierTxn(Base):
    __tablename__ = "supplier_txns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    txn_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    supplier_id: Mapped[str] = mapped_column(String(64), index=True)
    supplier_name: Mapped[str] = mapped_column(String(128), default="")
    date: Mapped[str] = mapped_column(String(16), index=True)
    type: Mapped[str] = mapped_column(String(32), default="invoice")
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    reference: Mapped[str] = mapped_column(String(128), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class CapitalEntry(Base):
    __tablename__ = "capital_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    type: Mapped[str] = mapped_column(String(32))
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    description: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class BSEntry(Base):
    __tablename__ = "bs_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), default="")
    type: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(String(255), default="")
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class CFItem(Base):
    __tablename__ = "cf_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    section: Mapped[str] = mapped_column(String(32))
    label: Mapped[str] = mapped_column(String(255), default="")
    value: Mapped[float] = mapped_column(Float, default=0.0)
    date: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class FixedAsset(Base):
    """A durable, non-trading purchase (shop decor, furniture, equipment,
    vehicles, POS hardware, etc.) — NOT inventory for resale. Tracked here
    so its cost is depreciated over its useful life instead of hitting the
    P&L as a one-time expense (which would understate that period's real
    profit) or sitting forever at full value on the Balance Sheet.

    Depreciation is straight-line: (cost - salvage_value) / (useful_life_years
    * 12) recognized evenly every month from purchase_date, capped once fully
    depreciated. See services/depreciation.py for the calculation.
    """

    __tablename__ = "fixed_assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    asset_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    category: Mapped[str] = mapped_column(String(64), default="Other")
    store_id: Mapped[str] = mapped_column(String(32), default="HO")
    purchase_date: Mapped[str] = mapped_column(String(16))
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    salvage_value: Mapped[float] = mapped_column(Float, default=0.0)
    useful_life_years: Mapped[float] = mapped_column(Float, default=5.0)
    method: Mapped[str] = mapped_column(String(32), default="straight-line")
    notes: Mapped[str] = mapped_column(String(255), default="")
    disposed: Mapped[bool] = mapped_column(Boolean, default=False)
    disposed_date: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
