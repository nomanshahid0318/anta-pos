"""Shared helpers."""
from __future__ import annotations

from datetime import datetime


def today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def time_str() -> str:
    return datetime.now().strftime("%H:%M")


def iso_now() -> str:
    return datetime.utcnow().isoformat() + "Z"
