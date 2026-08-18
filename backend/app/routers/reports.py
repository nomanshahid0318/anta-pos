"""Dashboard and reports."""
from __future__ import annotations

import json
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user
from ..database import get_db
from ..models import Inventory, Product, Return, Sale, Setting
from ..schemas import DashboardOut, ReportOut, SettingsIn
from ..services.inventory import get_stock
from ..utils import iso_now, today_str

router = APIRouter(prefix="/api", tags=["reports"])


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    store: Optional[str] = None,
):
    sid = store or (None if user.is_admin and user.store_id == "HO" else user.store_id)
    sales_q = db.query(Sale)
    ret_q = db.query(Return)
    if sid and sid not in ("all", "HO"):
        sales_q = sales_q.filter(Sale.store_id == sid)
        ret_q = ret_q.filter(Return.store_id == sid)

    sales = sales_q.all()
    rets = ret_q.all()
    today = today_str()

    total_rev = sum(s.total or 0 for s in sales)
    total_ret = sum(r.amount or 0 for r in rets)
    total_inv = len(sales)
    today_sales = [s for s in sales if s.date == today]
    today_rev = sum(s.total or 0 for s in today_sales)
    cash_today = sum(s.total or 0 for s in today_sales if (s.payment or "") == "Cash")
    qty_sold = 0
    for s in today_sales:
        try:
            items = json.loads(s.items_json or "[]")
            qty_sold += sum(int(i.get("qty") or 0) for i in items)
        except Exception:
            pass

    # store breakdown (admin)
    store_map: dict = {}
    for s in db.query(Sale).all():
        k = s.store_id or s.store
        if k not in store_map:
            store_map[k] = {"store": k, "name": s.store, "revenue": 0, "invoices": 0, "returns": 0}
        store_map[k]["revenue"] += s.total or 0
        store_map[k]["invoices"] += 1
    for r in db.query(Return).all():
        k = r.store_id or r.store
        if k in store_map:
            store_map[k]["returns"] += r.amount or 0

    pay_map: dict = {}
    for s in (today_sales if sid else sales):
        pay_map[s.payment] = pay_map.get(s.payment, 0) + (s.total or 0)

    # low stock
    low = []
    products = db.query(Product).filter(Product.active.is_(True)).all()
    target_store = sid if sid and sid not in ("all", "HO") else user.store_id
    if target_store and target_store != "HO":
        for p in products:
            oh = get_stock(db, p.barcode, target_store)
            if oh <= (p.reorder or 5):
                low.append(
                    {
                        "barcode": p.barcode,
                        "name": p.name,
                        "store": target_store,
                        "onHand": oh,
                        "reorder": p.reorder or 5,
                    }
                )

    recent = sorted(sales, key=lambda x: x.id, reverse=True)[:10]

    return DashboardOut(
        totalRevenue=total_rev,
        totalInvoices=total_inv,
        totalReturns=total_ret,
        netRevenue=total_rev - total_ret,
        atv=(total_rev / total_inv) if total_inv else 0,
        todayRevenue=today_rev,
        todayInvoices=len(today_sales),
        qtySold=qty_sold,
        cashToday=cash_today,
        storeBreakdown=list(store_map.values()),
        paymentBreakdown=pay_map,
        lowStock=low[:20],
        recentSales=[
            {
                "id": s.invoice_id,
                "date": s.date,
                "time": s.time,
                "customer": s.customer,
                "payment": s.payment,
                "total": s.total,
                "synced": True,
            }
            for s in recent
        ],
        lastUpdated=iso_now(),
    )


