"""Chart of Accounts + auto journal posting for sales/expenses."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Account, JournalEntry, JournalLine, Setting
from ..utils import today_str

DEFAULT_COA = [
    ("1000", "Cash", "asset"),
    ("1100", "Bank", "asset"),
    ("1200", "Inventory", "asset"),
    ("2000", "Accounts Payable", "liability"),
    ("3000", "Owner Equity", "equity"),
    ("4000", "Sales Revenue", "income"),
    ("4100", "Sales Discounts", "income"),
    ("5000", "Cost of Goods Sold", "expense"),
    ("5100", "Operating Expenses", "expense"),
    ("5200", "Rent Expense", "expense"),
    ("5300", "Salaries Expense", "expense"),
    ("5400", "Utilities Expense", "expense"),
    ("5900", "Other Expense", "expense"),
]

EXPENSE_CAT_MAP = {
    "rent": "5200",
    "salaries": "5300",
    "salary": "5300",
    "utilities": "5400",
    "utility": "5400",
}


def _setting(db: Session, key: str, default: str = "") -> str:
    row = db.query(Setting).filter(Setting.key == key).first()
    return (row.value if row else default) or default


def ensure_coa(db: Session) -> None:
    if db.query(Account).count():
        return
    for code, name, atype in DEFAULT_COA:
        db.add(Account(code=code, name=name, type=atype, active=True))
    db.flush()


def _acct(db: Session, code: str) -> Account | None:
    return db.query(Account).filter(Account.code == code, Account.active.is_(True)).first()


def _next_je_no(db: Session) -> str:
    n = db.query(JournalEntry).count() + 1
    return f"JE-{n:06d}"


def post_journal(
    db: Session,
    *,
    date: str,
    memo: str,
    source_type: str,
    source_id: str,
    lines: list[tuple[str, float, float, str]],
) -> JournalEntry | None:
    """lines: list of (account_code, debit, credit, memo)."""
    ensure_coa(db)
    existing = (
        db.query(JournalEntry)
        .filter(JournalEntry.source_type == source_type, JournalEntry.source_id == source_id)
        .first()
    )
    if existing:
        return existing

    clean = []
    for code, debit, credit, line_memo in lines:
        d = round(float(debit or 0), 2)
        c = round(float(credit or 0), 2)
        if d == 0 and c == 0:
            continue
        acc = _acct(db, code)
        if not acc:
            continue
        clean.append((acc, d, c, line_memo or ""))
    if not clean:
        return None

    total_d = round(sum(x[1] for x in clean), 2)
    total_c = round(sum(x[2] for x in clean), 2)
    if total_d != total_c:
        # balance residual to equity/clearing cash side if tiny float issues
        diff = round(total_d - total_c, 2)
        if abs(diff) <= 0.05 and clean:
            if diff > 0:
                clean[-1] = (clean[-1][0], clean[-1][1], round(clean[-1][2] + diff, 2), clean[-1][3])
            else:
                clean[-1] = (clean[-1][0], round(clean[-1][1] - diff, 2), clean[-1][2], clean[-1][3])
        else:
            return None

    je = JournalEntry(
        entry_no=_next_je_no(db),
        date=date or today_str(),
        memo=memo or "",
        source_type=source_type,
        source_id=source_id,
        posted=True,
    )
    db.add(je)
    db.flush()
    for acc, d, c, line_memo in clean:
        db.add(
            JournalLine(
                entry_id=je.id,
                account_id=acc.id,
                debit=d,
                credit=c,
                memo=line_memo,
            )
        )
    return je


def post_sale_journal(db: Session, sale) -> None:
    total = float(sale.total or 0)
    discount = float(sale.discount or 0) + float(sale.global_discount or 0)
    subtotal = float(sale.subtotal or 0) or (total + discount)
    if total <= 0 and subtotal <= 0:
        return

    pay = (sale.payment or "Cash").lower()
    cash_code = "1000" if "cash" in pay else "1100"

    # COGS estimate from line costs if present
    cogs = 0.0
    try:
        import json

        items = json.loads(sale.items_json or "[]")
        for it in items:
            cogs += float(it.get("cost") or 0) * float(it.get("qty") or 1)
    except Exception:
        cogs = 0.0

    lines = [
        (cash_code, total, 0.0, f"Sale {sale.invoice_id}"),
        ("4000", 0.0, subtotal, f"Revenue {sale.invoice_id}"),
    ]
    if discount > 0:
        lines.append(("4100", discount, 0.0, f"Discount {sale.invoice_id}"))
    if cogs > 0:
        lines.extend(
            [
                ("5000", cogs, 0.0, f"COGS {sale.invoice_id}"),
                ("1200", 0.0, cogs, f"Inventory out {sale.invoice_id}"),
            ]
        )
    post_journal(
        db,
        date=sale.date,
        memo=f"Auto sale {sale.invoice_id}",
        source_type="sale",
        source_id=sale.invoice_id,
        lines=lines,
    )


def post_expense_journal(db: Session, exp) -> None:
    amount = float(exp.amount or 0)
    if amount <= 0:
        return
    cat = (exp.category or "").strip().lower()
    exp_code = EXPENSE_CAT_MAP.get(cat, "5100")
    if exp_code == "5100" and cat in ("other", ""):
        exp_code = "5900"
    pay = (exp.pay_method or "Cash").lower()
    cash_code = "1000" if "cash" in pay else "1100"
    post_journal(
        db,
        date=exp.date,
        memo=f"Expense {exp.exp_id} {exp.category}",
        source_type="expense",
        source_id=exp.exp_id,
        lines=[
            (exp_code, amount, 0.0, exp.description or exp.category or ""),
            (cash_code, 0.0, amount, f"Pay {exp.exp_id}"),
        ],
    )
