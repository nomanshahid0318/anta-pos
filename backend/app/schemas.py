"""Pydantic schemas for API I/O."""
from __future__ import annotations

from typing import Any, Optional
from pydantic import BaseModel, Field, field_validator


class Ok(BaseModel):
    ok: bool = True
    msg: str = ""


class LoginRequest(BaseModel):
    store_id: str
    pin: str


class TokenResponse(BaseModel):
    ok: bool = True
    access_token: str
    token_type: str = "bearer"
    user: dict


class StoreOut(BaseModel):
    store_id: str
    name: str
    city: str = ""
    address: str = ""
    manager: str = ""
    phone: str = ""
    active: bool = True

    class Config:
        from_attributes = True


class StoreIn(BaseModel):
    store_id: str
    name: str
    city: str = ""
    address: str = ""
    manager: str = ""
    phone: str = ""
    active: bool = True


class UserOut(BaseModel):
    user_id: str
    store_id: str
    store_name: str = ""
    name: str
    role: str
    active: bool = True

    class Config:
        from_attributes = True


class UserIn(BaseModel):
    user_id: Optional[str] = None
    store_id: str
    store_name: str = ""
    name: str
    role: str = "cashier"
    pin: str
    active: bool = True


class BankOut(BaseModel):
    bank_id: str
    name: str
    account_no: str = ""
    device: str = ""
    active: bool = True
    icon: str = "💳"

    class Config:
        from_attributes = True


class BankIn(BaseModel):
    bank_id: Optional[str] = None
    name: str
    account_no: str = ""
    device: str = ""
    active: bool = True
    icon: str = "💳"


class ProductOut(BaseModel):
    barcode: str
    name: str
    brand: str = "ANTA"
    category: str = "Footwear"
    size: str = ""
    color: str = ""
    department: str = ""
    season: str = ""
    gender: str = ""
    cost: float = 0
    retail: float = 0
    originalPrice: float = 0
    reorder: int = 5
    opening: int = 0
    active: bool = True
    stock: Optional[int] = None  # filled per-store when requested

    class Config:
        from_attributes = True


class ProductIn(BaseModel):
    barcode: str
    name: str
    brand: str = "ANTA"
    category: str = "Footwear"
    size: str = ""
    color: str = ""
    department: str = ""
    season: str = ""
    gender: str = ""
    cost: float = 0
    retail: float = 0
    originalPrice: Optional[float] = None
    reorder: int = 5
    opening: int = 0
    active: bool = True
    # Optional: when set, HO Warehouse on-hand stock is set to this exact
    # quantity (used by the Product Master add/edit form and bulk upload).
    qty: Optional[int] = None
    # Optional: previous barcode, sent when a product's barcode is being
    # renamed via the edit form. Product/Inventory/HOWarehouse rows are
    # migrated from old_barcode -> barcode.
    old_barcode: Optional[str] = None

    @field_validator('size', mode='before')
    @classmethod
    def coerce_size_to_string(cls, v):
        """Automatically convert numeric sizes (int, float) to strings."""
        if v is None or v == '':
            return ''
        if isinstance(v, (int, float)):
            return str(v)
        return str(v).strip()

    @field_validator('color', 'department', 'season', 'gender', mode='before')
    @classmethod
    def coerce_string_fields(cls, v):
        """Ensure string fields are properly coerced."""
        if v is None or v == '':
            return ''
        return str(v).strip()


class CartItem(BaseModel):
    barcode: str
    name: str = ""
    qty: int = 1
    price: float = 0
    cost: float = 0
    discount: float = 0
    lineTotal: Optional[float] = None


class SaleIn(BaseModel):
    id: Optional[str] = None  # invoice id; server may generate
    date: Optional[str] = None
    time: Optional[str] = None
    store: Optional[str] = None
    storeId: Optional[str] = None
    customer: str = "Walk-in"
    items: list[CartItem] = Field(default_factory=list)
    subtotal: float = 0
    discount: float = 0
    globalDiscount: float = 0
    total: float = 0
    payment: str = "Cash"
    payRef: str = ""
    type: str = "sale"


class SaleOut(BaseModel):
    id: str
    date: str
    time: str
    store: str
    storeId: str
    customer: str
    items: list[Any]
    subtotal: float
    discount: float
    globalDiscount: float = 0
    total: float
    payment: str
    payRef: str = ""
    type: str = "sale"
    synced: bool = True


class ReturnIn(BaseModel):
    ref: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    store: Optional[str] = None
    storeId: Optional[str] = None
    origInvoice: str = ""
    barcode: str
    productName: str = ""
    qty: int = 1
    amount: float = 0
    method: str = "Cash"
    reason: str = ""


class ExchangeIn(BaseModel):
    ref: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    store: Optional[str] = None
    storeId: Optional[str] = None
    customer: str = "Walk-in"
    oldBarcode: str
    oldName: str = ""
    oldQty: int = 1
    newBarcode: str
    newName: str = ""
    newQty: int = 1
    diff: float = 0
    payment: str = "Cash"


class ClaimIn(BaseModel):
    ref: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    store: Optional[str] = None
    storeId: Optional[str] = None
    barcode: str
    productName: str = ""
    qty: int = 1
    type: str = "Damage"
    value: float = 0
    supplier: str = ""
    notes: str = ""


class ExpenseIn(BaseModel):
    id: Optional[str] = None
    date: Optional[str] = None
    storeId: Optional[str] = None
    store: Optional[str] = None
    category: str
    subCategory: str = ""
    description: str = ""
    amount: float
    payMethod: str = "Cash"
    reference: str = ""
    notes: str = ""


class GRNReceiveIn(BaseModel):
    grnId: str
    barcode: str
    qty: int = 0
    storeId: str
    storeName: str = ""


class GRNIssueLine(BaseModel):
    barcode: str
    name: str = ""
    qty: int = 0


class GRNIssueIn(BaseModel):
    grnId: Optional[str] = None
    date: Optional[str] = None
    storeId: str
    storeName: str = ""
    notes: str = ""
    lines: list[GRNIssueLine]


class SupplierGRNLine(BaseModel):
    barcode: str
    name: str = ""
    qty: int = 0
    cost: float = 0


class SupplierGRNIn(BaseModel):
    grnId: Optional[str] = None
    date: Optional[str] = None
    supplier: str = ""
    invoiceNo: str = ""
    notes: str = ""
    lines: list[SupplierGRNLine]


class SettingsIn(BaseModel):
    storeName: Optional[str] = None
    policy: Optional[str] = None
    currency: Optional[str] = None


class DashboardOut(BaseModel):
    ok: bool = True
    totalRevenue: float = 0
    totalInvoices: int = 0
    totalReturns: float = 0
    netRevenue: float = 0
    atv: float = 0
    todayRevenue: float = 0
    todayInvoices: int = 0
    qtySold: int = 0
    cashToday: float = 0
    storeBreakdown: list[dict] = Field(default_factory=list)
    paymentBreakdown: dict = Field(default_factory=dict)
    lowStock: list[dict] = Field(default_factory=list)
    recentSales: list[dict] = Field(default_factory=list)
    lastUpdated: str = ""


class ReportOut(BaseModel):
    ok: bool = True
    revenue: float = 0
    returns: float = 0
    net: float = 0
    invoices: int = 0
    atv: float = 0
    units: int = 0
    totalCost: float = 0
    totalProfit: float = 0
    margin: float = 0
    paymentBreakdown: dict = Field(default_factory=dict)
    productBreakdown: list[dict] = Field(default_factory=list)
    transactions: list[dict] = Field(default_factory=list)
