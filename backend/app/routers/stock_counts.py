"""Stock Adjustments / Physical Count endpoints."""
from __future__ import annotations

import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import CurrentUser, get_current_user, require_role
from ..database import get_db
from ..models import Expense, Inventory, Product, Setting, User
from ..models_stockcount import StockCount, StockCountAllocation, StockCountLine
from ..models_accounting import EmployeeAdvance
from ..services.audit import log_audit
from ..services.inventory import get_or_create_inv
from ..utils import today_str

router = APIRouter(prefix="/api/stock-counts", tags=["stock-counts"])


class StartCountIn(BaseModel):
    storeId: str
    storeName: str = ""
    barcodes: Optional[list[str]] = None  # omit = full count of everything with stock
    notes: str = ""


class AllocationIn(BaseModel):
    employeeUserId: str
    percent: float
    deductionMonth: str = ""  # YYYY-MM


class SetAllocationsIn(BaseModel):
    allocations: list[AllocationIn] = Field(default_factory=list)


class CountLineUpdate(BaseModel):
    barcode: str
    physicalQty: Optional[int] = None
    reason: str = ""
    category: Optional[str] = None  # shrinkage | employee_fault | investigation
    employeeUserId: Optional[str] = None


class SubmitCountIn(BaseModel):
    lines: list[CountLineUpdate] = Field(default_factory=list)


class QuickAdjustIn(BaseModel):
    barcode: str
    storeId: str
    storeName: str = ""
    name: str = ""
    newQty: int
    reason: str


def _line_out(l: StockCountLine) -> dict:
    variance = None if l.physical_qty is None else (l.physical_qty - l.system_qty)
    return {
        "barcode": l.barcode, "name": l.name, "systemQty": l.system_qty,
        "physicalQty": l.physical_qty, "variance": variance, "reason": l.reason,
        "category": l.category, "employeeUserId": l.employee_user_id,
    }


class ReclassifyIn(BaseModel):
    category: str  # shrinkage | split | investigation
    allocations: list[AllocationIn] = Field(default_factory=list)  # required when category == split


