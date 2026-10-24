"""State-changing operations: placing orders, reporting disruptions, switching stockists."""

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.clock import today, utcnow
from app.models import (
    Disruption,
    DisruptionCause,
    NotificationKind,
    Order,
    OrderDisruption,
    OrderEvent,
    OrderLine,
    OrderStatus,
    Party,
    PartyRole,
    PaymentMode,
)
from app.notifications import NotificationChannel, notify
from app.services import messages
from app.services.alternatives import find_alternatives, rank_candidates
from app.services.disruptions import DisruptionImpact, active_disruptions, apply_delay, assess, delay_for
from app.services.lanes import LaneBook
from app.services.stock import free_stock


class WorkflowError(ValueError):
    pass


def require_party(session: Session, party_id: int, role: PartyRole) -> Party:
    party = session.get(Party, party_id)
    if party is None or party.role != role:
        raise WorkflowError(f"{role.value} {party_id} not found")
    return party


def latest_disruption_id(session: Session, order_id: int) -> int | None:
    return session.scalar(
        select(OrderDisruption.disruption_id)
        .where(OrderDisruption.order_id == order_id)
        .order_by(OrderDisruption.id.desc())
        .limit(1)
    )


def create_order(
    session: Session,
    channel: NotificationChannel,
    buyer_id: int,
    supplier_id: int,
    lines: list[tuple[str, int]],
    payment_mode: PaymentMode = PaymentMode.cod,
    needed_by: date | None = None,
    as_of: date | None = None,
) -> Order:
    as_of = as_of or today()
    buyer = require_party(session, buyer_id, PartyRole.retailer)
    supplier = require_party(session, supplier_id, PartyRole.stockist)
    if not lines or any(qty <= 0 for _, qty in lines):
        raise WorkflowError("order needs at least one line with a positive quantity")

    lane = LaneBook(session, as_of).estimate(supplier.id, buyer.area)
    promised = as_of + timedelta(days=lane.p80_days)
    order = Order(
        buyer_id=buyer.id,
        supplier_id=supplier.id,
        payment_mode=payment_mode,
        delivery_area=buyer.area,
        promised_date=promised,
        expected_delivery_date=promised,
        needed_by=needed_by,
        lines=[OrderLine(sku=sku, qty=qty) for sku, qty in lines],
        events=[OrderEvent(status=OrderStatus.placed, note=f"Promised in {lane.p80_days} day(s): {lane.basis}")],
    )
    session.add(order)
    session.flush()

    # An order placed into an already-disrupted lane starts out delayed.
    for disruption in active_disruptions(session, supplier.id):
        if disruption.covers(buyer.area):
            revised = apply_delay(order.expected_delivery_date, delay_for(session, disruption), lane, as_of)
            session.add(
                OrderDisruption(
                    order_id=order.id,
                    disruption_id=disruption.id,
                    original_eta=order.expected_delivery_date,
                    revised_eta=revised,
                )
            )
            order.expected_delivery_date = revised

    session.commit()
    return order


_TRANSITIONS = {
    OrderStatus.placed: {OrderStatus.confirmed, OrderStatus.dispatched, OrderStatus.delivered, OrderStatus.cancelled},
    OrderStatus.confirmed: {OrderStatus.dispatched, OrderStatus.delivered, OrderStatus.cancelled},
    OrderStatus.dispatched: {OrderStatus.delivered, OrderStatus.cancelled},
}


def record_event(
    session: Session, order: Order, status: OrderStatus, note: str | None = None, at: datetime | None = None
) -> Order:
    if status not in _TRANSITIONS.get(order.status, set()):
        raise WorkflowError(f"cannot move order {order.id} from {order.status.value} to {status.value}")
    at = at or utcnow()
    order.status = status
    order.events.append(OrderEvent(status=status, timestamp=at, note=note))
    if status == OrderStatus.delivered:
        order.delivered_at = at
        # Record the real outcome so future estimates for this kind of disruption improve.
        for link in session.scalars(select(OrderDisruption).where(OrderDisruption.order_id == order.id)):
            link.actual_delivery = at.date()
    session.commit()
    return order


def set_needed_by(
    session: Session,
    order: Order,
    needed_by: date | None = None,
    days_left: int | None = None,
    as_of: date | None = None,
) -> Order:
    if (needed_by is None) == (days_left is None):
        raise WorkflowError("give exactly one of needed_by or days_left")
    if days_left is not None:
        if days_left < 0:
            raise WorkflowError("days_left cannot be negative")
        needed_by = (as_of or today()) + timedelta(days=days_left)
    order.needed_by = needed_by
    session.commit()
    return order


