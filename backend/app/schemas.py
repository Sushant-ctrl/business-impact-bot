from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models import DisruptionCause, NotificationKind, Order, OrderStatus, PartyRole, PaymentMode
from app.services.disruptions import AffectedOrder


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class PartyIn(BaseModel):
    name: str
    role: PartyRole
    area: str
    phone: str | None = None
    trusted: bool = True


class PartyOut(ORM):
    id: int
    name: str
    role: PartyRole
    area: str
    phone: str | None
    chat_id: str | None
    trusted: bool


class LinkChatIn(BaseModel):
    phone: str
    chat_id: str


class ServiceAreasIn(BaseModel):
    areas: list[str] = Field(min_length=1)


class ProductIn(ORM):
    sku: str
    name: str
    unit: str = "unit"


class InventoryIn(BaseModel):
    sku: str
    on_hand: int = Field(ge=0)
    reserved: int = Field(default=0, ge=0)


class InventoryOut(ORM):
    sku: str
    on_hand: int
    reserved: int
    available: int


class OrderLineIn(BaseModel):
    sku: str
    qty: int = Field(gt=0)


class OrderLineOut(ORM):
    sku: str
    qty: int


class OrderIn(BaseModel):
    buyer_id: int
    supplier_id: int
    lines: list[OrderLineIn] = Field(min_length=1)
    payment_mode: PaymentMode = PaymentMode.cod
    needed_by: date | None = None


class OrderEventOut(ORM):
    status: OrderStatus
    timestamp: datetime
    note: str | None


class OrderOut(ORM):
    id: int
    buyer_id: int
    buyer_name: str
    supplier_id: int
    supplier_name: str
    status: OrderStatus
    payment_mode: PaymentMode
    delivery_area: str
    created_at: datetime
    promised_date: date
    expected_delivery_date: date
    needed_by: date | None
    delivered_at: datetime | None
    switched_to_id: int | None
    lines: list[OrderLineOut]

    @classmethod
    def of(cls, order: Order) -> "OrderOut":
        return cls.model_validate(
            {
                **{k: getattr(order, k) for k in cls.model_fields if hasattr(order, k)},
                "buyer_name": order.buyer.name,
                "supplier_name": order.supplier.name,
                "lines": order.lines,
            }
        )


class OrderDisruptionOut(ORM):
    disruption_id: int
    original_eta: date
    revised_eta: date
    actual_delivery: date | None


class OrderDetailOut(OrderOut):
    events: list[OrderEventOut]
    disruptions: list[OrderDisruptionOut]


class OrderEventIn(BaseModel):
    status: OrderStatus
    note: str | None = None


class NeededByIn(BaseModel):
    needed_by: date | None = None
    days_left: int | None = Field(default=None, ge=0)


class AlternativeOut(ORM):
    stockist_id: int
    name: str
    eta: date
    coverage: float
    missing_skus: list[str]
    on_time_rate: float | None
    basis: str
    disrupted: bool


class AlternativesOut(ORM):
    order_id: int
    eligible: bool
    needed_by: date | None
    days_left: int | None
    current_eta: date
    arrives_in_time: bool | None
    alternatives: list[AlternativeOut]


class SwitchIn(BaseModel):
    stockist_id: int


class SwitchOut(BaseModel):
    old_order: OrderOut
    new_order: OrderOut
    remaining_qty: int


class DisruptionIn(BaseModel):
    stockist_id: int
    cause: DisruptionCause
    areas: list[str] = Field(default_factory=list, description="Pincodes; empty means all served areas")
    extra_delay_days: int | None = Field(default=None, ge=0)
    expected_clear_date: date | None = None
    note: str | None = Field(default=None, max_length=500)


class DisruptionOut(ORM):
    id: int
    stockist_id: int
    cause: DisruptionCause
    affected_areas: list[str]
    extra_delay_days: int | None
    expected_clear_date: date | None
    note: str | None
    reported_at: datetime
    resolved_at: datetime | None


class AffectedOrderOut(BaseModel):
    order_id: int
    retailer_id: int
    retailer_name: str
    area: str
    payment_mode: PaymentMode
    original_eta: date
    revised_eta: date
    slip_days: int
    lane_basis: str

    @classmethod
    def of(cls, a: AffectedOrder) -> "AffectedOrderOut":
        return cls(
            order_id=a.order.id,
            retailer_id=a.order.buyer_id,
            retailer_name=a.order.buyer.name,
            area=a.order.delivery_area,
            payment_mode=a.order.payment_mode,
            original_eta=a.original_eta,
            revised_eta=a.revised_eta,
            slip_days=a.slip_days,
            lane_basis=a.lane.basis,
        )


class DisruptionReportOut(BaseModel):
    disruption: DisruptionOut | None  # None for a dry run
    delay_basis: str
    affected: list[AffectedOrderOut]
    cod_count: int


class LaneOut(ORM):
    stockist_id: int
    area: str
    n: int
    median_days: int
    p80_days: int
    on_time_rate: float | None
    scope: str
    basis: str


class NotificationOut(ORM):
    id: int
    party_id: int
    order_id: int | None
    disruption_id: int | None
    kind: NotificationKind
    message: str
    buttons: list
    channel: str
    sent_at: datetime
