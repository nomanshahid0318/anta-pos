"""License activate / status / remote lock."""
from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..services import license_service as lic

router = APIRouter(prefix="/api/license", tags=["license"])


class ActivateIn(BaseModel):
    key: str
    tenant: str = "ALL"


class LockIn(BaseModel):
    locked: bool
    reason: str = ""


class GenerateIn(BaseModel):
    year: int
    tenant: str = "ALL"


@router.get("/status")
def license_status(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    return lic.status(db)


@router.post("/activate")
def activate(
    body: ActivateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
):
    return lic.activate(db, body.key, body.tenant)


@router.post("/lock")
def lock(
    body: LockIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
):
    return lic.set_lock(db, body.locked, body.reason)


@router.post("/generate")
def generate(
    body: GenerateIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin"))],
):
    key = lic.make_key(db, body.tenant, body.year)
    return {"ok": True, "key": key, "year": body.year, "tenant": body.tenant}
