import enum
from datetime import datetime

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.clock import utcnow
from app.db import Base


class NotificationKind(str, enum.Enum):
    stockist_summary = "stockist_summary"
    retailer_delay = "retailer_delay"
    alternatives = "alternatives"
    switch_confirmed = "switch_confirmed"
    order_switched_away = "order_switched_away"
    new_order = "new_order"


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    party_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))
    disruption_id: Mapped[int | None] = mapped_column(ForeignKey("disruptions.id"))
    kind: Mapped[NotificationKind] = mapped_column(Enum(NotificationKind, native_enum=False, length=30))
    message: Mapped[str] = mapped_column(Text)
    buttons: Mapped[list] = mapped_column(JSON, default=list)
    channel: Mapped[str] = mapped_column(String(20))  # telegram | none
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
