from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Order, Party
from app.notifications import NotificationChannel, get_channel

SessionDep = Annotated[Session, Depends(get_session)]
ChannelDep = Annotated[NotificationChannel, Depends(get_channel)]


def get_or_404(session: Session, model, key, label: str):
    obj = session.get(model, key)
    if obj is None:
        raise HTTPException(404, f"{label} {key} not found")
    return obj


def order_or_404(session: Session, order_id: int) -> Order:
    return get_or_404(session, Order, order_id, "order")


def party_or_404(session: Session, party_id: int) -> Party:
    return get_or_404(session, Party, party_id, "party")
