"""Cheque Management, Budget vs Actual, Sales Commission, Item Serial
Numbers, Warranty Claims, and Customer Account Statement.
"""
from __future__ import annotations

import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import CurrentUser, require_role
from ..database import get_db
from ..models import Expense, Product, Sale, User
from ..models_addons import Budget, Cheque, ItemSerial, SalesCommission, WarrantyClaim
from ..models_crm import Customer
from ..utils import today_str

router = APIRouter(prefix="/api", tags=["addons"])


# ---------------- Cheques ----------------

class ChequeIn(BaseModel):
    direction: str  # receivable | payable
    chequeNumber: str = ""
    bankName: str = ""
    partyName: str = ""
    partyType: str = ""
    amount: float
    issueDate: str = ""
    dueDate: str
    storeId: str = "HO"
    notes: str = ""


def _cheque_out(c: Cheque) -> dict:
    return {
        "id": c.cheque_id, "direction": c.direction, "chequeNumber": c.cheque_number, "bankName": c.bank_name,
        "partyName": c.party_name, "partyType": c.party_type, "amount": c.amount, "issueDate": c.issue_date,
        "dueDate": c.due_date, "status": c.status, "storeId": c.store_id, "notes": c.notes,
    }


@router.get("/cheques")
def list_cheques(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    direction: Optional[str] = None, status: Optional[str] = None,
):
    q = db.query(Cheque)
    if direction:
        q = q.filter(Cheque.direction == direction)
    if status:
        q = q.filter(Cheque.status == status)
    rows = q.order_by(Cheque.due_date.asc()).all()
    return {"ok": True, "data": [_cheque_out(c) for c in rows]}


@router.get("/cheques/due-soon")
def cheques_due_soon(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    days: int = 7,
):
    from datetime import datetime, timedelta
    today = datetime.utcnow().date()
    cutoff = (today + timedelta(days=days)).isoformat()
    rows = (
        db.query(Cheque)
        .filter(Cheque.status == "pending", Cheque.due_date <= cutoff, Cheque.due_date >= today.isoformat())
        .order_by(Cheque.due_date.asc())
        .all()
    )
    return {"ok": True, "data": [_cheque_out(c) for c in rows]}


@router.post("/cheques")
def create_cheque(body: ChequeIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))]):
    if body.direction not in ("receivable", "payable"):
        raise HTTPException(400, "direction must be receivable or payable")
    cid = f"CHQ-{int(time.time()*1000)}"
    db.add(Cheque(
        cheque_id=cid, direction=body.direction, cheque_number=body.chequeNumber, bank_name=body.bankName,
        party_name=body.partyName, party_type=body.partyType, amount=body.amount,
        issue_date=body.issueDate or today_str(), due_date=body.dueDate, store_id=body.storeId, notes=body.notes,
    ))
    db.commit()
    return {"ok": True, "status": "ok", "id": cid}


@router.put("/cheques/{cheque_id}/status")
def update_cheque_status(
    cheque_id: str, status: str, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
):
    if status not in ("pending", "deposited", "cleared", "bounced", "cancelled"):
        raise HTTPException(400, "Invalid status")
    row = db.query(Cheque).filter(Cheque.cheque_id == cheque_id).first()
    if not row:
        raise HTTPException(404, "Cheque not found")
    from datetime import datetime
    row.status = status
    row.status_updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": "ok"}


# ---------------- Budget vs Actual ----------------

class BudgetIn(BaseModel):
    month: str
    category: str
    storeId: str = ""
    costCenterId: str = ""
    amount: float
    notes: str = ""


@router.get("/ho/budgets")
def list_budgets(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))], month: Optional[str] = None):
    q = db.query(Budget)
    if month:
        q = q.filter(Budget.month == month)
    rows = q.all()
    return {"ok": True, "data": [
        {"id": b.id, "month": b.month, "category": b.category, "storeId": b.store_id, "costCenterId": b.cost_center_id, "amount": b.amount, "notes": b.notes}
        for b in rows
    ]}


@router.post("/ho/budgets")
def set_budget(body: BudgetIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))]):
    existing = db.query(Budget).filter(Budget.month == body.month, Budget.category == body.category, Budget.store_id == body.storeId, Budget.cost_center_id == body.costCenterId).first()
    if existing:
        existing.amount = body.amount
        existing.notes = body.notes
    else:
        db.add(Budget(month=body.month, category=body.category, store_id=body.storeId, cost_center_id=body.costCenterId, amount=body.amount, notes=body.notes))
    db.commit()
    return {"ok": True, "status": "ok"}


