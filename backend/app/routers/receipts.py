"""Thermal receipt (ESC/POS) generation for sale invoices."""
from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user
from ..database import get_db
from ..models import Sale, Setting

router = APIRouter(prefix="/api/receipts", tags=["receipts"])

ESC = b"\x1b"
GS = b"\x1d"


def _s(db: Session, key: str, default: str = "") -> str:
    row = db.query(Setting).filter(Setting.key == key).first()
    return (row.value if row else default) or default


def build_escpos(sale: Sale, company: str, pos_name: str, currency: str = "LYD") -> bytes:
    try:
        items = json.loads(sale.items_json or "[]")
    except Exception:
        items = []

    out = bytearray()
    out += ESC + b"@"
    out += ESC + b"a" + bytes([1])  # center
    out += ESC + b"!" + bytes([0x30])  # double size
    out += (company or "ANTA Shoes").encode("utf-8", "replace") + b"\n"
    out += ESC + b"!" + bytes([0])
    out += (pos_name or sale.store or "POS").encode("utf-8", "replace") + b"\n"
    out += ESC + b"a" + bytes([0])  # left
    out += b"-" * 32 + b"\n"
    out += f"Invoice: {sale.invoice_id}\n".encode("utf-8", "replace")
    out += f"Date: {sale.date} {sale.time}\n".encode("utf-8", "replace")
    out += f"Store: {sale.store}\n".encode("utf-8", "replace")
    out += f"Customer: {sale.customer}\n".encode("utf-8", "replace")
    out += b"-" * 32 + b"\n"
    for it in items:
        name = str(it.get("name") or it.get("barcode") or "")[:20]
        qty = int(it.get("qty") or 1)
        price = float(it.get("price") or 0)
        disc = float(it.get("discount") or 0)
        if it.get("lineTotal") is not None:
            line_total = float(it.get("lineTotal") or 0)
        else:
            line_total = qty * price - disc
        out += f"{name}\n".encode("utf-8", "replace")
        out += f" {qty} x {price:.2f} -{disc:.2f} = {line_total:.2f}\n".encode("utf-8", "replace")
    out += b"-" * 32 + b"\n"
    out += f"Subtotal: {float(sale.subtotal or 0):.2f} {currency}\n".encode("utf-8", "replace")
    disc_total = float(sale.discount or 0) + float(sale.global_discount or 0)
    out += f"Discount: {disc_total:.2f}\n".encode("utf-8", "replace")
    out += ESC + b"!" + bytes([0x08])  # bold
    out += f"TOTAL: {float(sale.total or 0):.2f} {currency}\n".encode("utf-8", "replace")
    out += ESC + b"!" + bytes([0])
    out += f"Payment: {sale.payment} {sale.pay_ref or ''}\n".encode("utf-8", "replace")
    out += b"-" * 32 + b"\n"
    out += ESC + b"a" + bytes([1])
    out += "Thank you / شكراً\n".encode("utf-8", "replace")
    out += b"\n\n\n"
    out += GS + b"V" + bytes([0])
    return bytes(out)


@router.get("/sale/{invoice_id}")
def sale_receipt(
    invoice_id: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    fmt: str = "escpos",
):
    q = db.query(Sale).filter(Sale.invoice_id == invoice_id)
    if user.role not in ("admin", "accountant", "manager"):
        q = q.filter(Sale.store_id == user.store_id)
    sale = q.first()
    if not sale:
        raise HTTPException(404, "Invoice not found")
    company = _s(db, "company_name", "ANTA Shoes")
    pos_name = _s(db, "pos_name", sale.store)
    currency = _s(db, "currency", "LYD")
    if fmt == "text":
        data = build_escpos(sale, company, pos_name, currency)
        return {"ok": True, "invoiceId": invoice_id, "bytes": len(data), "preview": data.decode("utf-8", "replace")}
    data = build_escpos(sale, company, pos_name, currency)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{invoice_id}.bin"'},
    )
