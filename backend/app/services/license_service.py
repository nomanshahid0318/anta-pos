"""Simple yearly license key check + remote lock flag via settings."""
from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..models import Setting

# Local signing salt — production can override via settings license_secret
DEFAULT_SECRET = "ANTA-POS-LICENSE-v1"


def _get(db: Session, key: str, default: str = "") -> str:
    row = db.query(Setting).filter(Setting.key == key).first()
    return (row.value if row else default) or default


def _set(db: Session, key: str, value: str) -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))


def _secret(db: Session) -> str:
    return _get(db, "license_secret", DEFAULT_SECRET)


def make_key(db: Session, store_or_tenant: str, year: int) -> str:
    """Generate a yearly key: ANTA-YYYY-XXXXXXXX"""
    msg = f"{store_or_tenant}|{year}".encode()
    dig = hmac.new(_secret(db).encode(), msg, hashlib.sha256).hexdigest()[:8].upper()
    return f"ANTA-{year}-{dig}"


def verify_key(db: Session, key: str, store_or_tenant: str = "HO") -> tuple[bool, str, int | None]:
    key = (key or "").strip().upper()
    parts = key.split("-")
    if len(parts) != 3 or parts[0] != "ANTA":
        return False, "Invalid key format", None
    try:
        year = int(parts[1])
    except ValueError:
        return False, "Invalid year in key", None
    expected = make_key(db, store_or_tenant, year)
    if not hmac.compare_digest(expected, key):
        # also accept generic tenant ALL
        expected_all = make_key(db, "ALL", year)
        if not hmac.compare_digest(expected_all, key):
            return False, "Key mismatch", None
    now_y = datetime.now(timezone.utc).year
    if year < now_y:
        return False, "License expired", year
    return True, "OK", year


def is_locked(db: Session) -> tuple[bool, str]:
    if _get(db, "license_locked", "0") in ("1", "true", "yes"):
        return True, _get(db, "license_lock_reason", "License locked by administrator")
    exp = _get(db, "license_expiry", "")
    if exp:
        try:
            # YYYY-MM-DD
            dt = datetime.strptime(exp[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > dt:
                return True, "License expired"
        except Exception:
            pass
    key = _get(db, "license_key", "")
    if key:
        ok, msg, _ = verify_key(db, key, _get(db, "license_tenant", "ALL"))
        if not ok:
            return True, msg
    return False, ""


def activate(db: Session, key: str, tenant: str = "ALL") -> dict:
    ok, msg, year = verify_key(db, key, tenant)
    if not ok:
        return {"ok": False, "msg": msg}
    _set(db, "license_key", key.strip().upper())
    _set(db, "license_tenant", tenant)
    _set(db, "license_locked", "0")
    if year:
        _set(db, "license_expiry", f"{year}-12-31")
    db.commit()
    return {"ok": True, "msg": "License activated", "expiry": f"{year}-12-31" if year else ""}


def set_lock(db: Session, locked: bool, reason: str = "") -> dict:
    _set(db, "license_locked", "1" if locked else "0")
    if reason:
        _set(db, "license_lock_reason", reason)
    db.commit()
    return {"ok": True, "locked": locked}


def status(db: Session) -> dict:
    locked, reason = is_locked(db)
    return {
        "ok": True,
        "locked": locked,
        "reason": reason,
        "key": _get(db, "license_key", ""),
        "expiry": _get(db, "license_expiry", ""),
        "tenant": _get(db, "license_tenant", "ALL"),
    }