@router.delete("/ho/budgets/{budget_id}")
def delete_budget(budget_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin"))]):
    row = db.query(Budget).filter(Budget.id == budget_id).first()
    if row:
        db.delete(row)
        db.commit()
    return {"ok": True, "status": "ok"}


@router.get("/ho/budget-vs-actual")
def budget_vs_actual(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))], month: str):
    budgets = db.query(Budget).filter(Budget.month == month).all()
    expenses = db.query(Expense).filter(Expense.date.like(f"{month}%")).all()

    def _actual_for(category: str, store_id: str, cost_center_id: str) -> float:
        total = 0.0
        for e in expenses:
            if e.category != category:
                continue
            if store_id and (e.store_id or "") != store_id:
                continue
            if cost_center_id and (e.cost_center_id or "") != cost_center_id:
                continue
            total += e.amount or 0
        return round(total, 2)

    out = []
    budgeted_categories = set()
    for b in budgets:
        budgeted_categories.add(b.category)
        actual = _actual_for(b.category, b.store_id, b.cost_center_id)
        out.append({
            "category": b.category, "storeId": b.store_id, "costCenterId": b.cost_center_id,
            "budget": b.amount, "actual": actual, "variance": round(b.amount - actual, 2),
            "variancePercent": round(((b.amount - actual) / b.amount * 100), 1) if b.amount else None,
        })
    # Categories with actual spend but no budget set at all — show them too so nothing's hidden.
    for e in expenses:
        if e.category not in budgeted_categories:
            budgeted_categories.add(e.category)  # only add the "no budget" row once per category
            actual = _actual_for(e.category, "", "")
            out.append({"category": e.category, "storeId": "", "costCenterId": "", "budget": 0, "actual": actual, "variance": round(-actual, 2), "variancePercent": None})
    out.sort(key=lambda d: d["category"])
    return {"ok": True, "month": month, "data": out}


# ---------------- Sales Commission ----------------

@router.get("/ho/sales-commissions")
def list_sales_commissions(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    month: Optional[str] = None, employeeUserId: Optional[str] = None,
):
    q = db.query(SalesCommission)
    if month:
        q = q.filter(SalesCommission.date.like(f"{month}%"))
    if employeeUserId:
        q = q.filter(SalesCommission.employee_user_id == employeeUserId)
    rows = q.order_by(SalesCommission.date.desc()).all()
    total = round(sum(r.commission_amount for r in rows), 2)
    return {"ok": True, "data": [
        {"saleInvoiceId": r.sale_invoice_id, "employeeUserId": r.employee_user_id, "employeeName": r.employee_name,
         "date": r.date, "saleTotal": r.sale_total, "commissionRate": r.commission_rate, "commissionAmount": r.commission_amount}
        for r in rows
    ], "total": total}


def record_sale_commission(db: Session, sale: Sale, cashier_user_id: str) -> None:
    """Called right after a Sale is created — if the cashier has a
    commission rate set, records their cut. Silently does nothing if
    not (so this is safe to call unconditionally from checkout).
    """
    if not cashier_user_id:
        return
    emp = db.query(User).filter(User.user_id == cashier_user_id).first()
    if not emp or not emp.commission_rate:
        return
    amount = round((sale.total or 0) * emp.commission_rate / 100, 2)
    if amount <= 0:
        return
    db.add(SalesCommission(
        sale_invoice_id=sale.invoice_id, employee_user_id=emp.user_id, employee_name=emp.name,
        date=sale.date, sale_total=sale.total or 0, commission_rate=emp.commission_rate, commission_amount=amount,
    ))


# ---------------- Item Serial Numbers ----------------

class SerialBulkIn(BaseModel):
    barcode: str
    serials: list[str]
    storeId: str = ""


@router.post("/item-serials/bulk")
def add_serials(body: SerialBulkIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))]):
    added, skipped = 0, 0
    for s in body.serials:
        s = s.strip()
        if not s:
            continue
        if db.query(ItemSerial).filter(ItemSerial.serial_number == s).first():
            skipped += 1
            continue
        db.add(ItemSerial(barcode=body.barcode, serial_number=s, status="in_stock", store_id=body.storeId))
        added += 1
    db.commit()
    return {"ok": True, "status": "ok", "added": added, "skipped": skipped}


@router.get("/item-serials")
def list_serials(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse", "cashier"))], barcode: str, status: str = "in_stock"):
    rows = db.query(ItemSerial).filter(ItemSerial.barcode == barcode, ItemSerial.status == status).all()
    return {"ok": True, "data": [{"serialNumber": r.serial_number, "status": r.status} for r in rows]}


@router.post("/item-serials/{serial_number}/sell")
def sell_serial(serial_number: str, invoiceId: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "cashier"))]):
    row = db.query(ItemSerial).filter(ItemSerial.serial_number == serial_number).first()
    if not row:
        raise HTTPException(404, "Serial number not found")
    if row.status != "in_stock":
        raise HTTPException(400, f"This serial is already marked '{row.status}'")
    row.status = "sold"
    row.sale_invoice_id = invoiceId
    row.sold_date = today_str()
    db.commit()
    return {"ok": True, "status": "ok"}


