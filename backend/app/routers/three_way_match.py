"""Three-Way Matching — Purchase Order vs Goods Received vs Supplier
Invoice. The supplier's invoice is entered independently of what was
received, so any mismatch (short-shipped but billed in full, price
different from the PO, etc.) is caught before payment is approved,
instead of the invoice just passing through unnoticed.
"""
from __future__ import annotations

import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import CurrentUser, require_role
from ..database import get_db
from ..models_accounting import PurchaseOrder, PurchaseOrderLine, SupplierInvoice, SupplierInvoiceLine
from ..services.audit import log_audit
from ..utils import today_str

router = APIRouter(prefix="/api/ho/supplier-invoices", tags=["three-way-match"])


class InvoiceLineIn(BaseModel):
    barcode: str
    name: str = ""
    qtyBilled: int
    unitCostBilled: float


class SupplierInvoiceIn(BaseModel):
    poId: str
    invoiceNumber: str = ""
    date: Optional[str] = None
    lines: list[InvoiceLineIn] = Field(default_factory=list)
    notes: str = ""


class ApproveInvoiceIn(BaseModel):
    overrideReason: str = ""


def _match_lines(po_lines: list[PurchaseOrderLine], inv_lines: list[SupplierInvoiceLine]) -> tuple[list[dict], bool]:
    """Compare PO ordered qty/cost, GRN received qty, and Invoice billed
    qty/cost per barcode. Returns (rows, has_discrepancy).
    """
    po_by_barcode = {l.barcode: l for l in po_lines}
    inv_by_barcode = {l.barcode: l for l in inv_lines}
    all_barcodes = set(po_by_barcode) | set(inv_by_barcode)
    rows = []
    has_discrepancy = False
    for barcode in all_barcodes:
        po = po_by_barcode.get(barcode)
        inv = inv_by_barcode.get(barcode)
        ordered_qty = po.qty_ordered if po else 0
        received_qty = po.qty_received if po else 0
        po_cost = po.unit_cost if po else None
        billed_qty = inv.qty_billed if inv else 0
        billed_cost = inv.unit_cost_billed if inv else None
        name = (po.name if po else None) or (inv.name if inv else "") or barcode
        qty_mismatch = billed_qty != received_qty
        cost_mismatch = (po_cost is not None and billed_cost is not None and abs(po_cost - billed_cost) > 0.005)
        missing_on_po = po is None
        missing_on_invoice = inv is None
        row_flag = qty_mismatch or cost_mismatch or missing_on_po or missing_on_invoice
        if row_flag:
            has_discrepancy = True
        rows.append({
            "barcode": barcode, "name": name,
            "orderedQty": ordered_qty, "receivedQty": received_qty, "billedQty": billed_qty,
            "poCost": po_cost, "billedCost": billed_cost,
            "qtyMismatch": qty_mismatch, "costMismatch": cost_mismatch,
            "missingOnPO": missing_on_po, "missingOnInvoice": missing_on_invoice,
            "flagged": row_flag,
        })
    rows.sort(key=lambda r: (not r["flagged"], r["barcode"]))
    return rows, has_discrepancy


@router.post("")
def create_supplier_invoice(
    body: SupplierInvoiceIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    po = db.query(PurchaseOrder).filter(PurchaseOrder.po_id == body.poId).first()
    if not po:
        raise HTTPException(404, "Purchase Order not found")
    if not body.lines:
        raise HTTPException(400, "At least one line is required")
    iid = f"SINV-{int(time.time() * 1000)}"
    total = sum(l.qtyBilled * l.unitCostBilled for l in body.lines)
    row = SupplierInvoice(
        invoice_id=iid, po_id=body.poId, supplier_id=po.supplier_id, supplier_name=po.supplier_name,
        invoice_number=body.invoiceNumber or "", date=body.date or today_str(),
        total_amount=round(total, 2), notes=body.notes or "",
    )
    db.add(row)
    for l in body.lines:
        db.add(SupplierInvoiceLine(invoice_id=iid, barcode=l.barcode, name=l.name or "", qty_billed=l.qtyBilled, unit_cost_billed=l.unitCostBilled))
    db.commit()
    return {"ok": True, "status": "ok", "id": iid}


@router.get("")
def list_supplier_invoices(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "accountant", "manager"))],
    status: Optional[str] = None,
):
    q = db.query(SupplierInvoice)
    if status:
        q = q.filter(SupplierInvoice.status == status)
    rows = q.order_by(SupplierInvoice.id.desc()).all()
    out = []
    for r in rows:
        po_lines = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id == r.po_id).all()
        inv_lines = db.query(SupplierInvoiceLine).filter(SupplierInvoiceLine.invoice_id == r.invoice_id).all()
        _, has_discrepancy = _match_lines(po_lines, inv_lines)
        out.append({
            "id": r.invoice_id, "poId": r.po_id, "supplierName": r.supplier_name, "invoiceNumber": r.invoice_number,
            "date": r.date, "totalAmount": r.total_amount, "status": r.status, "hasDiscrepancy": has_discrepancy,
            "approvedBy": r.approved_by,
        })
    return {"ok": True, "data": out}


