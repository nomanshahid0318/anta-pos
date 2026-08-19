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
    po_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class CapitalEntry(Base):
    __tablename__ = "capital_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    type: Mapped[str] = mapped_column(String(32))
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    description: Mapped[str] = mapped_column(String(255), default="")
    cf_item_id: Mapped[str] = mapped_column(String(64), default="")
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
    cf_item_id: Mapped[str] = mapped_column(String(64), default="")
    disposed: Mapped[bool] = mapped_column(Boolean, default=False)
    disposed_date: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class PurchaseOrder(Base):
    """A commitment to buy stock from a supplier, before it's physically
    received. Separate from Supplier GRN (which records actual receipt).
    This is what lets a payment made today (e.g. an advance) be tracked
    against stock that only arrives weeks or months later — the PO stays
    'open' in between, and any advance payment made against it shows on
    the Balance Sheet as a real asset (Advance to Suppliers) instead of
    just vanishing from the books until the goods show up.
    """

    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    po_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    expected_date: Mapped[str] = mapped_column(String(16), default="")
    supplier_id: Mapped[str] = mapped_column(String(64), index=True)
    supplier_name: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[str] = mapped_column(String(24), default="open")  # open | partially_received | received | cancelled
    notes: Mapped[str] = mapped_column(Text, default="")
    advance_paid: Mapped[float] = mapped_column(Float, default=0.0)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    received_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    po_id: Mapped[str] = mapped_column(String(64), index=True)
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    qty_ordered: Mapped[int] = mapped_column(Integer, default=0)
    qty_received: Mapped[int] = mapped_column(Integer, default=0)
    unit_cost: Mapped[float] = mapped_column(Float, default=0.0)
