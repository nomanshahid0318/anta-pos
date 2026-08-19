"""Straight-line depreciation calculations for Fixed Assets.

Kept deliberately simple (whole calendar months, straight-line only) —
this is a small-retail bookkeeping tool, not audited GAAP software. It is
accurate enough for monthly/annual internal reporting.
"""
from __future__ import annotations

from datetime import date
from math import ceil


def _parse(d: str) -> date:
    y, m, day = (int(x) for x in d.split("-"))
    return date(y, m, day)


def _months_between(d1: date, d2: date) -> int:
    """Whole calendar months from d1 to d2 (d2 assumed >= d1)."""
    if d2 < d1:
        return 0
    months = (d2.year - d1.year) * 12 + (d2.month - d1.month)
    if d2.day < d1.day:
        months -= 1
    return max(0, months)


def schedule(asset, as_of: str) -> dict:
    """Depreciation position of one asset as of a given date.

    Returns monthlyDepreciation, accumulatedDepreciation, bookValue, and
    whether it's fully depreciated — all as of `as_of` (usually today).
    """
    depreciable = max(0.0, float(asset.cost or 0) - float(asset.salvage_value or 0))
    life_months = max(0.0, float(asset.useful_life_years or 0) * 12)
    monthly = (depreciable / life_months) if life_months > 0 else 0.0

    if asset.disposed:
        # Freeze depreciation at the disposal date.
        as_of = asset.disposed_date or as_of

    start = _parse(asset.purchase_date)
    end = _parse(as_of)
    months_elapsed = min(_months_between(start, end), ceil(life_months)) if life_months > 0 else 0
    accumulated = min(depreciable, monthly * months_elapsed)
    book_value = float(asset.cost or 0) - accumulated

    return {
        "monthlyDepreciation": round(monthly, 2),
        "accumulatedDepreciation": round(accumulated, 2),
        "bookValue": round(book_value, 2),
        "fullyDepreciated": accumulated >= depreciable - 0.005,
    }


def depreciation_for_period(asset, date_from: str | None, date_to: str | None) -> float:
    """Depreciation expense to recognize for one asset within [date_from,
    date_to] (both optional — defaults to the asset's whole life to date_to,
    or to today if date_to is also missing). Used by the P&L endpoint.
    """
    depreciable = max(0.0, float(asset.cost or 0) - float(asset.salvage_value or 0))
    life_months = max(0.0, float(asset.useful_life_years or 0) * 12)
    if life_months <= 0 or depreciable <= 0:
        return 0.0
    monthly = depreciable / life_months

    start = _parse(asset.purchase_date)
    end = _parse(asset.disposed_date) if (asset.disposed and asset.disposed_date) else (_parse(date_to) if date_to else date.today())
    df = _parse(date_from) if date_from else start
    period_start = max(start, df)
    period_end = end
    if period_start > period_end:
        return 0.0

    months_in_period = _months_between(period_start, period_end) + 1
    months_before_period = _months_between(start, period_start)
    remaining_life_months = max(0.0, life_months - months_before_period)
    months_to_charge = min(months_in_period, remaining_life_months)
    return round(monthly * max(0.0, months_to_charge), 2)
