"""Default seed data (mirrors Apps Script setupAllSheets defaults + sample products)."""
from __future__ import annotations

from sqlalchemy.orm import Session

from .auth import hash_pin
from .models import (
    Bank,
    InvoiceCounter,
    Product,
    Setting,
    Store,
    User,
)
from .services.accounting import ensure_coa


DEFAULT_STORES = [
    ("s1", "Store 1 — Tripoli", "Tripoli"),
    ("s2", "Store 2 — Benghazi", "Benghazi"),
    ("s3", "Store 3 — Misrata", "Misrata"),
    ("HO", "Head Office", "Tripoli"),
]

DEFAULT_USERS = [
    # user_id, store_id, store_name, name, role, pin
    ("admin", "HO", "Head Office", "Admin", "admin", "0000"),
    ("u1", "s1", "Store 1 — Tripoli", "Cashier 1", "cashier", "1111"),
    ("u2", "s2", "Store 2 — Benghazi", "Cashier 2", "cashier", "2222"),
    ("u3", "s3", "Store 3 — Misrata", "Cashier 3", "cashier", "3333"),
    ("m1", "s1", "Store 1 — Tripoli", "Manager 1", "manager", "1199"),
    ("m2", "s2", "Store 2 — Benghazi", "Manager 2", "manager", "2299"),
    ("m3", "s3", "Store 3 — Misrata", "Manager 3", "manager", "3399"),
    ("acc1", "HO", "Head Office", "Accountant", "accountant", "5555"),
]

DEFAULT_BANKS = [
    ("b1", "Cash", "", "", "💵"),
    ("b2", "Sadad", "", "Sadad Terminal", "🏦"),
    ("b3", "Mobi Cash", "", "Mobi Device", "🏦"),
    ("b4", "eDinar", "", "eDinar POS", "🏦"),
    ("b5", "Al-Wahda Bank", "", "Bank Terminal", "🏦"),
    ("b6", "Al-Jumhuriya", "", "Bank Terminal", "🏦"),
    ("b7", "Al-Tijari Bank", "", "Bank Terminal", "🏦"),
    ("b8", "Aman Bank", "", "Aman Terminal", "🏦"),
    ("b9", "Etfai", "", "Etfai Device", "🏦"),
    ("b10", "Bank Transfer", "", "", "🏦"),
]

# barcode, name, brand, category, size, cost, retail, reorder, opening, color, department, season, gender
SAMPLE_PRODUCTS = [
    ("8001000000001", "ANTA Running Pro — White/42", "ANTA", "Running", "42", 120, 250, 5, 20, "White", "Footwear", "SS26", "Men"),
    ("8001000000002", "ANTA Casual Classic — Blue/41", "ANTA", "Casual", "41", 90, 180, 4, 15, "Blue", "Footwear", "SS26", "Men"),
    ("8001000000003", "ANTA KT Basketball — Black/44", "ANTA", "Basketball", "44", 200, 420, 3, 8, "Black", "Footwear", "AW25", "Men"),
    ("8001000000004", "ANTA Lifestyle Slip — Grey/40", "ANTA", "Lifestyle", "40", 70, 150, 5, 12, "Grey", "Footwear", "SS26", "Women"),
    ("8001000000005", "ANTA Training Flex — Red/43", "ANTA", "Training", "43", 110, 230, 4, 10, "Red", "Footwear", "SS26", "Unisex"),
]


def seed_if_empty(db: Session) -> None:
    existing_store_ids = {s.store_id for s in db.query(Store).all()}
    for sid, name, city in DEFAULT_STORES:
        if sid in existing_store_ids:
            continue
        db.add(
            Store(
                store_id=sid,
                name=name,
                city=city,
                active=True,
            )
        )
    db.flush()

    existing_user_ids = {u.user_id for u in db.query(User).all()}
    for uid, sid, sname, name, role, pin in DEFAULT_USERS:
        if uid in existing_user_ids:
            continue
        db.add(
            User(
                user_id=uid,
                store_id=sid,
                store_name=sname,
                name=name,
                role=role,
                pin_hash=hash_pin(pin),
                active=True,
            )
        )

    existing_bank_ids = {b.bank_id for b in db.query(Bank).all()}
    for bid, name, acct, device, ico in DEFAULT_BANKS:
        if bid in existing_bank_ids:
            continue
        db.add(
            Bank(
                bank_id=bid,
                name=name,
                account_no=acct,
                device=device,
                active=True,
                icon=ico,
            )
        )

    if db.query(Product).count() == 0:
        for bc, name, brand, cat, size, cost, retail, reorder, opening, color, dept, season, gender in SAMPLE_PRODUCTS:
            db.add(
                Product(
                    barcode=bc,
                    name=name,
                    brand=brand,
                    category=cat,
                    size=size,
                    color=color,
                    department=dept,
                    season=season,
                    gender=gender,
                    cost=cost,
                    retail=retail,
                    reorder=reorder,
                    opening=opening,
                    active=True,
                )
            )

    if db.query(Setting).filter(Setting.key == "policy").first() is None:
        db.add(Setting(key="policy", value="Exchange within 7 days with receipt."))
        db.add(Setting(key="currency", value="LYD"))
        db.add(Setting(key="company_name", value="ANTA Shoes"))
        db.add(Setting(key="pos_name", value="ANTA POS"))
        db.add(Setting(key="language", value="en"))
        db.add(Setting(key="license_tenant", value="ALL"))
        db.add(Setting(key="license_locked", value="0"))

    for sid, _, _ in DEFAULT_STORES:
        if sid == "HO":
            continue
        if not db.query(InvoiceCounter).filter(InvoiceCounter.store_id == sid).first():
            db.add(InvoiceCounter(store_id=sid, next_inv=1))

    ensure_coa(db)
    db.commit()


def ensure_default_users(db: Session) -> None:
    """Create missing default users (does not overwrite existing pins)."""
    existing = {u.user_id for u in db.query(User).all()}
    for uid, sid, sname, name, role, pin in DEFAULT_USERS:
        if uid in existing:
            continue
        db.add(
            User(
                user_id=uid,
                store_id=sid,
                store_name=sname,
                name=name,
                role=role,
                pin_hash=hash_pin(pin),
                active=True,
            )
        )
    db.commit()