@router.post("/{count_id}/lines/{line_barcode}/reclassify")
def reclassify_line(
    count_id: str, line_barcode: str, body: ReclassifyIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    """Change who bears an ALREADY-APPROVED shortage after the fact — e.g.
    it was first booked as company Shrinkage, but an investigation later
    confirmed a specific employee was responsible. Moves the financial
    entry cleanly instead of requiring a manual delete + recreate:
    deletes the old Expense/Advance this line posted, creates the new
    one, and re-links it — Inventory itself is untouched (the physical
    count doesn't change, only who's responsible for the value).
    """
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "approved":
        raise HTTPException(400, "Only an approved count's lines can be reclassified")
    line = db.query(StockCountLine).filter(StockCountLine.count_id == count_id, StockCountLine.barcode == line_barcode).first()
    if not line:
        raise HTTPException(404, "Line not found")
    if line.physical_qty is None or (line.physical_qty - line.system_qty) >= 0:
        raise HTTPException(400, "Only a shortage (negative variance) line can be reclassified")
    if body.category not in ("shrinkage", "split", "investigation"):
        raise HTTPException(400, "Invalid category")
    total_pct = sum(a.percent for a in body.allocations)
    if body.category == "split":
        if not body.allocations:
            raise HTTPException(400, "At least one employee allocation is required for Split")
        if total_pct > 100.0001:
            raise HTTPException(400, f"Allocated percentages add up to {total_pct}% — cannot exceed 100%")

    variance = line.physical_qty - line.system_qty
    product = db.query(Product).filter(Product.barcode == line_barcode).first()
    cost = float(product.cost or 0) if product else 0
    value = round(abs(variance) * cost, 2)

    # Undo whatever was posted before — the line's own expense, its
    # legacy single advance (old data), and every allocation's advance.
    if line.posted_expense_id:
        old_exp = db.query(Expense).filter(Expense.exp_id == line.posted_expense_id).first()
        if old_exp:
            db.delete(old_exp)
        line.posted_expense_id = ""
    if line.posted_advance_id:
        old_adv = db.query(EmployeeAdvance).filter(EmployeeAdvance.advance_id == line.posted_advance_id).first()
        if old_adv:
            if (old_adv.repaid_amount or 0) > 0:
                raise HTTPException(400, "An employee has already made repayments against an existing advance for this line — settle or reverse those manually before reclassifying")
            db.delete(old_adv)
        line.posted_advance_id = ""
    old_allocations = db.query(StockCountAllocation).filter(StockCountAllocation.count_id == count_id, StockCountAllocation.barcode == line_barcode).all()
    for a in old_allocations:
        if a.posted_advance_id:
            old_adv = db.query(EmployeeAdvance).filter(EmployeeAdvance.advance_id == a.posted_advance_id).first()
            if old_adv:
                if (old_adv.repaid_amount or 0) > 0:
                    raise HTTPException(400, "An employee has already made repayments against an existing advance for this line — settle or reverse those manually before reclassifying")
                db.delete(old_adv)
        db.delete(a)

    old_category = line.category
    line.category = body.category
    line.employee_user_id = ""
    if body.category == "split":
        for a in body.allocations:
            db.add(StockCountAllocation(
                count_id=count_id, barcode=line_barcode, employee_user_id=a.employeeUserId,
                percent=a.percent, deduction_month=a.deductionMonth or "",
            ))
    _post_shortage(db, line, row.store_id, row.store_name, today_str(), value, variance)
    line.notes = f"Reclassified from {old_category} by {user.name}" + (f" — {line.notes}" if line.notes else "")
    log_audit(
        db, user, "update", "stock_adjustment", line_barcode,
        f"Reclassified stock shortage: {line.name} — {old_category} → {body.category}",
        old_value={"category": old_category}, new_value={"category": body.category, "allocations": [a.dict() for a in body.allocations], "value": value},
    )
    db.commit()
    return {"ok": True, "status": "ok"}


@router.delete("/{count_id}")
def delete_count(
    count_id: str, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "draft":
        raise HTTPException(400, "Cannot delete an approved count — it already changed real inventory")
    db.query(StockCountLine).filter(StockCountLine.count_id == count_id).delete()
    db.delete(row)
    db.commit()
    return {"ok": True, "status": "ok"}


@router.post("/start")
def start_count(body: StartCountIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))]):
    cid = f"CNT-{int(time.time() * 1000)}"
    row = StockCount(count_id=cid, store_id=body.storeId, store_name=body.storeName or body.storeId, date=today_str(), counted_by=user.name, notes=body.notes or "")
    db.add(row)
    q = db.query(Inventory).filter(Inventory.store_id == body.storeId)
    if body.barcodes:
        q = q.filter(Inventory.barcode.in_(body.barcodes))
    inv_rows = q.all()
    for inv in inv_rows:
        db.add(StockCountLine(count_id=cid, barcode=inv.barcode, name=inv.name, system_qty=inv.on_hand or 0))
    db.commit()
    return {"ok": True, "status": "ok", "id": cid, "lineCount": len(inv_rows)}


@router.get("/{count_id}")
def get_count(count_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))]):
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    lines = db.query(StockCountLine).filter(StockCountLine.count_id == count_id).order_by(StockCountLine.id.asc()).all()
    costs = {p.barcode: p.cost or 0 for p in db.query(Product).filter(Product.barcode.in_([l.barcode for l in lines])).all()}
    allocs_by_barcode: dict = {}
    for a in db.query(StockCountAllocation).filter(StockCountAllocation.count_id == count_id).all():
        allocs_by_barcode.setdefault(a.barcode, []).append({
            "employeeUserId": a.employee_user_id, "percent": a.percent, "deductionMonth": a.deduction_month,
        })
    out_lines = []
    for l in lines:
        d = _line_out(l)
        d["cost"] = costs.get(l.barcode, 0)
        d["allocations"] = allocs_by_barcode.get(l.barcode, [])
        out_lines.append(d)
    return {
        "ok": True, "id": row.count_id, "storeId": row.store_id, "storeName": row.store_name,
        "date": row.date, "status": row.status, "countedBy": row.counted_by, "approvedBy": row.approved_by,
        "notes": row.notes, "lines": out_lines,
    }


@router.get("")
def list_counts(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))], status: Optional[str] = None, limit: int = 50):
    q = db.query(StockCount)
    if status:
        q = q.filter(StockCount.status == status)
    rows = q.order_by(StockCount.id.desc()).limit(limit).all()
    out = []
    for r in rows:
        lines = db.query(StockCountLine).filter(StockCountLine.count_id == r.count_id).all()
        counted_lines = [l for l in lines if l.physical_qty is not None]
        variance_lines = [l for l in counted_lines if l.physical_qty != l.system_qty]
        out.append({
            "id": r.count_id, "storeId": r.store_id, "storeName": r.store_name, "date": r.date,
            "status": r.status, "countedBy": r.counted_by, "approvedBy": r.approved_by,
            "totalLines": len(lines), "countedLines": len(counted_lines), "varianceLines": len(variance_lines),
        })
    return {"ok": True, "data": out}


