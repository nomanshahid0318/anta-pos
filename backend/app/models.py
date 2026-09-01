"""SQLAlchemy ORM models — full replacement for Google Sheets tables."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _now() -> datetime:
    return datetime.utcnow()


class Store(Base):
    __tablename__ = "stores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    store_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    city: Mapped[str] = mapped_column(String(64), default="")
    address: Mapped[str] = mapped_column(String(255), default="")
    manager: Mapped[str] = mapped_column(String(128), default="")
    phone: Mapped[str] = mapped_column(String(64), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    users: Mapped[list["User"]] = relationship(back_populates="store")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    store_id: Mapped[str] = mapped_column(String(32), ForeignKey("stores.store_id"), index=True)
    store_name: Mapped[str] = mapped_column(String(128), default="")
    name: Mapped[str] = mapped_column(String(128))
    employee_code: Mapped[str] = mapped_column(String(16), index=True, default="")  # a second, unique-per-employee credential required alongside the PIN at login — uniqueness enforced in the API layer (not a DB constraint, since blank/legacy rows can share the default "")
    role: Mapped[str] = mapped_column(String(32), default="cashier")  # admin|manager|cashier|accountant
    pin_hash: Mapped[str] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    pos_login_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # False = payroll/records-only staff, no POS/HO login
    standard_salary: Mapped[float] = mapped_column(Float, default=0.0)  # default monthly base salary, auto-filled into new Payroll entries
    commission_rate: Mapped[float] = mapped_column(Float, default=0.0)  # % of each sale they make, added to Payroll as an Allowance
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    store: Mapped["Store"] = relationship(back_populates="users")


class Bank(Base):
    __tablename__ = "banks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bank_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    account_no: Mapped[str] = mapped_column(String(64), default="")
    device: Mapped[str] = mapped_column(String(128), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    icon: Mapped[str] = mapped_column(String(16), default="💳")


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    barcode: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    brand: Mapped[str] = mapped_column(String(64), default="ANTA")
    category: Mapped[str] = mapped_column(String(64), default="Footwear")
    size: Mapped[str] = mapped_column(String(64), default="")
    color: Mapped[str] = mapped_column(String(64), default="")
    department: Mapped[str] = mapped_column(String(64), default="")
    season: Mapped[str] = mapped_column(String(64), default="")
    gender: Mapped[str] = mapped_column(String(32), default="")
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    retail: Mapped[float] = mapped_column(Float, default=0.0)  # CURRENT selling price — changes over time
    original_price: Mapped[float] = mapped_column(Float, default=0.0)  # price set when FIRST created — stays fixed
    reorder: Mapped[int] = mapped_column(Integer, default=5)
    warranty_days: Mapped[int] = mapped_column(Integer, default=0)  # 0 = no warranty tracked
    serial_tracked: Mapped[bool] = mapped_column(Boolean, default=False)  # if true, each unit needs a serial number at sale time
    opening: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class Inventory(Base):
    """Per-store inventory ledger (mirrors sheet Inventory columns)."""

    __tablename__ = "inventory"
    __table_args__ = (
        UniqueConstraint("barcode", "store_id", name="uq_inv_barcode_store"),
        Index("ix_inv_store", "store_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    store: Mapped[str] = mapped_column(String(128), default="")
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    grn_in: Mapped[int] = mapped_column(Integer, default=0)
    sales_out: Mapped[int] = mapped_column(Integer, default=0)
    returns_in: Mapped[int] = mapped_column(Integer, default=0)
    exch_out: Mapped[int] = mapped_column(Integer, default=0)
    exch_in: Mapped[int] = mapped_column(Integer, default=0)
    claims: Mapped[int] = mapped_column(Integer, default=0)
    adjustments: Mapped[int] = mapped_column(Integer, default=0)  # net +/- from Stock Count corrections
    on_hand: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    def recalc(self) -> None:
        self.on_hand = (
            (self.grn_in or 0)
            - (self.sales_out or 0)
            + (self.returns_in or 0)
            - (self.exch_out or 0)
            + (self.exch_in or 0)
            - (self.claims or 0)
            + (self.adjustments or 0)
        )


class HOWarehouse(Base):
    __tablename__ = "ho_warehouse"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    barcode: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    supplier_in: Mapped[int] = mapped_column(Integer, default=0)
    store_out: Mapped[int] = mapped_column(Integer, default=0)
    on_hand: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    def recalc(self) -> None:
        self.on_hand = (self.supplier_in or 0) - (self.store_out or 0)


class Sale(Base):
    __tablename__ = "sales"
    __table_args__ = (UniqueConstraint("invoice_id", "store_id", name="uq_sale_inv_store"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    invoice_id: Mapped[str] = mapped_column(String(64), index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)  # YYYY-MM-DD
    time: Mapped[str] = mapped_column(String(8), default="")
    store: Mapped[str] = mapped_column(String(128), default="")
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    customer: Mapped[str] = mapped_column(String(128), default="Walk-in")
    customer_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    loyalty_discount: Mapped[float] = mapped_column(Float, default=0.0)
    loyalty_points_earned: Mapped[float] = mapped_column(Float, default=0.0)
    shift_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    items_json: Mapped[str] = mapped_column(Text, default="[]")
    subtotal: Mapped[float] = mapped_column(Float, default=0.0)
    discount: Mapped[float] = mapped_column(Float, default=0.0)
    global_discount: Mapped[float] = mapped_column(Float, default=0.0)
    total: Mapped[float] = mapped_column(Float, default=0.0)
    payment: Mapped[str] = mapped_column(String(64), default="Cash")
    pay_ref: Mapped[str] = mapped_column(String(128), default="")
    type: Mapped[str] = mapped_column(String(16), default="sale")
    source: Mapped[str] = mapped_column(String(24), default="pos")  # pos | excel_import — for audit/reporting
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Return(Base):
    __tablename__ = "returns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ref_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    time: Mapped[str] = mapped_column(String(8), default="")
    store: Mapped[str] = mapped_column(String(128), default="")
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    orig_invoice: Mapped[str] = mapped_column(String(64), default="")
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    product_name: Mapped[str] = mapped_column(String(255), default="")
    qty: Mapped[int] = mapped_column(Integer, default=1)
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    method: Mapped[str] = mapped_column(String(64), default="Cash")
    reason: Mapped[str] = mapped_column(String(255), default="")
    shift_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Exchange(Base):
    __tablename__ = "exchanges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ref_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    time: Mapped[str] = mapped_column(String(8), default="")
    store: Mapped[str] = mapped_column(String(128), default="")
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    customer: Mapped[str] = mapped_column(String(128), default="")
    old_barcode: Mapped[str] = mapped_column(String(64))
    old_name: Mapped[str] = mapped_column(String(255), default="")
    old_qty: Mapped[int] = mapped_column(Integer, default=1)
    new_barcode: Mapped[str] = mapped_column(String(64))
    new_name: Mapped[str] = mapped_column(String(255), default="")
    new_qty: Mapped[int] = mapped_column(Integer, default=1)
    diff: Mapped[float] = mapped_column(Float, default=0.0)
    payment: Mapped[str] = mapped_column(String(64), default="Cash")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Claim(Base):
    __tablename__ = "claims"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ref_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    time: Mapped[str] = mapped_column(String(8), default="")
    store: Mapped[str] = mapped_column(String(128), default="")
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    product_name: Mapped[str] = mapped_column(String(255), default="")
    qty: Mapped[int] = mapped_column(Integer, default=1)
    type: Mapped[str] = mapped_column(String(64), default="Damage")
    value: Mapped[float] = mapped_column(Float, default=0.0)
    supplier: Mapped[str] = mapped_column(String(128), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class CostCenter(Base):
    """A tag for grouping expenses by department/function (e.g. 'Store
    Operations', 'Marketing', 'Admin') so P&L can be sliced by more than
    just store — answers 'where is our overhead actually going', not
    just 'which store spent it'.
    """

    __tablename__ = "cost_centers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Project(Base):
    """A tag for grouping expenses (and optionally revenue) by a
    specific initiative — e.g. 'New Store Fit-out — Store 4', 'Ramadan
    Campaign 2026' — with its own start/end so you can see whether that
    specific initiative actually turned a profit.
    """

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    store_id: Mapped[str] = mapped_column(String(32), default="")
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | closed
    start_date: Mapped[str] = mapped_column(String(16), default="")
    end_date: Mapped[str] = mapped_column(String(16), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Expense(Base):
    __tablename__ = "expenses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    exp_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    store_id: Mapped[str] = mapped_column(String(32), index=True, default="HO")
    store: Mapped[str] = mapped_column(String(128), default="HO")
    category: Mapped[str] = mapped_column(String(64), default="")
    sub_category: Mapped[str] = mapped_column(String(64), default="")
    description: Mapped[str] = mapped_column(String(255), default="")
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    pay_method: Mapped[str] = mapped_column(String(64), default="Cash")
    reference: Mapped[str] = mapped_column(String(128), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    cost_center_id: Mapped[str] = mapped_column(String(32), default="")
    project_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class SupplierGRN(Base):
    __tablename__ = "supplier_grn"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    grn_id: Mapped[str] = mapped_column(String(64), index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    supplier: Mapped[str] = mapped_column(String(128), default="")
    invoice_no: Mapped[str] = mapped_column(String(64), default="")
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    qty: Mapped[int] = mapped_column(Integer, default=0)
    unit_cost: Mapped[float] = mapped_column(Float, default=0.0)  # always LYD-equivalent — used by every downstream stock/COGS calculation, unchanged behavior
    total_cost: Mapped[float] = mapped_column(Float, default=0.0)
    currency: Mapped[str] = mapped_column(String(8), default="LYD")
    exchange_rate: Mapped[float] = mapped_column(Float, default=1.0)  # 1 [currency] = this many LYD, at GRN time
    unit_cost_original: Mapped[float] = mapped_column(Float, default=0.0)  # unit_cost in `currency`, before conversion — 0/unused when currency=LYD
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class StoreGRN(Base):
    __tablename__ = "store_grn"
    __table_args__ = (Index("ix_store_grn_status", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    grn_id: Mapped[str] = mapped_column(String(64), index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    store_name: Mapped[str] = mapped_column(String(128), default="")
    barcode: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    qty_issued: Mapped[int] = mapped_column(Integer, default=0)
    qty_received: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending|received
    notes: Mapped[str] = mapped_column(Text, default="")
    issued_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    received_by: Mapped[str] = mapped_column(String(128), default="")


class CashHandover(Base):
    __tablename__ = "cash_handovers"
    __table_args__ = (Index("ix_cash_handover_status", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    handover_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)  # business day, YYYY-MM-DD
    store_id: Mapped[str] = mapped_column(String(32), index=True)
    store_name: Mapped[str] = mapped_column(String(128), default="")
    invoice_count: Mapped[int] = mapped_column(Integer, default=0)
    units_sold: Mapped[int] = mapped_column(Integer, default=0)
    total_sales: Mapped[float] = mapped_column(Float, default=0.0)
    cash_sales: Mapped[float] = mapped_column(Float, default=0.0)
    bank_sales_json: Mapped[str] = mapped_column(Text, default="[]")  # [{bank, amount}]
    returns_total: Mapped[float] = mapped_column(Float, default=0.0)
    submitted_by: Mapped[str] = mapped_column(String(128), default="")
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending|received
    counted_cash: Mapped[float | None] = mapped_column(Float, nullable=True)
    variance: Mapped[float | None] = mapped_column(Float, nullable=True)
    variance_notes: Mapped[str] = mapped_column(Text, default="")
    received_by: Mapped[str] = mapped_column(String(128), default="")
    received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Transfer(Base):
    __tablename__ = "transfers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ref_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    from_store_id: Mapped[str] = mapped_column(String(32))
    from_store: Mapped[str] = mapped_column(String(128), default="")
    to_store_id: Mapped[str] = mapped_column(String(32))
    to_store: Mapped[str] = mapped_column(String(128), default="")
    barcode: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(255), default="")
    qty: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(32), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Setting(Base):
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    value: Mapped[str] = mapped_column(Text, default="")


class InvoiceCounter(Base):
    __tablename__ = "invoice_counters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    store_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    next_inv: Mapped[int] = mapped_column(Integer, default=1)


class SyncLog(Base):
    __tablename__ = "sync_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=_now)
    action: Mapped[str] = mapped_column(String(64))
    store: Mapped[str] = mapped_column(String(128), default="")
    status: Mapped[str] = mapped_column(String(64), default="")


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    type: Mapped[str] = mapped_column(String(32), default="asset")  # asset|liability|equity|income|expense
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class JournalEntry(Base):
    __tablename__ = "journal_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    date: Mapped[str] = mapped_column(String(16), index=True)
    memo: Mapped[str] = mapped_column(String(255), default="")
    source_type: Mapped[str] = mapped_column(String(32), default="")  # sale|expense|manual
    source_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    posted: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class JournalLine(Base):
    __tablename__ = "journal_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entry_id: Mapped[int] = mapped_column(Integer, ForeignKey("journal_entries.id"), index=True)
    account_id: Mapped[int] = mapped_column(Integer, ForeignKey("accounts.id"), index=True)
    debit: Mapped[float] = mapped_column(Float, default=0.0)
    credit: Mapped[float] = mapped_column(Float, default=0.0)
    memo: Mapped[str] = mapped_column(String(255), default="")


class Promotion(Base):
    __tablename__ = "promotions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    promo_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    type: Mapped[str] = mapped_column(String(32))  # b1g1|b2g1|percent|fixed|invoice_percent|invoice_fixed
    value: Mapped[float] = mapped_column(Float, default=0.0)
    target_type: Mapped[str] = mapped_column(String(32), default="all")  # all|barcode|name_contains|invoice
    target_value: Mapped[str] = mapped_column(String(128), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    start_date: Mapped[str] = mapped_column(String(16), default="")
    end_date: Mapped[str] = mapped_column(String(16), default="")
    start_time: Mapped[str] = mapped_column(String(8), default="")
    end_time: Mapped[str] = mapped_column(String(8), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

