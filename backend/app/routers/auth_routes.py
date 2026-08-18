"""Auth & store listing routes."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import create_access_token, get_current_user, verify_pin, CurrentUser, hash_pin
from ..database import get_db
from ..models import Store, User
from ..schemas import LoginRequest, TokenResponse, StoreOut, UserIn, UserOut
from ..auth import permissions_for
from ..services import license_service as lic

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/ping")
def ping():
    from ..utils import iso_now

    return {"ok": True, "status": "ok", "time": iso_now(), "t": iso_now()}


@router.get("/stores", response_model=list[StoreOut])
def list_stores(db: Annotated[Session, Depends(get_db)]):
    rows = db.query(Store).filter(Store.active.is_(True)).order_by(Store.store_id).all()
    # Hide pure HO from cashier login optionally — keep it for admin PIN
    return [
        StoreOut(
            store_id=r.store_id,
            name=r.name,
            city=r.city or "",
            address=r.address or "",
            manager=r.manager or "",
            phone=r.phone or "",
            active=r.active,
        )
        for r in rows
        if r.store_id != "HO"
    ] + [
        StoreOut(
            store_id=r.store_id,
            name=r.name,
            city=r.city or "",
            address=r.address or "",
            manager=r.manager or "",
            phone=r.phone or "",
            active=r.active,
        )
        for r in rows
        if r.store_id == "HO"
    ]


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Annotated[Session, Depends(get_db)]):
    users = (
        db.query(User)
        .filter(User.store_id == body.store_id, User.active.is_(True))
        .all()
    )
    matched: User | None = None
    for u in users:
        if verify_pin(body.pin, u.pin_hash):
            matched = u
            break
    if not matched:
        raise HTTPException(status_code=401, detail="Wrong PIN")

    try:
        locked, reason = lic.is_locked(db)
    except Exception:
        locked, reason = False, ""
    if locked and matched.role != "admin":
        raise HTTPException(status_code=403, detail=f"System locked: {reason}")

    token = create_access_token(
        {
            "sub": matched.user_id,
            "role": matched.role,
            "store_id": matched.store_id,
            "name": matched.name,
        }
    )
    return TokenResponse(
        access_token=token,
        user={
            "userId": matched.user_id,
            "name": matched.name,
            "role": matched.role,
            "storeId": matched.store_id,
            "storeName": matched.store_name,
            "permissions": sorted(permissions_for(matched.role)),
        },
    )


@router.get("/me")
def me(user: Annotated[CurrentUser, Depends(get_current_user)]):
    return {
        "ok": True,
        "user": {
            "userId": user.user_id,
            "name": user.name,
            "role": user.role,
            "storeId": user.store_id,
            "storeName": user.store_name,
            "permissions": sorted(permissions_for(user.role)),
        },
    }


@router.get("/users", response_model=list[UserOut])
def list_users(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    if user.role not in ("admin", "manager"):
        raise HTTPException(status_code=403, detail="Managers only")
    q = db.query(User)
    if user.role == "manager":
        q = q.filter(User.store_id == user.store_id)
    return [
        UserOut(
            user_id=u.user_id,
            store_id=u.store_id,
            store_name=u.store_name,
            name=u.name,
            role=u.role,
            active=u.active,
        )
        for u in q.all()
    ]


@router.post("/users", response_model=UserOut)
def save_user(
    body: UserIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    allowed = {"admin", "manager", "cashier", "accountant"}
    if body.role not in allowed:
        raise HTTPException(status_code=400, detail=f"Role must be one of {sorted(allowed)}")
    uid = body.user_id or f"U{int(__import__('time').time())}"
    row = db.query(User).filter(User.user_id == uid).first()
    if row:
        row.store_id = body.store_id
        row.store_name = body.store_name
        row.name = body.name
        row.role = body.role
        row.active = body.active
        if body.pin:
            row.pin_hash = hash_pin(body.pin)
    else:
        row = User(
            user_id=uid,
            store_id=body.store_id,
            store_name=body.store_name,
            name=body.name,
            role=body.role,
            pin_hash=hash_pin(body.pin),
            active=body.active,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    return UserOut(
        user_id=row.user_id,
        store_id=row.store_id,
        store_name=row.store_name,
        name=row.name,
        role=row.role,
        active=row.active,
    )
