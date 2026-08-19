"""Sales, returns, exchanges, claims."""
from __future__ import annotations

import json
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import Claim, Exchange, InvoiceCounter, Return, Sale
from ..models_crm import Customer
from ..schemas import (
    ClaimIn,
    ExchangeIn,
    ReturnIn,
    SaleIn,
    SaleOut,
)
from ..services import loyalty
from ..services.accounting import post_sale_journal
from ..services.inventory import update_inv
from ..services.promotions import apply_promotions
from ..utils import time_str, today_str

router = APIRouter(prefix="/api", tags=["transactions"])


def _next_invoice(db: Session, store_id: str) -> str:
    row = db.query(InvoiceCounter).filter(InvoiceCounter.store_id == store_id).first()
    if not row:
        row = InvoiceCounter(store_id=store_id, next_inv=1)
        db.add(row)
        db.flush()
    n = row.next_inv
    row.next_inv = n + 1
    prefix = (store_id or "S1").upper()
    return f"{prefix}-{n:04d}"


def _sale_to_out(s: Sale) -> dict:
    try:
        items = json.loads(s.items_json or "[]")
    except Exception:
        items = []
    return {
        "id": s.invoice_id,
        "date": s.date,
        "time": s.time,
        "store": s.store,
        "storeId": s.store_id,
        "customer": s.customer,
        "customerId": s.customer_id or "",
        "loyaltyDiscount": s.loyalty_discount or 0,
        "loyaltyPointsEarned": s.loyalty_points_earned or 0,
        "items": items,
        "subtotal": s.subtotal,
        "discount": s.discount,
        "globalDiscount": s.global_discount,
        "total": s.total,
        "payment": s.payment,
        "payRef": s.pay_ref,
        "type": s.type,
        "synced": True,
    }


