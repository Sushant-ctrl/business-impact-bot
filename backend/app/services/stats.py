"""Historical statistics derived from order history: supplier reliability and SKU demand."""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from statistics import fmean, pstdev

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.clock import today
from app.config import get_settings
from app.models import Order, OrderLine, OrderStatus, SupplyLink


@dataclass(frozen=True)
class SupplierStats:
    supplier_id: int
    n_orders: int
    on_time_rate: float | None
    lateness_prob: float  # Laplace-smoothed, so new suppliers start at 0.5 rather than 0 or 1
    lead_mean: float | None
    lead_std: float
    mean_delay: float  # average days late across all deliveries (early counts as 0)
    mean_delay_when_late: float


@dataclass(frozen=True)
class DemandStats:
    mean_daily: float
    std_daily: float
    days: int


@dataclass(frozen=True)
class LeadTimeStats:
    mean: float
    std: float
    n_orders: int


def _start(as_of: date, lookback_days: int) -> datetime:
    return datetime.combine(as_of - timedelta(days=lookback_days), time.min)


def _lead_days(order: Order) -> int:
    return (order.delivered_at.date() - order.created_at.date()).days


def _delay_days(order: Order) -> int:
    return (order.delivered_at.date() - order.promised_date).days


def _summarize(supplier_id: int, orders: list[Order]) -> SupplierStats:
    n = len(orders)
    if n == 0:
        return SupplierStats(supplier_id, 0, None, 0.5, None, 0.0, 0.0, 0.0)
    delays = [_delay_days(o) for o in orders]
    leads = [_lead_days(o) for o in orders]
    late = [d for d in delays if d > 0]
    return SupplierStats(
        supplier_id=supplier_id,
        n_orders=n,
        on_time_rate=(n - len(late)) / n,
        lateness_prob=(len(late) + 1) / (n + 2),
        lead_mean=fmean(leads),
        lead_std=pstdev(leads) if n > 1 else 0.0,
        mean_delay=fmean(max(0, d) for d in delays),
        mean_delay_when_late=fmean(late) if late else 0.0,
    )


def _delivered_orders(session: Session, as_of: date, lookback_days: int):
    return select(Order).where(
        Order.status == OrderStatus.delivered,
        Order.delivered_at.is_not(None),
        Order.created_at >= _start(as_of, lookback_days),
    )


def all_supplier_stats(
    session: Session, as_of: date | None = None, lookback_days: int | None = None
) -> dict[int, SupplierStats]:
    as_of = as_of or today()
    lookback_days = lookback_days or get_settings().stats_lookback_days
    by_supplier: dict[int, list[Order]] = defaultdict(list)
    for order in session.scalars(_delivered_orders(session, as_of, lookback_days)):
        by_supplier[order.supplier_id].append(order)
    return {sid: _summarize(sid, orders) for sid, orders in by_supplier.items()}


def supplier_stats(
    session: Session, supplier_id: int, as_of: date | None = None, lookback_days: int | None = None
) -> SupplierStats:
    as_of = as_of or today()
    lookback_days = lookback_days or get_settings().stats_lookback_days
    stmt = _delivered_orders(session, as_of, lookback_days).where(Order.supplier_id == supplier_id)
    return _summarize(supplier_id, list(session.scalars(stmt)))


def demand_stats(
    session: Session, party_id: int, as_of: date | None = None, lookback_days: int = 90
) -> dict[str, DemandStats]:
    """Daily demand per SKU placed *on* this party by its downstream buyers."""
    as_of = as_of or today()
    start = as_of - timedelta(days=lookback_days)
    rows = session.execute(
        select(Order.created_at, OrderLine.sku, OrderLine.qty)
        .join(OrderLine, OrderLine.order_id == Order.id)
        .where(
            Order.supplier_id == party_id,
            Order.status != OrderStatus.cancelled,
            Order.created_at >= _start(as_of, lookback_days),
            Order.created_at < datetime.combine(as_of, time.min),
        )
    ).all()
    daily: dict[str, dict[date, int]] = defaultdict(lambda: defaultdict(int))
    for created_at, sku, qty in rows:
        daily[sku][created_at.date()] += qty

    result = {}
    for sku, per_day in daily.items():
        series = [per_day.get(start + timedelta(days=i), 0) for i in range(lookback_days)]
        result[sku] = DemandStats(fmean(series), pstdev(series), lookback_days)
    return result


def lead_time_stats(
    session: Session, buyer_id: int, as_of: date | None = None, lookback_days: int | None = None
) -> dict[str, LeadTimeStats]:
    """Observed inbound lead time per SKU for a buyer, falling back to the nominal link lead time."""
    as_of = as_of or today()
    lookback_days = lookback_days or get_settings().stats_lookback_days
    stmt = (
        _delivered_orders(session, as_of, lookback_days)
        .where(Order.buyer_id == buyer_id)
        .options(selectinload(Order.lines))
    )
    leads: dict[str, list[int]] = defaultdict(list)
    for order in session.scalars(stmt):
        for line in order.lines:
            leads[line.sku].append(_lead_days(order))

    result = {sku: LeadTimeStats(fmean(v), pstdev(v) if len(v) > 1 else 0.0, len(v)) for sku, v in leads.items()}

    nominal = session.execute(
        select(SupplyLink.product_sku, func.min(SupplyLink.nominal_lead_days))
        .where(SupplyLink.buyer_id == buyer_id)
        .group_by(SupplyLink.product_sku)
    ).all()
    for sku, lead in nominal:
        result.setdefault(sku, LeadTimeStats(float(lead), 0.0, 0))
    return result
