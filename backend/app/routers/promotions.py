"""Promotions CRUD + cart preview."""
from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import Promotion
from ..services.promotions import apply_promotions, active_promos

router = APIRouter(prefix="/api/promotions", tags=["promotions"])


class PromoIn(BaseModel):
    promoId: Optional[str] = None
    name: str
    type: str  # b1g1|b2g1|percent|fixed|invoice_percent|invoice_fixed
    value: float = 0
    targetType: str = "all"
    targetValue: str = ""
    active: bool = True
    startDate: str = ""
    endDate: str = ""
    startTime: str = ""
    endTime: str = ""


class PreviewIn(BaseModel):
    items: list[dict[str, Any]] = Field(default_factory=list)
    globalDiscount: float = 0


def _out(p: Promotion) -> dict:
    return {
        "id": p.promo_id,
        "name": p.name,
        "type": p.type,
        "value": p.value,
        "targetType": p.target_type,
        "targetValue": p.target_value,
        "active": p.active,
        "startDate": p.start_date,
        "endDate": p.end_date,
        "startTime": getattr(p, "start_time", "") or "",
        "endTime": getattr(p, "end_time", "") or "",
    }


@router.get("")
def list_promos(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
    active_only: bool = False,
):
    q = db.query(Promotion).order_by(Promotion.id.desc())
    if active_only:
        q = q.filter(Promotion.active.is_(True))
    return {"ok": True, "data": [_out(p) for p in q.all()]}


@router.post("")
def save_promo(
    body: PromoIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
):
    pid = body.promoId or f"PR-{int(__import__('time').time() * 1000)}"
    row = db.query(Promotion).filter(Promotion.promo_id == pid).first()
    if row:
        row.name = body.name
        row.type = body.type
        row.value = body.value
        row.target_type = body.targetType
        row.target_value = body.targetValue
        row.active = body.active
        row.start_date = body.startDate or ""
        row.end_date = body.endDate or ""
        row.start_time = body.startTime or ""
        row.end_time = body.endTime or ""
    else:
        row = Promotion(
            promo_id=pid,
            name=body.name,
            type=body.type,
            value=body.value,
            target_type=body.targetType,
            target_value=body.targetValue,
            active=body.active,
            start_date=body.startDate or "",
            end_date=body.endDate or "",
            start_time=body.startTime or "",
            end_time=body.endTime or "",
        )
        db.add(row)
    db.commit()
    return {"ok": True, "id": pid}


@router.post("/{promo_id}/toggle")
def toggle_promo(
    promo_id: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
):
    row = db.query(Promotion).filter(Promotion.promo_id == promo_id).first()
    if not row:
        raise HTTPException(404, "Not found")
    row.active = not row.active
    db.commit()
    return {"ok": True, "active": row.active}


@router.post("/preview")
def preview(
    body: PreviewIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    return {"ok": True, **apply_promotions(db, body.items, body.globalDiscount)}
