from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import SessionDep
from app.models import Notification
from app.schemas import NotificationOut

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut])
def list_notifications(session: SessionDep, party_id: int | None = None, order_id: int | None = None, limit: int = 50):
    stmt = select(Notification).order_by(Notification.id.desc()).limit(limit)
    if party_id is not None:
        stmt = stmt.where(Notification.party_id == party_id)
    if order_id is not None:
        stmt = stmt.where(Notification.order_id == order_id)
    return session.scalars(stmt).all()
