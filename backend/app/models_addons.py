"""Cheque Management, Budget vs Actual, Sales Commission, Item Serial
Numbers, and Warranty tracking — added based on a feature comparison
against a commercial ERP (XTRA/EasyBooks).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def _now() -> datetime:
    return datetime.utcnow()


class Cheque(Base):
    """A postdated cheque — either receivable (a customer paid us with
    one) or payable (we paid a supplier with one) — tracked through its
    whole lifecycle so nothing bounces unnoticed.
    """

    __tablename__ = "cheques"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    cheque_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    direction: Mapped[str] = mapped_column(String(16), index=True)  # receivable | payable
    cheque_number: Mapped[str] = mapped_column(String(64), default="")
    bank_name: Mapped[str] = mapped_column(String(128), default="")
    party_name: Mapped[str] = mapped_column(String(128), default="")  # customer or supplier name
    party_type: Mapped[str] = mapped_column(String(16), default="")  # customer | supplier
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    issue_date: Mapped[str] = mapped_column(String(16), default="")
    due_date: Mapped[str] = mapped_column(String(16), index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)  # pending | deposited | cleared | bounced | cancelled
    store_id: Mapped[str] = mapped_column(String(32), default="HO")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    status_updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Budget(Base):
    """A planned spend for a category (optionally scoped to a store
    and/or cost center) for a given month — compared against actual
    Expense totals to show variance.
    """

    __tablename__ = "budgets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    month: Mapped[str] = mapped_column(String(7), index=True)  # YYYY-MM
    category: Mapped[str] = mapped_column(String(64), index=True)
    store_id: Mapped[str] = mapped_column(String(32), default="")  # blank = company-wide
    cost_center_id: Mapped[str] = mapped_column(String(32), default="")
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class SalesCommission(Base):
    """One employee's commission on one sale — computed at sale time
    from their commission rate, then aggregated into Payroll as an
    Allowance for the month.
    """

    __tablename__ = "sales_commissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sale_invoice_id: Mapped[str] = mapped_column(String(64), index=True)
    employee_user_id: Mapped[str] = mapped_column(String(32), index=True)
    employee_name: Mapped[str] = mapped_column(String(128), default="")
    date: Mapped[str] = mapped_column(String(16), index=True)
    sale_total: Mapped[float] = mapped_column(Float, default=0.0)
    commission_rate: Mapped[float] = mapped_column(Float, default=0.0)  # % at the time of sale
    commission_amount: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class ItemSerial(Base):
    """One physical unit's serial number — for authenticity verification
    (a real ANTA distributor's main use case for this: proving a pair is
    genuine, not counterfeit) and, incidentally, per-unit warranty
    tracking.
    """

    __tablename__ = "item_serials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    serial_number: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default="in_stock", index=True)  # in_stock | sold | returned
    store_id: Mapped[str] = mapped_column(String(32), default="")
    sale_invoice_id: Mapped[str] = mapped_column(String(64), default="")
    sold_date: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class WarrantyClaim(Base):
    """A defect/warranty claim against a specific sold item — separate
    from a Return, since a warranty claim doesn't necessarily mean a
    refund (could be repair, replacement, or rejection).
    """

    __tablename__ = "warranty_claims"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    claim_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    sale_invoice_id: Mapped[str] = mapped_column(String(64), index=True)
    barcode: Mapped[str] = mapped_column(String(64), default="")
    item_name: Mapped[str] = mapped_column(String(255), default="")
    serial_number: Mapped[str] = mapped_column(String(128), default="")
    customer_name: Mapped[str] = mapped_column(String(128), default="")
    store_id: Mapped[str] = mapped_column(String(32), default="")
    claim_date: Mapped[str] = mapped_column(String(16), default="")
    warranty_expiry: Mapped[str] = mapped_column(String(16), default="")  # sale date + warranty period
    issue_description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open | approved | rejected | repaired | replaced | closed
    resolution_notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
