"""Other trusted stockists a retailer can buy from when a COD order is delayed."""

from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.clock import today
from app.config import get_settings
from app.models import Order, Party, PartyRole, PaymentMode, ServiceArea
from app.services.disruptions import active_disruptions, apply_delay, delay_for
from app.services.lanes import LaneBook
from app.services.stock import free_stock


@dataclass
class Alternative:
    stockist_id: int
    name: str
    eta: date
    coverage: float  # share of ordered units this stockist can ship now
    missing_skus: list[str]
    on_time_rate: float | None
    basis: str
    disrupted: bool = False


@dataclass
class AlternativesResult:
    order_id: int
    eligible: bool  # only COD orders can be switched
    needed_by: date | None
    days_left: int | None
    current_eta: date
    arrives_in_time: bool | None
    alternatives: list[Alternative] = field(default_factory=list)


def candidate_stockists(session: Session, area: str, exclude_id: int) -> list[Party]:
    return list(
        session.scalars(
            select(Party)
            .join(ServiceArea, ServiceArea.stockist_id == Party.id)
            .where(
                ServiceArea.area == area,
                Party.role == PartyRole.stockist,
                Party.trusted.is_(True),
                Party.id != exclude_id,
            )
            .order_by(Party.id)
        )
    )


def rank_candidates(
    session: Session, order: Order, as_of: date, needed_by: date | None, lanes: LaneBook | None = None
) -> list[Alternative]:
    lanes = lanes or LaneBook(session, as_of)
    disruptions = active_disruptions(session)
    total_qty = sum(line.qty for line in order.lines) or 1
    results = []
    for stockist in candidate_stockists(session, order.delivery_area, order.supplier_id):
        lane = lanes.estimate(stockist.id, order.delivery_area)
        eta = as_of + timedelta(days=lane.p80_days)
        hit = [d for d in disruptions if d.stockist_id == stockist.id and d.covers(order.delivery_area)]
        for disruption in hit:
            eta = apply_delay(eta, delay_for(session, disruption), lane, as_of)
        if needed_by is not None and eta > needed_by:
            continue

        stock = free_stock(session, stockist.id)
        fillable = sum(min(line.qty, stock.get(line.sku, 0)) for line in order.lines)
        if fillable == 0:
            continue
        results.append(
            Alternative(
                stockist_id=stockist.id,
                name=stockist.name,
                eta=eta,
                coverage=round(fillable / total_qty, 3),
                missing_skus=[line.sku for line in order.lines if stock.get(line.sku, 0) < line.qty],
                on_time_rate=lane.on_time_rate,
                basis=lane.basis,
                disrupted=bool(hit),
            )
        )
    results.sort(key=lambda a: (a.coverage < 1.0, a.eta, -(a.on_time_rate or 0.0)))
    return results


def find_alternatives(
    session: Session, order: Order, as_of: date | None = None, limit: int | None = None
) -> AlternativesResult:
    as_of = as_of or today()
    limit = limit or get_settings().max_alternatives
    needed_by = order.needed_by
    result = AlternativesResult(
        order_id=order.id,
        eligible=order.payment_mode == PaymentMode.cod and order.is_open,
        needed_by=needed_by,
        days_left=(needed_by - as_of).days if needed_by else None,
        current_eta=order.expected_delivery_date,
        arrives_in_time=(order.expected_delivery_date <= needed_by) if needed_by else None,
    )
    # Without a needed-by date we can't tell what "in time" means; the retailer is asked for days left first.
    if result.eligible and needed_by is not None:
        result.alternatives = rank_candidates(session, order, as_of, needed_by)[:limit]
    return result
