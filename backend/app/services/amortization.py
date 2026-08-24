"""Straight-line, monthly amortization for Prepaid / Deferred Expenses.

Same simplified whole-calendar-month approach as services/depreciation.py
(this is a small-retail bookkeeping tool, not audited GAAP software).
"""
from __future__ import annotations

from datetime import date
from math import ceil


def _parse(d: str) -> date:
    y, m, day = (int(x) for x in d.split("-"))
    return date(y, m, day)


def _months_between(d1: date, d2: date) -> int:
    if d2 < d1:
        return 0
    months = (d2.year - d1.year) * 12 + (d2.month - d1.month)
    if d2.day < d1.day:
        months -= 1
    return max(0, months)


def schedule(pe, as_of: str) -> dict:
    """Amortization position of one prepaid expense as of a given date."""
    total = float(pe.total_amount or 0)
    months_total = max(1, int(pe.months or 1))
    monthly = total / months_total

    if pe.written_off:
        as_of = pe.disposed_date if getattr(pe, "disposed_date", "") else as_of

    start = _parse(pe.start_date)
    end = _parse(as_of)
    months_elapsed = min(_months_between(start, end), months_total)
    amortized = min(total, round(monthly * months_elapsed, 2))
    remaining = round(total - amortized, 2)

    return {
        "monthlyAmortization": round(monthly, 2),
        "amortizedToDate": amortized,
        "remainingBalance": remaining,
        "fullyAmortized": amortized >= total - 0.005,
    }


def amortization_for_period(pe, date_from: str | None, date_to: str | None) -> float:
    """Amortization expense to recognize for one prepaid expense within
    [date_from, date_to]. Used by the P&L endpoint.
    """
    total = float(pe.total_amount or 0)
    months_total = max(1, int(pe.months or 1))
    if total <= 0:
        return 0.0
    monthly = total / months_total

    start = _parse(pe.start_date)
    end = date.today() if not date_to else _parse(date_to)
    df = _parse(date_from) if date_from else start
    period_start = max(start, df)
    period_end = end
    if period_start > period_end:
        return 0.0

    months_in_period = _months_between(period_start, period_end) + 1
    months_before_period = _months_between(start, period_start)
    remaining_months = max(0, months_total - months_before_period)
    months_to_charge = min(months_in_period, remaining_months)
    return round(monthly * max(0.0, months_to_charge), 2)
