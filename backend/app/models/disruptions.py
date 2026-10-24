import enum
from datetime import date, datetime

from sqlalchemy import JSON, Date, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.clock import utcnow
from app.db import Base
from app.models.network import Party
from app.models.orders import Order


class DisruptionCause(str, enum.Enum):
    weather = "weather"
    road_closure = "road_closure"
    landslide = "landslide"
    flood = "flood"
    strike = "strike"
    vehicle_breakdown = "vehicle_breakdown"
    other = "other"


class Disruption(Base):
    """An unexpected event, reported by a stockist, that delays its deliveries to some pincodes."""

    __tablename__ = "disruptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    stockist_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    cause: Mapped[DisruptionCause] = mapped_column(Enum(DisruptionCause, native_enum=False, length=30))
    affected_areas: Mapped[list[str]] = mapped_column(JSON, default=list)  # empty = all served areas
    extra_delay_days: Mapped[int | None] = mapped_column(Integer)
    expected_clear_date: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(String(500))
    reported_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)

    stockist: Mapped[Party] = relationship()
    order_links: Mapped[list["OrderDisruption"]] = relationship(back_populates="disruption")

    @property
    def is_active(self) -> bool:
        return self.resolved_at is None

    def covers(self, area: str) -> bool:
        return not self.affected_areas or area in self.affected_areas


class OrderDisruption(Base):
    """An order hit by a disruption. `actual_delivery − original_eta` is what we learn from."""

    __tablename__ = "order_disruptions"
    __table_args__ = (UniqueConstraint("order_id", "disruption_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    disruption_id: Mapped[int] = mapped_column(ForeignKey("disruptions.id"), index=True)
    original_eta: Mapped[date] = mapped_column(Date)
    revised_eta: Mapped[date] = mapped_column(Date)
    actual_delivery: Mapped[date | None] = mapped_column(Date)

    order: Mapped[Order] = relationship()
    disruption: Mapped[Disruption] = relationship(back_populates="order_links")
