"""Customer loyalty points — earn & redeem rates are configurable via the
existing Settings key-value store, with sensible defaults if not set.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Setting


def _get_setting(db: Session, key: str, default: float) -> float:
    row = db.query(Setting).filter(Setting.key == key).first()
    if not row or not row.value:
        return default
    try:
        return float(row.value)
    except ValueError:
        return default


def earn_rate(db: Session) -> float:
    """Points earned per 1 currency unit spent. Default: 1 point per 10 spent."""
    return _get_setting(db, "loyalty_earn_rate", 0.1)


def redeem_value(db: Session) -> float:
    """Currency value of 1 point when redeemed. Default: 10 points = 1 currency unit."""
    return _get_setting(db, "loyalty_redeem_value", 0.1)
