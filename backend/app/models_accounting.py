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
    currency: Mapped[str] = mapped_column(String(8), default="LYD")
    exchange_rate: Mapped[float] = mapped_column(Float, default=1.0)
    amount_original: Mapped[float] = mapped_column(Float, default=0.0)  # amount in `currency`, before conversion
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


class PrepaidExpense(Base):
    """A payment made now that covers future months (billboard/advertising
    paid upfront, prepaid rent, insurance, licenses, subscriptions, etc.).
    Recorded as an asset at payment time, then recognized into P&L expense
    evenly, one month at a time, over the coverage period — instead of
    hitting the whole amount as a one-time expense in the month it was
    paid, which would understate that month's real profit and overstate
    later months'.
    """

    __tablename__ = "prepaid_expenses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prepaid_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    category: Mapped[str] = mapped_column(String(64), default="Other")  # Advertising, Rent, Insurance, License, Subscription, Other
    store_id: Mapped[str] = mapped_column(String(32), default="HO")
    start_date: Mapped[str] = mapped_column(String(16))
    total_amount: Mapped[float] = mapped_column(Float, default=0.0)
    months: Mapped[int] = mapped_column(Integer, default=1)
    pay_method: Mapped[str] = mapped_column(String(32), default="Cash")
    notes: Mapped[str] = mapped_column(Text, default="")
    cf_item_id: Mapped[str] = mapped_column(String(64), default="")
    written_off: Mapped[bool] = mapped_column(Boolean, default=False)
    disposed_date: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class EmployeeAdvance(Base):
    """Cash advanced or loaned to an employee. This is NOT an expense — the
    company expects it back (in cash or deducted from salary), so it's
    recorded as a receivable (Current Asset), not a cost. Only if it's
    ever formally written off (employee left without repaying, etc.) does
    the unpaid remainder become a real Bad Debt expense.
    """

    __tablename__ = "employee_advances"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    advance_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    employee_name: Mapped[str] = mapped_column(String(128))
    store_id: Mapped[str] = mapped_column(String(32), default="HO")
    date: Mapped[str] = mapped_column(String(16))
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    repaid_amount: Mapped[float] = mapped_column(Float, default=0.0)
    reason: Mapped[str] = mapped_column(String(255), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    cf_item_id: Mapped[str] = mapped_column(String(64), default="")
    written_off: Mapped[bool] = mapped_column(Boolean, default=False)
    written_off_date: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class EmployeeAdvanceRepayment(Base):
    """One repayment (cash handed back, or deducted from a salary run)
    against an EmployeeAdvance — kept as its own ledger so there's a full
    history, not just a running total.
    """

    __tablename__ = "employee_advance_repayments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    repayment_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    advance_id: Mapped[str] = mapped_column(String(64), index=True)
    date: Mapped[str] = mapped_column(String(16))
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    method: Mapped[str] = mapped_column(String(32), default="Cash")  # Cash | Salary Deduction
    notes: Mapped[str] = mapped_column(String(255), default="")
    cf_item_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class AccruedExpense(Base):
    """Expense already incurred (benefit/service already used) but not yet
    paid or billed — the mirror image of a Prepaid Expense. E.g. this
    month's electricity was used but the bill hasn't arrived/been paid
    yet. Recorded as a Liability now; when actually paid, it's settled
    (removed) without hitting P&L again — the expense was already
    recognized when accrued.
    """

    __tablename__ = "accrued_expenses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    accrual_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    category: Mapped[str] = mapped_column(String(64), default="Other")
    store_id: Mapped[str] = mapped_column(String(32), default="HO")
    date: Mapped[str] = mapped_column(String(16))
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str] = mapped_column(Text, default="")
    settled: Mapped[bool] = mapped_column(Boolean, default=False)
    settled_date: Mapped[str] = mapped_column(String(16), default="")
    exp_id: Mapped[str] = mapped_column(String(64), default="")  # linked Expense row (for P&L)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class SupplierInvoice(Base):
    """The supplier's actual bill for a Purchase Order — entered
    independently of what was received, so it can be compared against
    both the PO (what was ordered) and the GRN (what was actually
    received) before payment is approved. This is the "Three-Way Match":
    PO qty/cost vs GRN received qty vs Invoice billed qty/cost — any
    mismatch (e.g. supplier bills for 100 units, only 95 arrived) gets
    flagged instead of silently passing through to payment.
    """

    __tablename__ = "supplier_invoices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    po_id: Mapped[str] = mapped_column(String(64), index=True)
    supplier_id: Mapped[str] = mapped_column(String(64), index=True)
    supplier_name: Mapped[str] = mapped_column(String(128), default="")
    invoice_number: Mapped[str] = mapped_column(String(128), default="")  # the supplier's own document reference
    date: Mapped[str] = mapped_column(String(16))
    total_amount: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)  # pending | approved | disputed
    approved_by: Mapped[str] = mapped_column(String(128), default="")
    approved_date: Mapped[str] = mapped_column(String(16), default="")
    override_reason: Mapped[str] = mapped_column(Text, default="")  # required if approved despite a discrepancy
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class SupplierInvoiceLine(Base):
    __tablename__ = "supplier_invoice_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[str] = mapped_column(String(64), index=True)
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    qty_billed: Mapped[int] = mapped_column(Integer, default=0)
    unit_cost_billed: Mapped[float] = mapped_column(Float, default=0.0)


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
