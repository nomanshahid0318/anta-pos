"""Purchase Orders — a commitment to buy stock from a supplier, tracked
separately from actually receiving it (Supplier GRN). This is what lets a
payment made today (e.g. an advance, before goods arrive) be recorded now
and matched up with the stock when it physically shows up weeks or months
later, instead of forcing "buy" and "receive" to happen in the same click.
"""
from __future__ import annotations

import time
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import CurrentUser
from ..database import get_db
from ..models_accounting import PurchaseOrder, PurchaseOrderLine, Supplier, SupplierTxn
from ..utils import today_str
from .ho import GRN_CHUNK_SIZE, SGRNIn, SGRNLine, _apply_grn_line, _stock_admin

router = APIRouter(prefix="/api/ho", tags=["purchase-orders"])


class POLineIn(BaseModel):
    barcode: str
    name: str = ""
    qty: int
    cost: float = 0.0


class POIn(BaseModel):
    poId: Optional[str] = None
    date: Optional[str] = None
    expectedDate: Optional[str] = None
    supplierId: str
    notes: str = ""
    lines: list[POLineIn] = Field(default_factory=list)
    advancePaid: float = 0.0  # pay this much to the supplier right now, at PO creation


class POReceiveLine(BaseModel):
    barcode: str
    qty: int  # quantity actually received now for this line (can be less than ordered — partial delivery)


class POReceiveIn(BaseModel):
    date: Optional[str] = None
    lines: Optional[list[POReceiveLine]] = None  # omit to receive everything still outstanding, in full


class POPayIn(BaseModel):
    date: Optional[str] = None
    amount: float
    notes: str = ""


def _po_out(po: PurchaseOrder, lines: list[PurchaseOrderLine]) -> dict:
    total = sum((l.qty_ordered or 0) * (l.unit_cost or 0) for l in lines)
    received_value = sum((l.qty_received or 0) * (l.unit_cost or 0) for l in lines)
    return {
        "id": po.po_id, "date": po.date, "expectedDate": po.expected_date,
        "supplierId": po.supplier_id, "supplierName": po.supplier_name, "status": po.status,
        "notes": po.notes, "advancePaid": po.advance_paid, "total": total, "receivedValue": received_value,
        "balance": total - po.advance_paid,
        "lines": [
            {
                "barcode": l.barcode, "name": l.name, "qtyOrdered": l.qty_ordered,
                "qtyReceived": l.qty_received, "unitCost": l.unit_cost,
                "lineTotal": (l.qty_ordered or 0) * (l.unit_cost or 0),
                "outstanding": max(0, (l.qty_ordered or 0) - (l.qty_received or 0)),
            }
            for l in lines
        ],
    }


@router.post("/purchase-orders")
def create_po(body: POIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_stock_admin)]):
    lines = [l for l in body.lines if l.barcode and l.qty]
    if not lines:
        raise HTTPException(400, "At least one line item is required")
    sup = db.query(Supplier).filter(Supplier.supplier_id == body.supplierId).first()
    if not sup:
        raise HTTPException(404, "Supplier not found")
    poid = body.poId or f"PO-{int(time.time() * 1000)}"
    if db.query(PurchaseOrder).filter(PurchaseOrder.po_id == poid).first():
        raise HTTPException(400, "PO id already exists")
    date = body.date or today_str()
    po = PurchaseOrder(
        po_id=poid, date=date, expected_date=body.expectedDate or "", supplier_id=body.supplierId,
        supplier_name=sup.name, status="open", notes=body.notes or "", advance_paid=0.0,
        created_by=user.user_id if hasattr(user, "user_id") else "",
    )
    db.add(po)
    for l in lines:
        db.add(PurchaseOrderLine(po_id=poid, barcode=l.barcode, name=l.name or "", qty_ordered=int(l.qty or 0), qty_received=0, unit_cost=float(l.cost or 0)))
    if body.advancePaid and body.advancePaid > 0:
        db.add(SupplierTxn(
            txn_id=f"STXN-{int(time.time() * 1000)}", supplier_id=body.supplierId, supplier_name=sup.name,
            date=date, type="payment", amount=body.advancePaid, reference=poid,
            notes=f"Advance payment — PO {poid}", po_id=poid,
        ))
        po.advance_paid = body.advancePaid
    db.commit()
    return {"ok": True, "status": "ok", "id": poid}


@router.get("/purchase-orders")
def list_pos(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_stock_admin)], status: Optional[str] = None):
    q = db.query(PurchaseOrder)
    if status and status != "all":
        q = q.filter(PurchaseOrder.status == status)
    pos = q.order_by(PurchaseOrder.id.desc()).all()
    po_ids = [p.po_id for p in pos]
    all_lines = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id.in_(po_ids)).all() if po_ids else []
    lines_by_po: dict[str, list[PurchaseOrderLine]] = {}
    for l in all_lines:
        lines_by_po.setdefault(l.po_id, []).append(l)
    return {"ok": True, "data": [_po_out(p, lines_by_po.get(p.po_id, [])) for p in pos]}


@router.get("/purchase-orders/{po_id}")
def get_po(po_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_stock_admin)]):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.po_id == po_id).first()
    if not po:
        raise HTTPException(404, "PO not found")
    lines = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id == po_id).all()
    return {"ok": True, **_po_out(po, lines)}