@router.get("/item-serials/verify/{serial_number}")
def verify_serial(serial_number: str, db: Annotated[Session, Depends(get_db)]):
    """Public-ish authenticity check — no role required beyond being
    logged in, since this is meant for a customer-facing 'verify your
    ANTA shoes are genuine' lookup.
    """
    row = db.query(ItemSerial).filter(ItemSerial.serial_number == serial_number).first()
    if not row:
        return {"ok": True, "genuine": False, "message": "Serial number not found in our system"}
    product = db.query(Product).filter(Product.barcode == row.barcode).first()
    return {"ok": True, "genuine": True, "productName": product.name if product else row.barcode, "status": row.status, "soldDate": row.sold_date}


# ---------------- Warranty Claims ----------------

class WarrantyClaimIn(BaseModel):
    saleInvoiceId: str
    barcode: str = ""
    itemName: str = ""
    serialNumber: str = ""
    customerName: str = ""
    storeId: str = ""
    issueDescription: str


@router.get("/warranty-claims")
def list_warranty_claims(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))], status: Optional[str] = None):
    q = db.query(WarrantyClaim)
    if status:
        q = q.filter(WarrantyClaim.status == status)
    rows = q.order_by(WarrantyClaim.id.desc()).all()
    return {"ok": True, "data": [
        {"id": c.claim_id, "saleInvoiceId": c.sale_invoice_id, "barcode": c.barcode, "itemName": c.item_name,
         "serialNumber": c.serial_number, "customerName": c.customer_name, "storeId": c.store_id,
         "claimDate": c.claim_date, "warrantyExpiry": c.warranty_expiry, "issueDescription": c.issue_description,
         "status": c.status, "resolutionNotes": c.resolution_notes}
        for c in rows
    ]}


@router.post("/warranty-claims")
def create_warranty_claim(body: WarrantyClaimIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "cashier"))]):
    sale = db.query(Sale).filter(Sale.invoice_id == body.saleInvoiceId).first()
    warranty_expiry = ""
    if sale and body.barcode:
        product = db.query(Product).filter(Product.barcode == body.barcode).first()
        if product and product.warranty_days:
            from datetime import datetime, timedelta
            try:
                sale_date = datetime.strptime(sale.date, "%Y-%m-%d")
                warranty_expiry = (sale_date + timedelta(days=product.warranty_days)).strftime("%Y-%m-%d")
            except ValueError:
                pass
    claim_id = f"WC-{int(time.time()*1000)}"
    db.add(WarrantyClaim(
        claim_id=claim_id, sale_invoice_id=body.saleInvoiceId, barcode=body.barcode, item_name=body.itemName,
        serial_number=body.serialNumber, customer_name=body.customerName, store_id=body.storeId,
        claim_date=today_str(), warranty_expiry=warranty_expiry, issue_description=body.issueDescription,
    ))
    db.commit()
    expired = bool(warranty_expiry and warranty_expiry < today_str())
    return {"ok": True, "status": "ok", "id": claim_id, "warrantyExpiry": warranty_expiry, "warrantyExpired": expired}


@router.put("/warranty-claims/{claim_id}/status")
def update_warranty_status(claim_id: str, status: str, resolutionNotes: str = "", db: Session = Depends(get_db), user: CurrentUser = Depends(require_role("admin", "manager"))):
    if status not in ("open", "approved", "rejected", "repaired", "replaced", "closed"):
        raise HTTPException(400, "Invalid status")
    row = db.query(WarrantyClaim).filter(WarrantyClaim.claim_id == claim_id).first()
    if not row:
        raise HTTPException(404, "Claim not found")
    row.status = status
    if resolutionNotes:
        row.resolution_notes = resolutionNotes
    db.commit()
    return {"ok": True, "status": "ok"}


# ---------------- Customer Account Statement ----------------

@router.get("/ho/customers/{customer_id}/statement")
def customer_statement(customer_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))]):
    cust = db.query(Customer).filter(Customer.customer_id == customer_id).first()
    if not cust:
        raise HTTPException(404, "Customer not found")
    sales = db.query(Sale).filter(Sale.customer_id == customer_id).order_by(Sale.date.asc()).all()
    lines = []
    balance = 0.0
    for s in sales:
        balance += s.total or 0
        lines.append({"date": s.date, "type": "Sale", "reference": s.invoice_id, "debit": s.total or 0, "credit": 0, "balance": round(balance, 2)})
    lines.sort(key=lambda l: l["date"])
    running = 0.0
    for l in lines:
        running += l["debit"] - l["credit"]
        l["balance"] = round(running, 2)
    return {"ok": True, "customerId": customer_id, "customerName": cust.name, "phone": cust.phone, "lines": lines, "closingBalance": round(running, 2)}