@router.get("/reports", response_model=ReportOut)
def reports(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    store: Optional[str] = None,
):
    q = db.query(Sale)
    rq = db.query(Return)
    sid = store or (None if user.is_admin and user.store_id == "HO" else user.store_id)
    if sid and sid not in ("all", "HO"):
        q = q.filter(Sale.store_id == sid)
        rq = rq.filter(Return.store_id == sid)
    if date_from:
        q = q.filter(Sale.date >= date_from)
        rq = rq.filter(Return.date >= date_from)
    if date_to:
        q = q.filter(Sale.date <= date_to)
        rq = rq.filter(Return.date <= date_to)

    sales = q.order_by(Sale.id.desc()).all()
    rets = rq.all()
    rev = sum(s.total or 0 for s in sales)
    ret_amt = sum(r.amount or 0 for r in rets)
    inv = len(sales)

    pay_map: dict = {}
    prod_map: dict = {}
    units = 0
    txns = []
    for s in sales:
        pay_map[s.payment] = pay_map.get(s.payment, 0) + (s.total or 0)
        try:
            items = json.loads(s.items_json or "[]")
        except Exception:
            items = []
        txn_units = 0
        txn_cost = 0.0
        item_names = []
        for i in items:
            barcode = i.get("barcode") or ""
            name = i.get("name") or barcode or "?"
            qty = int(i.get("qty") or 0)
            price = float(i.get("price") or 0)
            cost = float(i.get("cost") or 0)
            lt = float(i.get("lineTotal") if i.get("lineTotal") is not None else price * qty)
            units += qty
            txn_units += qty
            txn_cost += cost * qty
            item_names.append(f"{name} x{qty}")
            key = barcode or name
            if key not in prod_map:
                prod_map[key] = {"barcode": barcode, "name": name, "qty": 0, "revenue": 0, "cost": 0, "profit": 0}
            prod_map[key]["qty"] += qty
            prod_map[key]["revenue"] += lt
            prod_map[key]["cost"] += cost * qty
            prod_map[key]["profit"] += lt - cost * qty
        line_disc = float(s.discount or 0) + float(s.global_discount or 0)
        gross = float(s.total or 0)
        profit = gross - txn_cost
        txns.append(
            {
                "id": s.invoice_id,
                "date": s.date,
                "time": s.time,
                "store": s.store,
                "storeId": s.store_id,
                "customer": s.customer,
                "payment": s.payment,
                "payRef": s.pay_ref,
                "items": len(items),
                "units": txn_units,
                "productList": "; ".join(item_names)[:180],
                "subtotal": float(s.subtotal or 0),
                "discount": round(line_disc, 2),
                "cost": round(txn_cost, 2),
                "profit": round(profit, 2),
                "margin": round((profit / gross * 100) if gross else 0, 1),
                "total": gross,
                "type": s.type,
                "synced": True,
            }
        )

    products = sorted(prod_map.values(), key=lambda x: x["revenue"], reverse=True)[:50]
    total_cost = round(sum(p.get("cost", 0) for p in prod_map.values()), 2)
    total_profit = round(rev - total_cost, 2)
    return ReportOut(
        revenue=rev,
        returns=ret_amt,
        net=rev - ret_amt,
        invoices=inv,
        atv=(rev / inv) if inv else 0,
        units=units,
        totalCost=total_cost,
        totalProfit=total_profit,
        margin=round((total_profit / rev * 100) if rev else 0, 1),
        paymentBreakdown=pay_map,
        productBreakdown=products,
        transactions=txns[:200],
    )


@router.get("/settings")
def get_settings_api(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    rows = {s.key: s.value for s in db.query(Setting).all()}
    return {
        "ok": True,
        "policy": rows.get("policy", "Exchange within 7 days with receipt."),
        "currency": rows.get("currency", "LYD"),
        "company_name": rows.get("company_name", "ANTA Shoes"),
        "storeId": user.store_id,
        "storeName": user.store_name,
    }


@router.put("/settings")
def put_settings(
    body: SettingsIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    def upsert(key: str, value: str):
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(Setting(key=key, value=value))

    if body.policy is not None:
        upsert("policy", body.policy)
    if body.currency is not None:
        upsert("currency", body.currency)
    if body.storeName is not None and user.is_admin:
        upsert("default_store_name", body.storeName)
    db.commit()
    return {"ok": True, "status": "ok"}
