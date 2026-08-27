"""Auth & store listing routes."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
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
        .filter(User.store_id == body.store_id, User.active.is_(True), User.pos_login_enabled.is_(True))
        .all()
    )
    code = (body.employeeCode or "").strip().upper()
    matched: User | None = None
    if code:
        # A specific employee is being claimed — resolve to exactly them
        # first, then check the PIN only against that one account. This
        # is what actually fixes the ambiguity of two people at the same
        # store sharing a PIN: the code picks the person, the PIN just
        # confirms it's really them.
        candidate = next((u for u in users if u.employee_code == code), None)
        if candidate and verify_pin(body.pin, candidate.pin_hash):
            matched = candidate
    else:
        # No code given — only match users who haven't been assigned one
        # yet (keeps existing PIN-only logins working during rollout).
        # Anyone with a code set now requires it; they can't be logged
        # into by PIN alone anymore.
        for u in users:
            if not u.employee_code and verify_pin(body.pin, u.pin_hash):
                matched = u
                break
    if not matched:
        raise HTTPException(status_code=401, detail="Wrong PIN or Employee Code" if code else "Wrong PIN")

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
            posLoginEnabled=u.pos_login_enabled,
            employeeCode=u.employee_code,
            standardSalary=u.standard_salary,
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
    allowed = {"admin", "manager", "cashier", "sales_staff", "assistant", "cleaner", "accountant", "merchandiser", "warehouse"}
    if body.role not in allowed:
        raise HTTPException(status_code=400, detail=f"Role must be one of {sorted(allowed)}")
    uid = body.user_id or f"U{int(__import__('time').time()*1000)}"
    row = db.query(User).filter(User.user_id == uid).first()

    def _gen_code() -> str:
        import random
        for _ in range(20):
            code = f"EMP{random.randint(1000, 9999)}"
            if not db.query(User).filter(User.employee_code == code).first():
                return code
        return f"EMP{int(__import__('time').time())}"

    employee_code = (body.employeeCode or "").strip().upper()
    if employee_code:
        clash = db.query(User).filter(User.employee_code == employee_code, User.user_id != uid).first()
        if clash:
            raise HTTPException(status_code=400, detail=f"Employee Code '{employee_code}' is already used by {clash.name}")
    elif not row:
        employee_code = _gen_code()

    if row:
        row.store_id = body.store_id
        row.store_name = body.store_name
        row.name = body.name
        row.role = body.role
        row.active = body.active
        row.pos_login_enabled = body.posLoginEnabled
        row.standard_salary = body.standardSalary
        if employee_code:
            row.employee_code = employee_code
        if body.pin:
            row.pin_hash = hash_pin(body.pin)
    else:
        # A payroll/records-only employee (posLoginEnabled=False) doesn't
        # need a real PIN — pin_hash still can't be empty (login logic
        # depends on it), so a random one they'll never be told is used.
        pin = body.pin or (str(__import__("random").randint(1000, 9999)) if not body.posLoginEnabled else None)
        if not pin:
            raise HTTPException(status_code=400, detail="A PIN is required when POS/HO login is enabled")
        row = User(
            user_id=uid,
            store_id=body.store_id,
            store_name=body.store_name,
            name=body.name,
            role=body.role,
            pin_hash=hash_pin(pin),
            active=body.active,
            pos_login_enabled=body.posLoginEnabled,
            employee_code=employee_code,
            standard_salary=body.standardSalary,
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
        posLoginEnabled=row.pos_login_enabled,
        employeeCode=row.employee_code,
        standardSalary=row.standard_salary,
    )


class AuthorizePinIn(BaseModel):
    pin: str


@router.post("/authorize-pin")
def authorize_pin(
    body: AuthorizePinIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    """Used for the discount/return manager-approval gate at checkout — a
    cashier is over the self-service threshold and needs a manager (or
    admin) to enter their own PIN to authorize, without the cashier
    having to log out and back in. Checks managers/admins at the
    cashier's own store, plus HO-based admins (in case no manager is on
    duty in the store right now).
    """
    candidates = (
        db.query(User)
        .filter(User.active.is_(True))
        .filter(
            ((User.store_id == user.store_id) & (User.role.in_(("manager", "admin"))))
            | ((User.store_id == "HO") & (User.role == "admin"))
        )
        .all()
    )
    for u in candidates:
        if verify_pin(body.pin, u.pin_hash):
            return {"ok": True, "status": "ok", "approverName": u.name, "approverRole": u.role}
    raise HTTPException(401, "Invalid PIN, or this PIN doesn't belong to a manager/admin")


@router.delete("/users/{user_id}")
def delete_user(
    user_id: str, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(get_current_user)],
):
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    if user_id == user.user_id:
        raise HTTPException(status_code=400, detail="You can't delete your own account while logged in as it")
    row = db.query(User).filter(User.user_id == user_id).first()
    if not row:
        raise HTTPException(404, "User not found")
    db.delete(row)
    db.commit()
    return {"ok": True, "status": "ok"}
