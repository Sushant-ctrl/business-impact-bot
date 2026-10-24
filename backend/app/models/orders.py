import enum
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.clock import utcnow
from app.db import Base
from app.models.network import Party


class OrderStatus(str, enum.Enum):
    placed = "placed"
    confirmed = "confirmed"
    dispatched = "dispatched"
    delivered = "delivered"
    cancelled = "cancelled"


OPEN_STATUSES = (OrderStatus.placed, OrderStatus.confirmed, OrderStatus.dispatched)


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    status: Mapped[OrderStatus] = mapped_column(
        Enum(OrderStatus, native_enum=False, length=20), default=OrderStatus.placed, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    promised_date: Mapped[date] = mapped_column(Date)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime)
    rerouted_from_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"))

    buyer: Mapped[Party] = relationship(foreign_keys=[buyer_id])
    supplier: Mapped[Party] = relationship(foreign_keys=[supplier_id])
    lines: Mapped[list["OrderLine"]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )
    events: Mapped[list["OrderEvent"]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="OrderEvent.timestamp"
    )

    @property
    def is_open(self) -> bool:
        return self.status in OPEN_STATUSES


class OrderLine(Base):
    __tablename__ = "order_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    sku: Mapped[str] = mapped_column(ForeignKey("products.sku"))
    qty: Mapped[int] = mapped_column(Integer)

    order: Mapped[Order] = relationship(back_populates="lines")


class OrderEvent(Base):
    __tablename__ = "order_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    status: Mapped[OrderStatus] = mapped_column(Enum(OrderStatus, native_enum=False, length=20))
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    note: Mapped[str | None] = mapped_column(String(500))

    order: Mapped[Order] = relationship(back_populates="events")
