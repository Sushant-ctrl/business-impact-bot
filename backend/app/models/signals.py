import enum
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.clock import utcnow
from app.db import Base


class RiskScore(Base):
    __tablename__ = "risk_scores"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    score: Mapped[float] = mapped_column(Float)
    level: Mapped[str] = mapped_column(String(10))
    expected_delay_days: Mapped[float] = mapped_column(Float, default=0.0)
    reasons: Mapped[list] = mapped_column(JSON, default=list)
    computed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class AlertType(str, enum.Enum):
    delay_risk = "delay_risk"
    downstream_delay = "downstream_delay"
    reorder = "reorder"


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(primary_key=True)
    party_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))
    sku: Mapped[str | None] = mapped_column(ForeignKey("products.sku"))
    type: Mapped[AlertType] = mapped_column(Enum(AlertType, native_enum=False, length=30))
    message: Mapped[str] = mapped_column(String(1000))
    sent_via: Mapped[str] = mapped_column(String(40), default="dashboard")
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
