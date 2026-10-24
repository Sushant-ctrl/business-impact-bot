"""Turns a reported disruption into revised delivery dates for the orders it hits."""

import math
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.clock import today
from app.config import get_settings
from app.models import OPEN_STATUSES, Disruption, DisruptionCause, Order, OrderDisruption
from app.services.lanes import LaneBook, LaneEstimate


@dataclass(frozen=True)
class DelayEstimate:
    extra_days: int | None  # added on top of the current ETA
    clear_date: date | None  # route expected to reopen on this date
    basis: str


@dataclass
class AffectedOrder:
    order: Order
    original_eta: date
    revised_eta: date
    lane: LaneEstimate

    @property
    def slip_days(self) -> int:
        return (self.revised_eta - self.original_eta).days


@dataclass
class DisruptionImpact:
    delay: DelayEstimate
    affected: list[AffectedOrder]


def historical_extra_delay(
    session: Session, cause: DisruptionCause, areas: list[str]
) -> tuple[float, int, str] | None:
    """Mean days late (vs the ETA before the disruption) for orders hit by past resolved disruptions
    of the same cause. Prefers history from the same pincodes, then falls back to the whole network."""
    rows = session.execute(
        select(OrderDisruption.original_eta, OrderDisruption.actual_delivery, Order.delivery_area)
        .join(Disruption, Disruption.id == OrderDisruption.disruption_id)
        .join(Order, Order.id == OrderDisruption.order_id)
        .where(
            Disruption.cause == cause,
            Disruption.resolved_at.is_not(None),
            OrderDisruption.actual_delivery.is_not(None),
        )
    ).all()
    local = [r for r in rows if areas and r.delivery_area in areas]
    for scope, sample in (("these areas", local), ("the network", rows)):
        if sample:
            delays = [max(0, (r.actual_delivery - r.original_eta).days) for r in sample]
            return sum(delays) / len(delays), len(delays), scope
    return None


def estimate_delay(
    session: Session,
    cause: DisruptionCause,
    areas: list[str],
    extra_delay_days: int | None = None,
    expected_clear_date: date | None = None,
) -> DelayEstimate:
    label = cause.value.replace("_", " ")
    if extra_delay_days is not None:
        return DelayEstimate(extra_delay_days, None, f"stockist expects {extra_delay_days} extra day(s)")
    if expected_clear_date is not None:
        return DelayEstimate(None, expected_clear_date, f"route expected to clear on {expected_clear_date:%d %b}")
    history = historical_extra_delay(session, cause, areas)
    if history:
        mean, n, scope = history
        days = math.ceil(mean)
        return DelayEstimate(days, None, f"past {label} disruptions in {scope} delayed orders by ~{days} day(s) ({n} orders)")
    days = get_settings().default_cause_delay_days.get(cause.value, 2)
    return DelayEstimate(days, None, f"no past {label} history; assuming {days} extra day(s)")


def delay_for(session: Session, disruption: Disruption) -> DelayEstimate:
    return estimate_delay(
        session, disruption.cause, disruption.affected_areas, disruption.extra_delay_days, disruption.expected_clear_date
    )


def apply_delay(base_eta: date, delay: DelayEstimate, lane: LaneEstimate, as_of: date) -> date:
    """When the shipment will now arrive, given its pre-disruption ETA."""
    if delay.clear_date is not None:
        # Once the route reopens the goods still need a normal transit to the pincode.
        return max(base_eta, delay.clear_date + timedelta(days=lane.median_days))
    return max(base_eta, as_of) + timedelta(days=delay.extra_days or 0)


def affected_orders(session: Session, stockist_id: int, areas: list[str]) -> list[Order]:
    stmt = (
        select(Order)
        .where(Order.supplier_id == stockist_id, Order.status.in_(OPEN_STATUSES))
        .options(selectinload(Order.lines), selectinload(Order.buyer))
        .order_by(Order.expected_delivery_date, Order.id)
    )
    if areas:
        stmt = stmt.where(Order.delivery_area.in_(areas))
    return list(session.scalars(stmt))


def assess(
    session: Session,
    stockist_id: int,
    cause: DisruptionCause,
    areas: list[str],
    extra_delay_days: int | None = None,
    expected_clear_date: date | None = None,
    as_of: date | None = None,
) -> DisruptionImpact:
    as_of = as_of or today()
    delay = estimate_delay(session, cause, areas, extra_delay_days, expected_clear_date)
    lanes = LaneBook(session, as_of)
    affected = []
    for order in affected_orders(session, stockist_id, areas):
        lane = lanes.estimate(stockist_id, order.delivery_area)
        original = order.expected_delivery_date
        affected.append(AffectedOrder(order, original, apply_delay(original, delay, lane, as_of), lane))
    return DisruptionImpact(delay, affected)


def active_disruptions(session: Session, stockist_id: int | None = None) -> list[Disruption]:
    stmt = select(Disruption).where(Disruption.resolved_at.is_(None))
    if stockist_id is not None:
        stmt = stmt.where(Disruption.stockist_id == stockist_id)
    return list(session.scalars(stmt.order_by(Disruption.reported_at.desc())))