class UploadCountLine(BaseModel):
    barcode: str
    qty: int = 1


class UploadCountIn(BaseModel):
    lines: list[UploadCountLine] = Field(default_factory=list)


@router.post("/{count_id}/upload")
def upload_count(
    count_id: str, body: UploadCountIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))],
):
    """Bulk-load a physical count from a scanned Excel/CSV file — the real
    workflow: staff scans every barcode on the shelf (a barcode scanner
    just types the number + Enter into Excel, so scanning the same item
    twice = two rows / a qty of 2), then this file gets uploaded here
    instead of anyone typing quantities by hand.

    Duplicate barcodes in the file are summed. A barcode that was never
    in the original system snapshot (something physically found that the
    system didn't expect at all) gets a new line with systemQty=0, so it
    still shows up as a positive variance rather than being silently
    dropped.
    """
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "draft":
        raise HTTPException(400, "This count is already approved and locked")
    scanned: dict[str, int] = {}
    for l in body.lines:
        if not l.barcode:
            continue
        scanned[l.barcode] = scanned.get(l.barcode, 0) + int(l.qty or 1)
    lines_by_barcode = {l.barcode: l for l in db.query(StockCountLine).filter(StockCountLine.count_id == count_id).all()}
    matched = 0
    new_items = 0
    for barcode, qty in scanned.items():
        line = lines_by_barcode.get(barcode)
        if line:
            line.physical_qty = qty
            matched += 1
        else:
            prod = db.query(Product).filter(Product.barcode == barcode).first()
            db.add(StockCountLine(count_id=count_id, barcode=barcode, name=(prod.name if prod else barcode), system_qty=0, physical_qty=qty))
            new_items += 1
    db.commit()
    return {"ok": True, "status": "ok", "matched": matched, "newItemsFound": new_items, "totalScanned": len(scanned)}


@router.put("/{count_id}/lines")
def update_count_lines(
    count_id: str, body: SubmitCountIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))],
):
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "draft":
        raise HTTPException(400, "This count is already approved and locked")
    lines_by_barcode = {l.barcode: l for l in db.query(StockCountLine).filter(StockCountLine.count_id == count_id).all()}
    updated = 0
    for u in body.lines:
        line = lines_by_barcode.get(u.barcode)
        if not line:
            continue
        if u.physicalQty is not None:
            line.physical_qty = u.physicalQty
        if u.reason:
            line.reason = u.reason
        if u.category:
            line.category = u.category
        if u.employeeUserId is not None:
            line.employee_user_id = u.employeeUserId
        updated += 1
    db.commit()
    return {"ok": True, "status": "ok", "updated": updated}


@router.put("/{count_id}/lines/{barcode}/allocations")
def set_line_allocations(
    count_id: str, barcode: str, body: SetAllocationsIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "warehouse"))],
):
    """Sets who shares a shortage's cost and at what %, before approval.
    Automatically switches the line's category to "split". Whatever %
    isn't allocated to named employees stays the company's share — so
    100% allocated = 0% company (fully staff-responsible), 50% allocated
    = 50/50, etc. Replaces any previously-set allocations for this line.
    """
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "draft":
        raise HTTPException(400, "This count is already approved and locked")
    line = db.query(StockCountLine).filter(StockCountLine.count_id == count_id, StockCountLine.barcode == barcode).first()
    if not line:
        raise HTTPException(404, "Line not found")
    total_pct = sum(a.percent for a in body.allocations)
    if total_pct > 100.0001:
        raise HTTPException(400, f"Allocated percentages add up to {total_pct}% — cannot exceed 100%")
    for a in body.allocations:
        if not a.employeeUserId:
            raise HTTPException(400, "Every allocation row needs an employee selected")
        if a.percent <= 0:
            raise HTTPException(400, "Every allocation row needs a percentage greater than 0")
    db.query(StockCountAllocation).filter(StockCountAllocation.count_id == count_id, StockCountAllocation.barcode == barcode).delete()
    for a in body.allocations:
        db.add(StockCountAllocation(
            count_id=count_id, barcode=barcode, employee_user_id=a.employeeUserId,
            percent=a.percent, deduction_month=a.deductionMonth or "",
        ))
    line.category = "split" if body.allocations else "shrinkage"
    db.commit()
    return {"ok": True, "status": "ok", "companyPercent": round(100 - total_pct, 2)}