@router.get("/{invoice_id}/match")
def get_match(
    invoice_id: str, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant", "manager"))],
):
    row = db.query(SupplierInvoice).filter(SupplierInvoice.invoice_id == invoice_id).first()
    if not row:
        raise HTTPException(404, "Supplier invoice not found")
    po = db.query(PurchaseOrder).filter(PurchaseOrder.po_id == row.po_id).first()
    po_lines = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id == row.po_id).all()
    inv_lines = db.query(SupplierInvoiceLine).filter(SupplierInvoiceLine.invoice_id == invoice_id).all()
    rows, has_discrepancy = _match_lines(po_lines, inv_lines)
    return {
        "ok": True, "id": row.invoice_id, "poId": row.po_id, "supplierName": row.supplier_name,
        "invoiceNumber": row.invoice_number, "date": row.date, "totalAmount": row.total_amount,
        "status": row.status, "approvedBy": row.approved_by, "overrideReason": row.override_reason,
        "poStatus": po.status if po else "", "hasDiscrepancy": has_discrepancy, "lines": rows,
    }


@router.post("/{invoice_id}/approve")
def approve_supplier_invoice(
    invoice_id: str, body: ApproveInvoiceIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    """Approves the invoice for payment. If the three-way match found a
    discrepancy, an override reason is required — this is the control:
    a mismatch can't just be silently waved through, someone has to
    explicitly state why it's being paid anyway (partial shipment
    already agreed with supplier, price correction pending, etc.).
    """
    row = db.query(SupplierInvoice).filter(SupplierInvoice.invoice_id == invoice_id).first()
    if not row:
        raise HTTPException(404, "Supplier invoice not found")
    if row.status == "approved":
        raise HTTPException(400, "Already approved")
    po_lines = db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id == row.po_id).all()
    inv_lines = db.query(SupplierInvoiceLine).filter(SupplierInvoiceLine.invoice_id == invoice_id).all()
    _, has_discrepancy = _match_lines(po_lines, inv_lines)
    if has_discrepancy and not body.overrideReason.strip():
        raise HTTPException(400, "This invoice has a PO/GRN mismatch — an override reason is required to approve it anyway.")
    row.status = "approved"
    row.approved_by = user.name
    row.approved_date = today_str()
    row.override_reason = body.overrideReason or ""
    log_audit(
        db, user, "update", "supplier_invoice", invoice_id,
        f"Approved supplier invoice {invoice_id} for PO {row.po_id}" + (f" — override: {body.overrideReason}" if has_discrepancy else ""),
        new_value={"status": "approved", "hasDiscrepancy": has_discrepancy, "overrideReason": body.overrideReason},
    )
    db.commit()
    return {"ok": True, "status": "ok"}


@router.post("/{invoice_id}/dispute")
def dispute_supplier_invoice(
    invoice_id: str, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))],
):
    row = db.query(SupplierInvoice).filter(SupplierInvoice.invoice_id == invoice_id).first()
    if not row:
        raise HTTPException(404, "Supplier invoice not found")
    row.status = "disputed"
    db.commit()
    return {"ok": True, "status": "ok"}