def report_disruption(
    session: Session,
    channel: NotificationChannel,
    stockist_id: int,
    cause: DisruptionCause,
    areas: list[str],
    extra_delay_days: int | None = None,
    expected_clear_date: date | None = None,
    note: str | None = None,
    as_of: date | None = None,
) -> tuple[Disruption, DisruptionImpact]:
    as_of = as_of or today()
    stockist = require_party(session, stockist_id, PartyRole.stockist)
    if extra_delay_days is not None and extra_delay_days < 0:
        raise WorkflowError("extra_delay_days cannot be negative")

    impact = assess(session, stockist.id, cause, areas, extra_delay_days, expected_clear_date, as_of)
    disruption = Disruption(
        stockist_id=stockist.id,
        cause=cause,
        affected_areas=sorted(set(areas)),
        extra_delay_days=extra_delay_days,
        expected_clear_date=expected_clear_date,
        note=note,
    )
    session.add(disruption)
    session.flush()

    for a in impact.affected:
        session.add(
            OrderDisruption(
                order_id=a.order.id, disruption_id=disruption.id, original_eta=a.original_eta, revised_eta=a.revised_eta
            )
        )
        a.order.expected_delivery_date = a.revised_eta
        a.order.events.append(
            OrderEvent(
                status=a.order.status,
                note=f"Delayed by disruption #{disruption.id} ({cause.value}); new ETA {a.revised_eta.isoformat()}",
            )
        )
    session.flush()

    shown = asked = 0
    for a in impact.affected:
        alternatives = find_alternatives(session, a.order, as_of)
        shown += bool(alternatives.alternatives)
        asked += alternatives.eligible and alternatives.needed_by is None
        text, buttons = messages.retailer_delay(disruption, a, alternatives)
        notify(
            session, channel, a.order.buyer, NotificationKind.retailer_delay, text, buttons,
            order_id=a.order.id, disruption_id=disruption.id,
        )

    summary = messages.stockist_summary(disruption, impact.delay, impact.affected, shown, asked)
    notify(session, channel, stockist, NotificationKind.stockist_summary, summary, disruption_id=disruption.id)
    session.commit()
    return disruption, impact


def resolve_disruption(session: Session, disruption: Disruption, at: datetime | None = None) -> Disruption:
    if disruption.resolved_at is not None:
        raise WorkflowError(f"disruption {disruption.id} is already resolved")
    disruption.resolved_at = at or utcnow()
    session.commit()
    return disruption


@dataclass
class SwitchResult:
    old_order: Order
    new_order: Order
    remaining_qty: int


def switch_order(
    session: Session, channel: NotificationChannel, order: Order, stockist_id: int, as_of: date | None = None
) -> SwitchResult:
    as_of = as_of or today()
    if order.payment_mode != PaymentMode.cod:
        raise WorkflowError("only cash-on-delivery orders can be switched")
    if not order.is_open:
        raise WorkflowError(f"order {order.id} is {order.status.value}")

    # Deadline isn't enforced here: the retailer may knowingly pick a stockist that's slightly later.
    candidate = next((c for c in rank_candidates(session, order, as_of, None) if c.stockist_id == stockist_id), None)
    if candidate is None:
        raise WorkflowError(f"stockist {stockist_id} can't supply this order to {order.delivery_area}")

    stock = free_stock(session, stockist_id)
    moved = [(line, min(line.qty, stock.get(line.sku, 0))) for line in order.lines]
    disruption_id = latest_disruption_id(session, order.id)

    new = Order(
        buyer_id=order.buyer_id,
        supplier_id=stockist_id,
        payment_mode=PaymentMode.cod,
        delivery_area=order.delivery_area,
        promised_date=candidate.eta,
        expected_delivery_date=candidate.eta,
        needed_by=order.needed_by,
        lines=[OrderLine(sku=line.sku, qty=qty) for line, qty in moved if qty > 0],
        events=[OrderEvent(status=OrderStatus.placed, note=f"Switched from order #{order.id}")],
    )
    session.add(new)
    session.flush()

    remaining = sum(line.qty - qty for line, qty in moved)
    if remaining:
        # Partial switch: the original stockist still owes what the new one couldn't cover.
        for line, qty in moved:
            line.qty -= qty
        for line in [l for l in order.lines if l.qty == 0]:
            order.lines.remove(line)
    order.switched_to_id = new.id
    reason = f"disruption #{disruption_id}" if disruption_id else "delay"
    if remaining == 0:
        order.status = OrderStatus.cancelled
        order.events.append(
            OrderEvent(status=OrderStatus.cancelled, note=f"Retailer switched to order #{new.id} due to {reason}")
        )
    else:
        order.events.append(
            OrderEvent(status=order.status, note=f"Partly moved to order #{new.id} due to {reason}; {remaining} unit(s) remain")
        )
    session.flush()
    session.refresh(new)

    notify(session, channel, order.buyer, NotificationKind.switch_confirmed,
           messages.switch_confirmed(order, new, remaining), order_id=new.id, disruption_id=disruption_id)
    notify(session, channel, order.supplier, NotificationKind.order_switched_away,
           messages.order_switched_away(order, new, remaining == 0), order_id=order.id, disruption_id=disruption_id)
    notify(session, channel, new.supplier, NotificationKind.new_order,
           messages.new_order(new, disruption_id), order_id=new.id, disruption_id=disruption_id)
    session.commit()
    return SwitchResult(order, new, remaining)