def _post_shortage(db: Session, line: StockCountLine, store_id: str, store_name: str, date: str, value: float, variance: int, staff_percent: float = 0) -> None:
    """Posts the financial 'other side' of a shortage line, based on its
    category:
      - shrinkage / investigation → the whole value is a company
        Shrinkage Expense.
      - split → each StockCountAllocation row (one per employee sharing
        responsibility) gets its own Employee Advance for its % of the
        value; whatever % is left over (100% - sum of employee %) is the
        company's own Shrinkage Expense. This covers both "100% one or
        more employees, 0% company" and "50/50" (or any other ratio) —
        just different %s on the same mechanism.
    """
    if line.category == "split":
        allocations = db.query(StockCountAllocation).filter(
            StockCountAllocation.count_id == line.count_id, StockCountAllocation.barcode == line.barcode
        ).all()
        allocated_pct = sum(a.percent or 0 for a in allocations)
        for a in allocations:
            share = round(value * (a.percent or 0) / 100, 2)
            if share <= 0:
                continue
            emp = db.query(User).filter(User.user_id == a.employee_user_id).first()
            advance_id = f"ADV-{int(time.time()*1000)}-{line.id}-{a.id}"
            month_note = f" (deduct from {a.deduction_month} payroll)" if a.deduction_month else ""
            db.add(EmployeeAdvance(
                advance_id=advance_id, employee_name=emp.name if emp else a.employee_user_id,
                store_id=store_id, date=date, amount=share,
                reason=f"Stock shortage — {a.percent}% share — {line.name} ({variance}){month_note}", notes=line.reason or "",
            ))
            a.posted_advance_id = advance_id
        company_share = round(value * max(0.0, 100 - allocated_pct) / 100, 2)
        if company_share > 0:
            exp_id = f"EXP-{int(time.time()*1000)}-{line.id}"
            db.add(Expense(
                exp_id=exp_id, date=date, store_id=store_id, store=store_name,
                category="Inventory Shrinkage", sub_category="Non-cash",
                description=f"Shortage — Company share ({round(100-allocated_pct,1)}%) — {line.name} ({variance})", amount=company_share,
                pay_method="Non-cash", reference=line.count_id, notes=line.reason or "",
            ))
            line.posted_expense_id = exp_id
        else:
            line.posted_expense_id = ""
    else:
        # Default: shrinkage (or investigation, pending reclassification later) — company absorbs it as a non-cash expense.
        tag = " — pending investigation" if line.category == "investigation" else ""
        exp_id = f"EXP-{int(time.time()*1000)}-{line.id}"
        db.add(Expense(
            exp_id=exp_id, date=date, store_id=store_id, store=store_name,
            category="Inventory Shrinkage", sub_category="Non-cash",
            description=f"Shortage{tag} — {line.name} ({variance})", amount=value, pay_method="Non-cash",
            reference=line.count_id, notes=line.reason or "",
        ))
        line.posted_expense_id = exp_id