@router.post("/sales")
def create_sale(
    body: SaleIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    store_id = body.storeId or user.store_id
    store = body.store or user.store_name
    inv_id = body.id or _next_invoice(db, store_id)

    existing = (
        db.query(Sale)
        .filter(Sale.invoice_id == inv_id, Sale.store_id == store_id)
        .first()
    )
    if existing:
        return {"ok": True, "status": "duplicate", "id": inv_id, "sale": _sale_to_out(existing)}

    date = body.date or today_str()
    time_ = body.time or time_str()
    raw_items = [i.model_dump() for i in body.items]
    priced = apply_promotions(db, raw_items, body.globalDiscount or 0)
    # Prefer server promo math when cart discounts empty / lower
    items = priced["items"]
    subtotal = body.subtotal or priced["subtotal"]
    discount = max(float(body.discount or 0), float(priced["discount"] or 0))
    global_discount = max(float(body.globalDiscount or 0), float(priced["globalDiscount"] or 0))
    total = body.total if body.total and body.total > 0 else priced["total"]
    # If client total diverges a lot, trust server promo total when promos applied
    if priced.get("promoNotes") and abs(float(body.total or 0) - float(priced["total"])) > 0.01:
        subtotal, discount, global_discount, total = (
            priced["subtotal"], priced["discount"], priced["globalDiscount"], priced["total"]
        )

    # Loyalty: look up the customer (if one was selected/scanned at
    # checkout), apply a points redemption as an extra discount on top of
    # everything else, then — once the sale is saved — award new points
    # on the net amount actually paid and update their visit stats.
    customer = None
    loyalty_discount = 0.0
    redeemed_points = 0.0
    if body.customerId:
        customer = db.query(Customer).filter(Customer.customer_id == body.customerId, Customer.active.is_(True)).first()
        if customer and body.redeemPoints and body.redeemPoints > 0:
            redeemed_points = min(float(body.redeemPoints), float(customer.loyalty_points or 0))
            loyalty_discount = round(redeemed_points * loyalty.redeem_value(db), 2)
            if loyalty_discount > total:
                # Capped by the sale total — recompute the points actually
                # "spent" for that capped discount, so we don't deduct more
                # points than the discount they actually received.
                loyalty_discount = total
                redeemed_points = round(loyalty_discount / max(loyalty.redeem_value(db), 0.0001), 2)
            total = round(total - loyalty_discount, 2)

    sale = Sale(
        invoice_id=inv_id,
        date=date,
        time=time_,
        store=store,
        store_id=store_id,
        customer=body.customer or (customer.name if customer else "Walk-in"),
        customer_id=body.customerId or "",
        loyalty_discount=loyalty_discount,
        items_json=json.dumps(items),
        subtotal=subtotal,
        discount=discount,
        global_discount=global_discount,
        total=total,
        payment=body.payment or "Cash",
        pay_ref=body.payRef or "",
        type="sale",
    )
    db.add(sale)
    for item in items:
        update_inv(
            db,
            item.get("barcode") or "",
            store,
            store_id,
            item.get("name") or "",
            "sale",
            int(item.get("qty") or 1),
        )
    if customer:
        earned = round(total * loyalty.earn_rate(db), 2)
        customer.loyalty_points = round(max(float(customer.loyalty_points or 0) - redeemed_points + earned, 0), 2)
        customer.total_spent = round(float(customer.total_spent or 0) + total, 2)
        customer.visit_count = int(customer.visit_count or 0) + 1
        customer.last_visit = date
        if not customer.first_visit:
            customer.first_visit = date
        sale.loyalty_points_earned = earned
    post_sale_journal(db, sale)
    db.commit()
    db.refresh(sale)
    out = _sale_to_out(sale)
    out["promoNotes"] = priced.get("promoNotes") or []
    return {"ok": True, "status": "ok", "id": inv_id, "sale": out}


@router.get("/sales")
def list_sales(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    store: Optional[str] = None,
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    limit: int = 200,
):
    q = db.query(Sale)
    sid = store or (None if user.is_admin else user.store_id)
    if sid and sid != "all":
        q = q.filter(Sale.store_id == sid)
    if date_from:
        q = q.filter(Sale.date >= date_from)
    if date_to:
        q = q.filter(Sale.date <= date_to)
    rows = q.order_by(Sale.id.desc()).limit(limit).all()
    return {"ok": True, "data": [_sale_to_out(s) for s in rows]}


@router.post("/returns")
def create_return(
    body: ReturnIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    store_id = body.storeId or user.store_id
    store = body.store or user.store_name
    ref = body.ref or f"RET-{int(__import__('time').time() * 1000)}"
    if db.query(Return).filter(Return.ref_id == ref).first():
        return {"ok": True, "status": "duplicate", "ref": ref}

    row = Return(
        ref_id=ref,
        date=body.date or today_str(),
        time=body.time or time_str(),
        store=store,
        store_id=store_id,
        orig_invoice=body.origInvoice or "",
        barcode=body.barcode,
        product_name=body.productName or "",
        qty=body.qty or 1,
        amount=body.amount or 0,
        method=body.method or "Cash",
        reason=body.reason or "",
    )
    db.add(row)
    update_inv(db, body.barcode, store, store_id, body.productName or "", "return", body.qty or 1)
    db.commit()
    return {"ok": True, "status": "ok", "ref": ref}


@router.get("/returns")
def list_returns(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: int = 100,
):
    q = db.query(Return)
    if not user.is_admin:
        q = q.filter(Return.store_id == user.store_id)
    rows = q.order_by(Return.id.desc()).limit(limit).all()
    data = [
        {
            "ref": r.ref_id,
            "date": r.date,
            "time": r.time,
            "store": r.store,
            "storeId": r.store_id,
            "origInvoice": r.orig_invoice,
            "barcode": r.barcode,
            "productName": r.product_name,
            "qty": r.qty,
            "amount": r.amount,
            "method": r.method,
            "reason": r.reason,
            "synced": True,
        }
        for r in rows
    ]
    return {"ok": True, "data": data}


@router.post("/exchanges")
def create_exchange(
    body: ExchangeIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    store_id = body.storeId or user.store_id
    store = body.store or user.store_name
    ref = body.ref or f"EXC-{int(__import__('time').time() * 1000)}"
    if db.query(Exchange).filter(Exchange.ref_id == ref).first():
        return {"ok": True, "status": "duplicate", "ref": ref}

    row = Exchange(
        ref_id=ref,
        date=body.date or today_str(),
        time=body.time or time_str(),
        store=store,
        store_id=store_id,
        customer=body.customer or "Walk-in",
        old_barcode=body.oldBarcode,
        old_name=body.oldName or "",
        old_qty=body.oldQty or 1,
        new_barcode=body.newBarcode,
        new_name=body.newName or "",
        new_qty=body.newQty or 1,
        diff=body.diff or 0,
        payment=body.payment or "Cash",
    )
    db.add(row)
    update_inv(db, body.oldBarcode, store, store_id, body.oldName or "", "return", body.oldQty or 1)
    update_inv(db, body.newBarcode, store, store_id, body.newName or "", "sale", body.newQty or 1)
    db.commit()
    return {"ok": True, "status": "ok", "ref": ref}


@router.get("/exchanges")
def list_exchanges(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: int = 100,
):
    q = db.query(Exchange)
    if not user.is_admin:
        q = q.filter(Exchange.store_id == user.store_id)
    rows = q.order_by(Exchange.id.desc()).limit(limit).all()
    data = [
        {
            "ref": r.ref_id,
            "date": r.date,
            "time": r.time,
            "store": r.store,
            "storeId": r.store_id,
            "customer": r.customer,
            "oldBarcode": r.old_barcode,
            "oldName": r.old_name,
            "oldQty": r.old_qty,
            "newBarcode": r.new_barcode,
            "newName": r.new_name,
            "newQty": r.new_qty,
            "diff": r.diff,
            "payment": r.payment,
            "synced": True,
        }
        for r in rows
    ]
    return {"ok": True, "data": data}


@router.post("/claims")
def create_claim(
    body: ClaimIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    store_id = body.storeId or user.store_id
    store = body.store or user.store_name
    ref = body.ref or f"CLM-{int(__import__('time').time() * 1000)}"
    if db.query(Claim).filter(Claim.ref_id == ref).first():
        return {"ok": True, "status": "duplicate", "ref": ref}

    row = Claim(
        ref_id=ref,
        date=body.date or today_str(),
        time=body.time or time_str(),
        store=store,
        store_id=store_id,
        barcode=body.barcode,
        product_name=body.productName or "",
        qty=body.qty or 1,
        type=body.type or "Damage",
        value=body.value or 0,
        supplier=body.supplier or "",
        notes=body.notes or "",
    )
    db.add(row)
    update_inv(db, body.barcode, store, store_id, body.productName or "", "claim", body.qty or 1)
    db.commit()
    return {"ok": True, "status": "ok", "ref": ref}


@router.get("/claims")
def list_claims(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    limit: int = 100,
):
    q = db.query(Claim)
    if not user.is_admin:
        q = q.filter(Claim.store_id == user.store_id)
    rows = q.order_by(Claim.id.desc()).limit(limit).all()
    data = [
        {
            "ref": r.ref_id,
            "date": r.date,
            "time": r.time,
            "store": r.store,
            "storeId": r.store_id,
            "barcode": r.barcode,
            "productName": r.product_name,
            "qty": r.qty,
            "type": r.type,
            "value": r.value,
            "supplier": r.supplier,
            "notes": r.notes,
            "synced": True,
        }
        for r in rows
    ]
    return {"ok": True, "data": data}


