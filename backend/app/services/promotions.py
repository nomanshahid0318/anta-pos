"""Promotion evaluation for cart lines / invoices.

Supports:
- b1g1  : buy 1 get 1 free (every 2 matching units, cheapest 1 free)
- b2g1  : buy 2 get 1 free (every 3 matching units, cheapest 1 free)
- percent / fixed : per-line discount
- invoice_percent / invoice_fixed : whole-invoice discount

B1G1 / B2G1 work at BASKET level: matching units are pooled across all
cart lines, and the CHEAPEST units become free while the higher-priced
units are always charged.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from ..models import Promotion


def _in_window(promo: Promotion) -> bool:
    """Check whether 'now' falls within the promo's optional start/end date+time window."""
    now = datetime.now()
    sd, st = (promo.start_date or "").strip(), (getattr(promo, "start_time", "") or "").strip()
    ed, et = (promo.end_date or "").strip(), (getattr(promo, "end_time", "") or "").strip()
    if sd:
        try:
            start = datetime.strptime(f"{sd} {st or '00:00'}", "%Y-%m-%d %H:%M")
            if now < start:
                return False
        except ValueError:
            pass
    if ed:
        try:
            end = datetime.strptime(f"{ed} {et or '23:59'}", "%Y-%m-%d %H:%M")
            if now > end:
                return False
        except ValueError:
            pass
    return True


def active_promos(db: Session) -> list[Promotion]:
    rows = (
        db.query(Promotion)
        .filter(Promotion.active.is_(True))
        .order_by(Promotion.id.desc())
        .all()
    )
    return [p for p in rows if _in_window(p)]


def _match_item(promo: Promotion, barcode: str, name: str) -> bool:
    target = (promo.target_value or "").strip().lower()
    if not target or promo.target_type in ("", "all", "invoice"):
        return True
    if promo.target_type == "barcode":
        return barcode.strip().lower() == target
    if promo.target_type == "name_contains":
        return target in (name or "").lower()
    return True


def apply_promotions(db: Session, items: list[dict], invoice_discount: float = 0.0) -> dict:
    """items: [{barcode,name,qty,price,discount,...}] -> pricing summary."""
    promos = active_promos(db)

    # Normalise lines and apply manual/per-line percent+fixed promos first.
    lines: list[dict] = []
    for raw in items:
        qty = int(raw.get("qty") or 1)
        price = float(raw.get("price") or 0)
        base = qty * price
        # manual discount can be a % (0-100) on POS; treat <=100 & fractional as pct else absolute
        manual = float(raw.get("discount") or 0)
        line_disc = manual
        applied: list[str] = []

        for p in promos:
            ptype = (p.type or "").lower()
            if ptype not in ("percent", "%", "pct", "fixed", "amount"):
                continue
            if not _match_item(p, str(raw.get("barcode") or ""), str(raw.get("name") or "")):
                continue
            if ptype in ("percent", "%", "pct"):
                d = base * (float(p.value or 0) / 100.0)
                if d > line_disc:
                    line_disc = d
                    applied.append(p.name or f"{p.value}%")
            else:  # fixed per unit
                d = float(p.value or 0) * qty
                if d > line_disc:
                    line_disc = d
                    applied.append(p.name or f"Fixed {p.value}")

        line_disc = min(base, line_disc)
        lines.append(
            {
                **raw,
                "qty": qty,
                "price": price,
                "base": base,
                "discount": round(line_disc, 2),
                "promoNames": list(applied),
                "freeQty": 0,
            }
        )

    # Basket-level buy-x-get-y: pool matching units, free the cheapest.
    for p in promos:
        ptype = (p.type or "").lower()
        if ptype not in ("b1g1", "b2g1"):
            continue
        group = 2 if ptype == "b1g1" else 3  # units needed to earn 1 free

        # Expand matching units: (price, line_index)
        units: list[tuple[float, int]] = []
        for idx, ln in enumerate(lines):
            if not _match_item(p, str(ln.get("barcode") or ""), str(ln.get("name") or "")):
                continue
            for _ in range(int(ln["qty"])):
                units.append((float(ln["price"]), idx))
        if len(units) < group:
            continue

        free_count = len(units) // group
        if free_count <= 0:
            continue

        # cheapest units become free
        units.sort(key=lambda u: u[0])
        label = p.name or ("B1G1" if ptype == "b1g1" else "B2G1")
        for k in range(free_count):
            unit_price, li = units[k]
            # add full unit price as discount to that line (capped at line base)
            new_disc = min(lines[li]["base"], round(lines[li]["discount"] + unit_price, 2))
            lines[li]["discount"] = new_disc
            lines[li]["freeQty"] = int(lines[li].get("freeQty") or 0) + 1
            if label not in lines[li]["promoNames"]:
                lines[li]["promoNames"].append(label)

    # Finalise line totals
    item_discount = 0.0
    promo_notes: list[str] = []
    out_lines: list[dict] = []
    for ln in lines:
        disc = min(float(ln["base"]), float(ln["discount"]))
        item_discount += disc
        promo_notes.extend(ln.get("promoNames") or [])
        out_lines.append(
            {
                "barcode": ln.get("barcode"),
                "name": ln.get("name"),
                "qty": ln["qty"],
                "price": ln["price"],
                "cost": float(ln.get("cost") or 0),
                "discount": round(disc, 2),
                "lineTotal": round(max(0.0, ln["base"] - disc), 2),
                "promo": ", ".join(ln.get("promoNames") or []),
                "freeQty": int(ln.get("freeQty") or 0),
            }
        )

    subtotal = round(sum(l["price"] * l["qty"] for l in out_lines), 2)

    # Invoice-level promos + any manual invoice discount
    inv_disc = float(invoice_discount or 0)
    for p in promos:
        ptype = (p.type or "").lower()
        if ptype == "invoice_percent":
            d = (subtotal - item_discount) * (float(p.value or 0) / 100.0)
            if d > inv_disc:
                inv_disc = d
                promo_notes.append(p.name or f"Invoice {p.value}%")
        elif ptype == "invoice_fixed":
            if float(p.value or 0) > inv_disc:
                inv_disc = float(p.value or 0)
                promo_notes.append(p.name or f"Invoice -{p.value}")

    inv_disc = min(max(0.0, subtotal - item_discount), max(0.0, inv_disc))
    total = round(max(0.0, subtotal - item_discount - inv_disc), 2)
    return {
        "items": out_lines,
        "subtotal": subtotal,
        "discount": round(item_discount, 2),
        "globalDiscount": round(inv_disc, 2),
        "total": total,
        "promoNotes": sorted(set(promo_notes)),
    }
