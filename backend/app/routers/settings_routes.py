"""App settings including editable POS/store display name."""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import Setting, Store

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    company_name: Optional[str] = None
    company_logo: Optional[str] = None  # base64 data URL, or "" to remove
    pos_name: Optional[str] = None
    store_name: Optional[str] = None  # updates current user's store name (admin)
    store_id: Optional[str] = None
    policy: Optional[str] = None
    currency: Optional[str] = None
    language: Optional[str] = None


def _get_map(db: Session) -> dict[str, str]:
    return {r.key: r.value for r in db.query(Setting).all()}


def _put(db: Session, key: str, value: str) -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))


@router.get("/branding")
def get_branding(db: Annotated[Session, Depends(get_db)]):
    """Public, no-auth branding info — company name/logo only, nothing
    sensitive. Needed so the LOGIN screen (before anyone is authenticated)
    can also show custom branding, not just the app after login. Blank by
    default — no hardcoded company name is forced on anyone.
    """
    m = _get_map(db)
    return {
        "ok": True,
        "company_name": m.get("company_name", ""),
        "company_logo": m.get("company_logo", ""),
    }


@router.get("")
def get_settings(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    m = _get_map(db)
    store = db.query(Store).filter(Store.store_id == user.store_id).first()
    return {
        "ok": True,
        "company_name": m.get("company_name", ""),
        "company_logo": m.get("company_logo", ""),
        "pos_name": m.get("pos_name", ""),
        "policy": m.get("policy", ""),
        "currency": m.get("currency", "LYD"),
        "language": m.get("language", "en"),
        "store_id": user.store_id,
        "store_name": store.name if store else user.store_name,
    }


@router.put("")
def update_settings(
    body: SettingsUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
):
    if body.company_name is not None:
        _put(db, "company_name", body.company_name)
    if body.company_logo is not None:
        _put(db, "company_logo", body.company_logo)
    if body.pos_name is not None:
        _put(db, "pos_name", body.pos_name)
    if body.policy is not None:
        _put(db, "policy", body.policy)
    if body.currency is not None:
        _put(db, "currency", body.currency)
    if body.language is not None:
        _put(db, "language", body.language)
    if body.store_name is not None:
        sid = body.store_id or user.store_id
        store = db.query(Store).filter(Store.store_id == sid).first()
        if not store:
            raise HTTPException(404, "Store not found")
        store.name = body.store_name
    db.commit()
    return get_settings(db, user)
