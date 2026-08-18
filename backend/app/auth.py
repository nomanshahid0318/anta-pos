"""Authentication: PIN login + JWT bearer tokens."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .models import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)
settings = get_settings()


def hash_pin(pin: str) -> str:
    try:
        return pwd_context.hash(str(pin))
    except Exception:
        import bcrypt as _bcrypt
        return _bcrypt.hashpw(str(pin).encode("utf-8"), _bcrypt.gensalt()).decode("utf-8")


def verify_pin(plain: str, hashed: str) -> bool:
    plain_s = str(plain or "")
    hashed_s = str(hashed or "")
    if not hashed_s:
        return False
    try:
        if pwd_context.verify(plain_s, hashed_s):
            return True
    except Exception:
        pass
    # bcrypt direct fallback (passlib version quirks)
    try:
        import bcrypt as _bcrypt
        return _bcrypt.checkpw(plain_s.encode("utf-8"), hashed_s.encode("utf-8"))
    except Exception:
        return False


def create_access_token(data: dict, expires_minutes: int | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(
        minutes=expires_minutes or settings.access_token_expire_minutes
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])


class CurrentUser:
    def __init__(self, user: User):
        self.id = user.id
        self.user_id = user.user_id
        self.name = user.name
        self.role = user.role
        self.store_id = user.store_id
        self.store_name = user.store_name

    def require_roles(self, *roles: str) -> "CurrentUser":
        if self.role == "admin" or self.role in roles:
            return self
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_manager_or_above(self) -> bool:
        return self.role in ("admin", "manager")

    @property
    def is_accountant(self) -> bool:
        return self.role == "accountant"

    @property
    def is_finance(self) -> bool:
        return self.role in ("admin", "accountant")

    def can(self, perm: str) -> bool:
        return perm in permissions_for(self.role)

    def require_perm(self, perm: str) -> "CurrentUser":
        if self.role == "admin" or self.can(perm):
            return self
        raise HTTPException(status_code=403, detail=f"Missing permission: {perm}")


# role -> permissions
ROLE_PERMISSIONS: dict[str, set[str]] = {
    "admin": {"*"},
    "manager": {
        "pos.sale", "pos.return", "pos.exchange", "pos.claim", "pos.grn", "pos.inventory",
        "pos.reports", "pos.settings.read", "ho.view", "ho.stock", "ho.reports",
    },
    "cashier": {
        "pos.sale", "pos.return", "pos.exchange", "pos.claim", "pos.grn", "pos.inventory",
        "pos.reports", "pos.settings.read",
    },
    "accountant": {
        "ho.view", "ho.expenses", "ho.accounts", "ho.reports", "ho.finance",
        "pos.reports", "pos.settings.read",
    },
}


def permissions_for(role: str) -> set[str]:
    perms = ROLE_PERMISSIONS.get(role or "", set())
    if "*" in perms:
        return {"*"}
    return set(perms)


def require_perm(perm: str):
    def _dep(user: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
        if user.role == "admin" or user.can(perm) or "*" in permissions_for(user.role):
            return user
        raise HTTPException(status_code=403, detail=f"Missing permission: {perm}")
    return _dep



def get_current_user(
    creds: Annotated[Optional[HTTPAuthorizationCredentials], Depends(security)],
    db: Annotated[Session, Depends(get_db)],
) -> CurrentUser:
    if creds is None or not creds.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = decode_token(creds.credentials)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user = db.query(User).filter(User.user_id == user_id, User.active.is_(True)).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return CurrentUser(user)


def get_optional_user(
    creds: Annotated[Optional[HTTPAuthorizationCredentials], Depends(security)],
    db: Annotated[Session, Depends(get_db)],
) -> Optional[CurrentUser]:
    if creds is None or not creds.credentials:
        return None
    try:
        return get_current_user(creds, db)
    except HTTPException:
        return None


def require_role(*roles: str):
    def _dep(user: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
        if user.role == "admin":
            return user
        if user.role not in roles:
            raise HTTPException(status_code=403, detail=f"Requires role: {', '.join(roles)}")
        return user

    return _dep
