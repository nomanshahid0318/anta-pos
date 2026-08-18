"""Inventory ledger updates (replaces Apps Script updateInv / HO warehouse)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import Inventory, HOWarehouse, Product


def _now() -> datetime:
    return datetime.utcnow()


def get_or_create_inv(
    db: Session,
    barcode: str,
    store: str,
    store_id: str,
    name: str = "",
) -> Inventory:
    row = (
        db.query(Inventory)
        .filter(Inventory.barcode == str(barcode), Inventory.store_id == str(store_id))
        .first()
    )
    if row:
        if name and not row.name:
            row.name = name
        return row

    # NOTE: a store's inventory starts at 0, not at Product.opening.
    # `opening` is the quantity entered in Product Master / bulk upload,
    # which represents the HO Warehouse starting stock for that product
    # (it already flows into HOWarehouse via set_ho_warehouse_qty). It is
    # NOT a per-store quantity — a product having opening=24 does not mean
    # every store secretly already has 24 units. A store should only ever
    # show stock that was actually issued to it via a received GRN.
    prod = db.query(Product).filter(Product.barcode == str(barcode)).first()
    row = Inventory(
        barcode=str(barcode),
        name=name or (prod.name if prod else ""),
        store=store,
        store_id=str(store_id),
        grn_in=0,
        sales_out=0,
        returns_in=0,
        exch_out=0,
        exch_in=0,
        claims=0,
        on_hand=0,
        updated_at=_now(),
    )
    db.add(row)
    db.flush()
    return row


def set_ho_warehouse_qty(db: Session, barcode: str, name: str, qty: int) -> HOWarehouse:
    """Set HO Warehouse on-hand stock for a barcode to an exact quantity.

    Used by Product Master (single edit + bulk upload) so that entering a
    quantity there is reflected immediately in the HO Warehouse Qty column,
    without needing a separate Supplier GRN transaction.
    """
    row = db.query(HOWarehouse).filter(HOWarehouse.barcode == str(barcode)).first()
    if not row:
        row = HOWarehouse(barcode=str(barcode), name=name or "", supplier_in=0, store_out=0, on_hand=0)
        db.add(row)
        db.flush()
    # Keep supplier_in - store_out == qty so recalc() lands on the exact value
    # requested, while preserving whatever has already been issued to stores.
    row.supplier_in = int(qty or 0) + (row.store_out or 0)
    row.recalc()
    row.updated_at = _now()
    if name:
        row.name = name
    return row


def update_inv(
    db: Session,
    barcode: str,
    store: str,
    store_id: str,
    name: str,
    action: str,
    qty: int,
) -> Inventory | None:
    """
    action: grn | sale | return | exchout | exchin | claim
    """
    if not barcode or not qty:
        return None
    row = get_or_create_inv(db, barcode, store, store_id, name)
    q = int(qty)
    if action == "grn":
        row.grn_in = (row.grn_in or 0) + q
    elif action == "sale":
        row.sales_out = (row.sales_out or 0) + q
    elif action == "return":
        row.returns_in = (row.returns_in or 0) + q
    elif action == "exchout":
        row.exch_out = (row.exch_out or 0) + q
    elif action == "exchin":
        row.exch_in = (row.exch_in or 0) + q
    elif action == "claim":
        row.claims = (row.claims or 0) + q
    else:
        return row
    row.recalc()
    row.updated_at = _now()
    return row


def get_stock(db: Session, barcode: str, store_id: str) -> int:
    row = (
        db.query(Inventory)
        .filter(Inventory.barcode == str(barcode), Inventory.store_id == str(store_id))
        .first()
    )
    if row:
        return int(row.on_hand or 0)
    # No inventory row yet for this store = nothing has been received there
    # yet. Product.opening is HO Warehouse's starting stock, not this
    # store's — falling back to it here was the same bug as in
    # get_or_create_inv above (see the note there).
    return 0


def auto_heal_store_inventory(db: Session, store_id: str) -> None:
    """Silently keep a store's grn_in/on_hand truthful to what it actually
    received, every time its stock is displayed — no manual action needed.

    A store's Inventory row can end up with a stale/incorrect grn_in (e.g.
    an old placeholder row from "Init Store Stock", or historical data from
    a fixed bug). This recomputes grn_in strictly from real, received
    Send-to-Store GRN history (StoreGRN rows with status='received') and
    fixes any row that has drifted — before any read of the data. Sales,
    returns, exchanges, and claims are left untouched (real transaction
    history). Cheap and idempotent: does nothing once a store is correct.
    """
    from ..models import StoreGRN  # local import to avoid a circular import at module load

    if not store_id or store_id == "HO":
        return
    received_rows = (
        db.query(StoreGRN.barcode, func.sum(StoreGRN.qty_received))
        .filter(StoreGRN.store_id == str(store_id), StoreGRN.status == "received")
        .group_by(StoreGRN.barcode)
        .all()
    )
    received_by_barcode = {barcode: int(total or 0) for barcode, total in received_rows}
    inv_rows = db.query(Inventory).filter(Inventory.store_id == str(store_id)).all()
    dirty = False
    for row in inv_rows:
        correct_grn_in = received_by_barcode.get(row.barcode, 0)
        if (row.grn_in or 0) != correct_grn_in:
            row.grn_in = correct_grn_in
            row.recalc()
            row.updated_at = _now()
            dirty = True
    if dirty:
        db.commit()


def update_ho_warehouse(db: Session, barcode: str, name: str, qty: int, direction: str) -> HOWarehouse:
    row = db.query(HOWarehouse).filter(HOWarehouse.barcode == str(barcode)).first()
    if not row:
        row = HOWarehouse(barcode=str(barcode), name=name or "", supplier_in=0, store_out=0, on_hand=0)
        db.add(row)
        db.flush()
    if direction == "in":
        row.supplier_in = (row.supplier_in or 0) + int(qty)
    elif direction == "out":
        row.store_out = (row.store_out or 0) + int(qty)
    row.recalc()
    row.updated_at = _now()
    if name:
        row.name = name
    return row
