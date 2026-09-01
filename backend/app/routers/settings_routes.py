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
    discountApprovalThreshold: Optional[float] = None  # % — above this, needs manager PIN
    returnApprovalThreshold: Optional[float] = None  # amount — above this, needs manager PIN
    stockCountAdminThreshold: Optional[float] = None  # total shortage value — above this, needs admin (not just manager)
    storeStaffLiabilityPercent: Optional[float] = None  # % of a "Store Staff" shortage charged to the employee; rest stays a company Shrinkage Expense
    monthlyDayoffEntitlement: Optional[float] = None  # paid rest days per employee per month
    lateFineAmount: Optional[float] = None  # deducted per "late" attendance mark
    appTheme: Optional[str] = None  # JSON string {navy, accent, accent2} — user's custom color theme


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
        "discountApprovalThreshold": float(m.get("discount_approval_threshold", 15)),
        "returnApprovalThreshold": float(m.get("return_approval_threshold", 100)),
        "stockCountAdminThreshold": float(m.get("stock_count_admin_threshold", 500)),
        "storeStaffLiabilityPercent": float(m.get("store_staff_liability_percent", 50)),
        "monthlyDayoffEntitlement": float(m.get("monthly_dayoff_entitlement", 4)),
        "lateFineAmount": float(m.get("late_fine_amount", 10)),
        "appTheme": m.get("app_theme", ""),
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
    if body.discountApprovalThreshold is not None:
        _put(db, "discount_approval_threshold", str(body.discountApprovalThreshold))
    if body.returnApprovalThreshold is not None:
        _put(db, "return_approval_threshold", str(body.returnApprovalThreshold))
    if body.stockCountAdminThreshold is not None:
        _put(db, "stock_count_admin_threshold", str(body.stockCountAdminThreshold))
    if body.storeStaffLiabilityPercent is not None:
        _put(db, "store_staff_liability_percent", str(body.storeStaffLiabilityPercent))
    if body.monthlyDayoffEntitlement is not None:
        _put(db, "monthly_dayoff_entitlement", str(body.monthlyDayoffEntitlement))
    if body.lateFineAmount is not None:
        _put(db, "late_fine_amount", str(body.lateFineAmount))
    if body.appTheme is not None:
        _put(db, "app_theme", body.appTheme)
    if body.store_name is not None:
        sid = body.store_id or user.store_id
        store = db.query(Store).filter(Store.store_id == sid).first()
        if not store:
            raise HTTPException(404, "Store not found")
        store.name = body.store_name
    db.commit()
    return get_settings(db, user)