@router.post("/{count_id}/approve")
def approve_count(
    count_id: str, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    """This is the moment a physical count's variance becomes real:
    Inventory changes, AND the financial "other side" is posted so the
    Balance Sheet stays in balance — a shortage can't just shrink
    Inventory Value without a matching Expense (or Employee Advance)
    appearing somewhere, or Assets would stop equalling Liabilities+Equity.

    Per line with a shortage (negative variance), category decides where
    the value goes:
      - shrinkage / investigation → "Inventory Shrinkage" Expense (a real,
        non-cash P&L cost — the company absorbs it)
      - employee_fault → an Employee Advance Receivable against the named
        employee instead (no P&L hit — they owe it back, the company
        hasn't actually lost the money)
    Overage (extra found) always posts as a non-cash "Inventory Gain"
    (a negative Expense, so it reduces total costs / raises profit).

    If the total shortage value on this count exceeds the configured
    threshold, only an Admin (not a Manager) can approve — Lines without
    a physical count entered are skipped (treated as "not yet counted").
    """
    row = db.query(StockCount).filter(StockCount.count_id == count_id).first()
    if not row:
        raise HTTPException(404, "Count not found")
    if row.status != "draft":
        raise HTTPException(400, "Already approved")
    lines = db.query(StockCountLine).filter(StockCountLine.count_id == count_id).all()

    settings_map = {s.key: s.value for s in db.query(Setting).filter(Setting.key.in_(["stock_count_admin_threshold", "store_staff_liability_percent"])).all()}
    admin_threshold = float(settings_map.get("stock_count_admin_threshold", 500))
    staff_percent = float(settings_map.get("store_staff_liability_percent", 50))
    products = {p.barcode: p for p in db.query(Product).filter(Product.barcode.in_([l.barcode for l in lines])).all()}
    total_shortage_value = 0.0
    for l in lines:
        if l.physical_qty is None:
            continue
        variance = l.physical_qty - l.system_qty
        if variance < 0:
            cost = float(products[l.barcode].cost or 0) if l.barcode in products else 0
            total_shortage_value += abs(variance) * cost
    if total_shortage_value > admin_threshold and user.role != "admin":
        raise HTTPException(
            403,
            f"Total shortage value ({round(total_shortage_value,2)}) exceeds the admin-approval threshold ({admin_threshold}) — an Admin must approve this count.",
        )

    applied = 0
    for l in lines:
        if l.physical_qty is None:
            continue
        variance = l.physical_qty - l.system_qty
        if variance == 0:
            continue
        inv = get_or_create_inv(db, l.barcode, row.store_name, row.store_id, l.name)
        inv.adjustments = (inv.adjustments or 0) + variance
        inv.recalc()
        applied += 1
        cost = float(products[l.barcode].cost or 0) if l.barcode in products else 0
        value = round(abs(variance) * cost, 2)

        if variance > 0:
            # Overage — non-cash gain, reduces total costs on the P&L.
            exp_id = f"EXP-{int(time.time()*1000)}-{l.id}"
            db.add(Expense(
                exp_id=exp_id, date=row.date, store_id=row.store_id, store=row.store_name,
                category="Inventory Gain (Stock Count)", sub_category="Non-cash",
                description=f"Overage found — {l.name} (+{variance})", amount=-value, pay_method="Non-cash",
                reference=count_id, notes=l.reason or "",
            ))
            l.posted_expense_id = exp_id
        else:
            _post_shortage(db, l, row.store_id, row.store_name, row.date, value, variance, staff_percent)

        log_audit(
            db, user, "update", "stock_adjustment", l.barcode,
            f"Stock count: {l.name} — system {l.system_qty}, counted {l.physical_qty} ({'+' if variance > 0 else ''}{variance}), value {value}, category {l.category if variance < 0 else 'overage'}",
            old_value={"systemQty": l.system_qty}, new_value={"physicalQty": l.physical_qty, "variance": variance, "category": l.category, "value": value},
        )
    row.status = "approved"
    row.approved_by = user.name
    from datetime import datetime
    row.approved_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "status": "ok", "linesAdjusted": applied, "totalShortageValue": round(total_shortage_value, 2)}


@router.post("/quick-adjust")
def quick_adjust(
    body: QuickAdjustIn, db: Annotated[Session, Depends(get_db)],
    user: Annotated[CurrentUser, Depends(require_role("admin", "manager"))],
):
    """A single-item correction outside a full count — e.g. one damaged
    pair found on the shelf. Manager/admin only, reason required, and
    logged to the Audit Log just like a full count's approval.
    """
    if not body.reason.strip():
        raise HTTPException(400, "A reason is required for any stock adjustment")
    inv = get_or_create_inv(db, body.barcode, body.storeName or body.storeId, body.storeId, body.name)
    old_qty = inv.on_hand or 0
    variance = body.newQty - old_qty
    if variance == 0:
        return {"ok": True, "status": "no_change"}
    inv.adjustments = (inv.adjustments or 0) + variance
    inv.recalc()
    log_audit(
        db, user, "update", "stock_adjustment", body.barcode,
        f"Quick adjustment: {body.name or body.barcode} — {old_qty} → {body.newQty} ({'+' if variance > 0 else ''}{variance}) — {body.reason}",
        old_value={"qty": old_qty}, new_value={"qty": body.newQty, "reason": body.reason},
    )
    db.commit()
    return {"ok": True, "status": "ok", "newQty": inv.on_hand}
