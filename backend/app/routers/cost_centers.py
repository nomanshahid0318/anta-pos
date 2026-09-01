"""Cost Centers & Projects — lets expenses (and therefore P&L) be sliced
by department/function or by a specific initiative, not just by store.
"""
from __future__ import annotations

import time
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import CurrentUser, require_role
from ..database import get_db
from ..models import CostCenter, Expense, Project

router = APIRouter(prefix="/api/ho", tags=["cost-centers"])


class CostCenterIn(BaseModel):
    code: str
    name: str
    active: bool = True


class ProjectIn(BaseModel):
    projectId: Optional[str] = None
    name: str
    storeId: str = ""
    status: str = "active"
    startDate: str = ""
    endDate: str = ""
    notes: str = ""


@router.get("/cost-centers")
def list_cost_centers(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))]):
    rows = db.query(CostCenter).order_by(CostCenter.code.asc()).all()
    return {"ok": True, "data": [{"id": r.id, "code": r.code, "name": r.name, "active": r.active} for r in rows]}


@router.post("/cost-centers")
def create_cost_center(body: CostCenterIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "accountant"))]):
    if db.query(CostCenter).filter(CostCenter.code == body.code).first():
        raise HTTPException(400, f"Cost Center code '{body.code}' already exists")
    row = CostCenter(code=body.code, name=body.name, active=body.active)
    db.add(row)
    db.commit()
    return {"ok": True, "status": "ok", "id": row.id}


@router.delete("/cost-centers/{cc_id}")
def delete_cost_center(cc_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin"))]):
    row = db.query(CostCenter).filter(CostCenter.id == cc_id).first()
    if not row:
        raise HTTPException(404, "Not found")
    in_use = db.query(Expense).filter(Expense.cost_center_id == row.code).first()
    if in_use:
        raise HTTPException(400, "Cost Center is used by existing expenses — deactivate it instead of deleting")
    db.delete(row)
    db.commit()
    return {"ok": True, "status": "ok"}


@router.get("/projects")
def list_projects(db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))]):
    rows = db.query(Project).order_by(Project.id.desc()).all()
    return {"ok": True, "data": [
        {"id": r.project_id, "name": r.name, "storeId": r.store_id, "status": r.status,
         "startDate": r.start_date, "endDate": r.end_date, "notes": r.notes}
        for r in rows
    ]}


@router.post("/projects")
def create_project(body: ProjectIn, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))]):
    pid = body.projectId or f"PRJ-{int(time.time()*1000)}"
    existing = db.query(Project).filter(Project.project_id == pid).first()
    if existing:
        existing.name = body.name
        existing.store_id = body.storeId
        existing.status = body.status
        existing.start_date = body.startDate
        existing.end_date = body.endDate
        existing.notes = body.notes
    else:
        db.add(Project(project_id=pid, name=body.name, store_id=body.storeId, status=body.status, start_date=body.startDate, end_date=body.endDate, notes=body.notes))
    db.commit()
    return {"ok": True, "status": "ok", "id": pid}


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin"))]):
    row = db.query(Project).filter(Project.project_id == project_id).first()
    if not row:
        raise HTTPException(404, "Not found")
    in_use = db.query(Expense).filter(Expense.project_id == project_id).first()
    if in_use:
        raise HTTPException(400, "Project is used by existing expenses — close it instead of deleting")
    db.delete(row)
    db.commit()
    return {"ok": True, "status": "ok"}


@router.get("/pl-by-costcenter")
def pl_by_cost_center(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    dateFrom: Optional[str] = None, dateTo: Optional[str] = None,
):
    """Total expenses grouped by Cost Center for a date range — 'where is
    our overhead actually going', broken out from the store-level P&L.
    """
    q = db.query(Expense)
    if dateFrom:
        q = q.filter(Expense.date >= dateFrom)
    if dateTo:
        q = q.filter(Expense.date <= dateTo)
    rows = q.all()
    centers = {c.code: c.name for c in db.query(CostCenter).all()}
    by_cc: dict = {}
    for e in rows:
        key = e.cost_center_id or "(unassigned)"
        by_cc.setdefault(key, 0.0)
        by_cc[key] += e.amount or 0
    data = [{"costCenterId": k, "costCenterName": centers.get(k, k), "totalExpense": round(v, 2)} for k, v in by_cc.items()]
    data.sort(key=lambda d: -d["totalExpense"])
    return {"ok": True, "data": data, "grandTotal": round(sum(d["totalExpense"] for d in data), 2)}


@router.get("/pl-by-project")
def pl_by_project(
    db: Annotated[Session, Depends(get_db)], user: Annotated[CurrentUser, Depends(require_role("admin", "manager", "accountant"))],
    dateFrom: Optional[str] = None, dateTo: Optional[str] = None,
):
    q = db.query(Expense).filter(Expense.project_id != "")
    if dateFrom:
        q = q.filter(Expense.date >= dateFrom)
    if dateTo:
        q = q.filter(Expense.date <= dateTo)
    rows = q.all()
    projects = {p.project_id: p.name for p in db.query(Project).all()}
    by_proj: dict = {}
    for e in rows:
        by_proj.setdefault(e.project_id, 0.0)
        by_proj[e.project_id] += e.amount or 0
    data = [{"projectId": k, "projectName": projects.get(k, k), "totalExpense": round(v, 2)} for k, v in by_proj.items()]
    data.sort(key=lambda d: -d["totalExpense"])
    return {"ok": True, "data": data}
