"""Audit log helper — call this from any endpoint that edits or deletes
something sensitive. Never raises: a logging failure must never block the
real operation it's recording.
"""
from __future__ import annotations

import json
import time

from sqlalchemy.orm import Session

from ..models_audit import AuditLog


def log_audit(
    db: Session,
    user,
    action: str,
    entity_type: str,
    entity_id: str,
    summary: str,
    old_value: dict | None = None,
    new_value: dict | None = None,
) -> None:
    try:
        db.add(AuditLog(
            log_id=f"AUD-{int(time.time() * 1000000)}",
            user_id=getattr(user, "user_id", "") or "",
            user_name=getattr(user, "name", "") or "",
            role=getattr(user, "role", "") or "",
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id or ""),
            summary=summary[:255] if summary else "",
            old_value=json.dumps(old_value, default=str) if old_value else "",
            new_value=json.dumps(new_value, default=str) if new_value else "",
        ))
    except Exception:  # noqa: BLE001 — logging must never break the real operation
        pass