"""Customer / Loyalty (CRM) endpoints."""
from __future__ import annotations

import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import Sale
from ..models_crm import Customer
from ..services import loyalty
from ..utils import today_str

router = APIRouter(prefix="/api", tags=["customers"])


class CustomerIn(BaseModel):
    name: str
    phone: str = ""
    email: str = ""
    birthday: str = ""
    notes: str = ""
    homeStoreId: str = ""


def _cust_out(c: Customer, db: Optional[Session] = None) -> dict:
    redeem_value = 0.0
    if db is not None:
        redeem_value = round(float(c.loyalty_points or 0) * loyalty.redeem_value(db), 2)
    return {
        "id": c.customer_id, "name": c.name, "phone": c.phone, "email": c.email,
        "birthday": c.birthday, "notes": c.notes, "loyaltyPoints": c.loyalty_points,
        "loyaltyPointsValue": redeem_value,
        "totalSpent": c.total_spent, "visitCount": c.visit_count,
        "firstVisit": c.first_visit, "lastVisit": c.last_visit,
        "homeStoreId": c.home_store_id, "active": c.active,
    }


@router.get("/customers")
def list_customers(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    q: Optional[str] = None,
    limit: int = 100,
):
    """Search customers by name or phone — used both by the POS checkout
    lookup (typing a phone number) and the HO Customers screen.
    """
    query = db.query(Customer).filter(Customer.active.is_(True))
    if q:
        like = f"%{q}%"
        query = query.filter((Customer.phone.like(like)) | (Customer.name.like(like)))
    rows = query.order_by(Customer.id.desc()).limit(limit).all()
    return {"ok": True, "data": [_cust_out(c, db) for c in rows]}


@router.get("/customers/{customer_id}")
def get_customer(customer_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(get_current_user)]):
    c = db.query(Customer).filter(Customer.customer_id == customer_id).first()
    if not c:
        raise HTTPException(404, "Customer not found")
    sales = (
        db.query(Sale)
        .filter(Sale.customer_id == customer_id, Sale.type == "sale")
        .order_by(Sale.id.desc())
        .limit(100)
        .all()
    )
    history = [
        {"invoice": s.invoice_id, "date": s.date, "store": s.store, "total": s.total, "loyaltyDiscount": s.loyalty_discount, "pointsEarned": s.loyalty_points_earned}
        for s in sales
    ]
    return {"ok": True, **_cust_out(c, db), "purchaseHistory": history}


@router.post("/customers")
def create_customer(body: CustomerIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(get_current_user)]):
    """Any logged-in role (including Cashier) can quick-add a customer at
    checkout — this is meant to take a few seconds, not be a gated admin
    action.
    """
    if not body.name and not body.phone:
        raise HTTPException(400, "Name or phone is required")
    if body.phone:
        existing = db.query(Customer).filter(Customer.phone == body.phone, Customer.active.is_(True)).first()
        if existing:
            return {"ok": True, "status": "existing", "id": existing.customer_id, **_cust_out(existing, db)}
    cid = f"CUST-{int(time.time() * 1000)}"
    c = Customer(
        customer_id=cid, name=body.name or body.phone, phone=body.phone or "", email=body.email or "",
        birthday=body.birthday or "", notes=body.notes or "", home_store_id=body.homeStoreId or user.store_id or "",
    )
    db.add(c)
    db.commit()
    return {"ok": True, "status": "ok", "id": cid, **_cust_out(c, db)}


@router.put("/customers/{customer_id}")
def update_customer(
    customer_id: str, body: CustomerIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    c = db.query(Customer).filter(Customer.customer_id == customer_id).first()
    if not c:
        raise HTTPException(404, "Customer not found")
    c.name = body.name or c.name
    c.phone = body.phone
    c.email = body.email
    c.birthday = body.birthday
    c.notes = body.notes
    if body.homeStoreId:
        c.home_store_id = body.homeStoreId
    db.commit()
    return {"ok": True, "status": "ok"}


@router.delete("/customers/{customer_id}")
def deactivate_customer(customer_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))]):
    c = db.query(Customer).filter(Customer.customer_id == customer_id).first()
    if not c:
        raise HTTPException(404, "Customer not found")
    c.active = False
    db.commit()
    return {"ok": True, "status": "ok"}


@router.get("/customers-top/list")
def top_customers(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    limit: int = 20,
):
    rows = db.query(Customer).filter(Customer.active.is_(True)).order_by(Customer.total_spent.desc()).limit(limit).all()
    return {"ok": True, "data": [_cust_out(c, db) for c in rows]}