@router.post("/purchase-orders/{po_id}/pay")
def pay_po(po_id: str, body: POPayIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_stock_admin)]):
    """Record an additional payment against an open PO (e.g. the rest of an
    advance, or a deposit made later). Separate from receiving stock.
    """
    po = db.query(PurchaseOrder).filter(PurchaseOrder.po_id == po_id).first()
    if not po:
        raise HTTPException(404, "PO not found")
    if po.status == "cancelled":
        raise HTTPException(400, "PO is cancelled")
    if body.amount <= 0:
        raise HTTPException(400, "Amount must be greater than 0")
    date = body.date or today_str()
    db.add(SupplierTxn(
        txn_id=f"STXN-{int(time.time() * 1000)}", supplier_id=po.supplier_id, supplier_name=po.supplier_name,
        date=date, type="payment", amount=body.amount, reference=po_id,
        notes=body.notes or f"Payment — PO {po_id}", po_id=po_id,
    ))
    po.advance_paid = (po.advance_paid or 0) + body.amount
    db.commit()
    return {"ok": True, "status": "ok"}


@router.post("/purchase-orders/{po_id}/receive")
def receive_po(
    po_id: str, body: POReceiveIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(_stock_admin)],
):
    """Mark stock from this PO as physically received. This is the moment
    the stock and its cost actually enter the system — it posts a real
    Supplier GRN (same weighted-average costing as a normal GRN — see
    _apply_grn_line), adds to HO Warehouse, and creates the supplier
    "invoice" transaction (which nets against any advance already paid).

    Supports partial receiving: pass `lines` with only the barcodes/qty
    actually arriving now; omit `lines` entirely to receive everything
    still outstanding, in full. Can be called more than once on the same
    PO until everything ordered has arrived.
    """
    po = db.query(PurchaseOrder).filter(PurchaseOrder.po_id == po_id).first()
    if not po:
        raise HTTPException(404, "PO not found")
    if po.status == "cancelled":
        raise HTTPException(400, "PO is cancelled")
    if po.status == "received":
        raise HTTPException(400, "PO is already fully received")
    po_lines = {l.barcode: l for l in db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id == po_id).all()}
    if not po_lines:
        raise HTTPException(400, "PO has no line items")

    if body.lines:
        receive_map = {l.barcode: int(l.qty or 0) for l in body.lines if l.barcode and l.qty}
    else:
        receive_map = {bc: max(0, (l.qty_ordered or 0) - (l.qty_received or 0)) for bc, l in po_lines.items()}
        receive_map = {bc: qty for bc, qty in receive_map.items() if qty > 0}
    if not receive_map:
        raise HTTPException(400, "Nothing to receive — all lines already fully received")

    date = body.date or today_str()
    grn_id = f"SGRN-PO-{int(time.time() * 1000)}"
    sgrn_lines = []
    for barcode, qty in receive_map.items():
        line = po_lines.get(barcode)
        if not line:
            raise HTTPException(400, f"Barcode {barcode} is not on this PO")
        outstanding = max(0, (line.qty_ordered or 0) - (line.qty_received or 0))
        if qty > outstanding:
            raise HTTPException(400, f"Cannot receive {qty} of {barcode} — only {outstanding} still outstanding")
        sgrn_lines.append(SGRNLine(barcode=barcode, name=line.name, qty=qty, cost=line.unit_cost))

    grn_body = SGRNIn(grnId=grn_id, date=date, supplier=po.supplier_name, invoiceNo=po_id, notes=f"Received from PO {po_id}", lines=sgrn_lines)
    from ..models import HOWarehouse, Inventory, Product
    from sqlalchemy import func as sa_func

    chunk_barcodes = list(receive_map.keys())
    existing_products = {p.barcode: p for p in db.query(Product).filter(Product.barcode.in_(chunk_barcodes)).all()}
    existing_wh = {w.barcode: w for w in db.query(HOWarehouse).filter(HOWarehouse.barcode.in_(chunk_barcodes)).all()}
    store_qty_map = dict(
        db.query(Inventory.barcode, sa_func.sum(Inventory.on_hand))
        .filter(Inventory.barcode.in_(chunk_barcodes))
        .group_by(Inventory.barcode)
        .all()
    )
    seen_new_barcodes: set = set()
    total_cost = 0.0
    for line in sgrn_lines:
        total_cost += _apply_grn_line(db, grn_id, date, grn_body, line, existing_wh, existing_products, seen_new_barcodes, store_qty_map)

    for barcode, qty in receive_map.items():
        po_lines[barcode].qty_received = (po_lines[barcode].qty_received or 0) + qty

    if total_cost > 0:
        db.add(SupplierTxn(
            txn_id=f"STXN-{int(time.time() * 1000)}", supplier_id=po.supplier_id, supplier_name=po.supplier_name,
            date=date, type="invoice", amount=total_cost, reference=grn_id,
            notes=f"Goods received — PO {po_id}", po_id=po_id,
        ))

    all_lines = list(po_lines.values())
    fully_received = all((l.qty_received or 0) >= (l.qty_ordered or 0) for l in all_lines)
    po.status = "received" if fully_received else "partially_received"
    if fully_received:
        po.received_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": "ok", "grnId": grn_id, "poStatus": po.status, "totalCost": total_cost}


@router.post("/purchase-orders/{po_id}/cancel")
def cancel_po(po_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_stock_admin)]):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.po_id == po_id).first()
    if not po:
        raise HTTPException(404, "PO not found")
    if po.status in ("received", "partially_received"):
        raise HTTPException(400, "Cannot cancel a PO that already has stock received — receive or write off the remainder, or contact an admin")
    po.status = "cancelled"
    db.commit()
    return {"ok": True, "status": "ok"}


@router.delete("/purchase-orders/{po_id}")
def delete_po(po_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(_stock_admin)]):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.po_id == po_id).first()
    if not po:
        raise HTTPException(404, "PO not found")
    if po.status in ("received", "partially_received"):
        raise HTTPException(400, "Cannot delete a PO that already has stock received")
    db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id == po_id).delete()
    db.delete(po)
    db.commit()
    return {"ok": True, "status": "ok"}
