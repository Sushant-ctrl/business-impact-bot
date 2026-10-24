"""Delay-risk scoring for open orders.

v1 is a transparent weighted rule model so every score comes with human-readable reasons.
`RiskModel` is the seam for swapping in a trained model once enough history exists.
"""

from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Protocol

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.clock import today
from app.config import get_settings
from app.models import OPEN_STATUSES, Order, OrderStatus, RiskScore
from app.services.stats import SupplierStats, all_supplier_stats
from app.services.stock import UNSHIPPED_STATUSES, inventory_map

# Assumed extra days when a supplier is short and must restock first.
RESTOCK_DELAY_DAYS = 3.0
# Used when a supplier has no delivery history yet.
DEFAULT_DELAY_WHEN_LATE = 2.0


@dataclass(frozen=True)
class RiskFeatures:
    lateness_prob: float
    lead_cv: float
    stock_shortfall: float  # 0 = supplier can fully cover the order, 1 = no stock at all
    schedule_pressure: float
    peak_period: bool
    days_to_promised: int
    mean_delay_when_late: float
    on_time_rate: float | None = None
    lead_std: float = 0.0
    short_skus: tuple[str, ...] = ()


@dataclass
class RiskFactor:
    name: str
    value: float
    weight: float
    contribution: float
    message: str


@dataclass
class RiskResult:
    score: float
    level: str
    expected_delay_days: float
    factors: list[RiskFactor] = field(default_factory=list)

    def reasons(self) -> list[dict]:
        return [asdict(f) for f in self.factors if f.contribution > 0]


class RiskModel(Protocol):
    def predict(self, features: RiskFeatures) -> RiskResult: ...


def risk_level(score: float) -> str:
    settings = get_settings()
    if score >= settings.risk_alert_threshold:
        return "high"
    if score >= settings.risk_medium_threshold:
        return "medium"
    return "low"


class RuleBasedRiskModel:
    WEIGHTS = {
        "supplier_lateness": 0.35,
        "stock_shortfall": 0.25,
        "lead_time_variability": 0.15,
        "schedule_pressure": 0.15,
        "peak_period": 0.10,
    }

    def predict(self, f: RiskFeatures) -> RiskResult:
        w = self.WEIGHTS
        overdue = f.days_to_promised < 0
        factors = [
            RiskFactor(
                "supplier_lateness",
                f.lateness_prob,
                w["supplier_lateness"],
                w["supplier_lateness"] * f.lateness_prob,
                (
                    f"Supplier delivered late on {1 - f.on_time_rate:.0%} of recent orders"
                    if f.on_time_rate is not None
                    else "No delivery history for this supplier yet"
                ),
            ),
            RiskFactor(
                "stock_shortfall",
                f.stock_shortfall,
                w["stock_shortfall"],
                w["stock_shortfall"] * f.stock_shortfall,
                f"Supplier stock covers only {1 - f.stock_shortfall:.0%} of the order"
                + (f" (short on {', '.join(f.short_skus)})" if f.short_skus else ""),
            ),
            RiskFactor(
                "lead_time_variability",
                f.lead_cv,
                w["lead_time_variability"],
                w["lead_time_variability"] * f.lead_cv,
                f"Lead time varies by ±{f.lead_std:.1f} days",
            ),
            RiskFactor(
                "schedule_pressure",
                f.schedule_pressure,
                w["schedule_pressure"],
                w["schedule_pressure"] * f.schedule_pressure,
                (
                    f"Overdue by {-f.days_to_promised} day(s)"
                    if overdue
                    else f"Not yet shipped with {f.days_to_promised} day(s) to the promised date"
                ),
            ),
            RiskFactor(
                "peak_period",
                1.0 if f.peak_period else 0.0,
                w["peak_period"],
                w["peak_period"] if f.peak_period else 0.0,
                "Promised date falls in a peak period (festival season / month-end)",
            ),
        ]
        score = sum(x.contribution for x in factors)
        if overdue:
            score = max(score, 0.9)
        score = round(min(1.0, max(0.0, score)), 3)

        expected_delay = f.lateness_prob * f.mean_delay_when_late + f.stock_shortfall * RESTOCK_DELAY_DAYS
        if overdue:
            expected_delay = max(expected_delay, -f.days_to_promised + 1)
        return RiskResult(score, risk_level(score), round(expected_delay, 1), factors)


default_model: RiskModel = RuleBasedRiskModel()


def in_peak_period(d: date) -> bool:
    if d.day >= 28:
        return True
    md = d.strftime("%m-%d")
    return any(start <= md <= end for start, end in get_settings().peak_periods)


def _schedule_pressure(order: Order, days_to_promised: int) -> float:
    if days_to_promised < 0:
        return 1.0
    if order.status == OrderStatus.placed:
        return 0.8 if days_to_promised <= 1 else 0.5 if days_to_promised <= 2 else 0.0
    if order.status == OrderStatus.confirmed:
        return 0.6 if days_to_promised <= 0 else 0.3 if days_to_promised <= 1 else 0.0
    return 0.0


class _SupplierQueues:
    """Lazily computes how much of each supplier's stock is claimed by older unshipped orders."""

    def __init__(self, session: Session):
        self.session = session
        self._cache: dict[int, tuple[dict, dict[int, dict[str, int]]]] = {}

    def coverage(self, order: Order) -> tuple[float, tuple[str, ...]]:
        if order.status not in UNSHIPPED_STATUSES or not order.lines:
            return 1.0, ()
        inv, ahead = self._queue(order.supplier_id)
        ratios, short = [], []
        for line in order.lines:
            on_hand = inv[line.sku].available if line.sku in inv else 0
            remaining = on_hand - ahead.get(order.id, {}).get(line.sku, 0)
            ratio = min(1.0, max(0.0, remaining / line.qty)) if line.qty else 1.0
            ratios.append(ratio)
            if ratio < 1.0:
                short.append(line.sku)
        return min(ratios), tuple(short)

    def _queue(self, supplier_id: int):
        if supplier_id not in self._cache:
            orders = self.session.scalars(
                select(Order)
                .where(Order.supplier_id == supplier_id, Order.status.in_(UNSHIPPED_STATUSES))
                .order_by(Order.created_at, Order.id)
                .options(selectinload(Order.lines))
            )
            running: dict[str, int] = defaultdict(int)
            ahead: dict[int, dict[str, int]] = {}
            for o in orders:
                ahead[o.id] = dict(running)
                for line in o.lines:
                    running[line.sku] += line.qty
            self._cache[supplier_id] = (inventory_map(self.session, supplier_id), ahead)
        return self._cache[supplier_id]


def build_features(
    order: Order, stats: SupplierStats | None, queues: _SupplierQueues, as_of: date
) -> RiskFeatures:
    days_to_promised = (order.promised_date - as_of).days
    coverage, short = queues.coverage(order)
    lead_cv = 0.0
    if stats and stats.lead_mean:
        lead_cv = min(1.0, stats.lead_std / stats.lead_mean)
    return RiskFeatures(
        lateness_prob=stats.lateness_prob if stats else 0.5,
        lead_cv=lead_cv,
        stock_shortfall=round(1.0 - coverage, 3),
        schedule_pressure=_schedule_pressure(order, days_to_promised),
        peak_period=in_peak_period(order.promised_date),
        days_to_promised=days_to_promised,
        mean_delay_when_late=(stats.mean_delay_when_late if stats and stats.mean_delay_when_late else DEFAULT_DELAY_WHEN_LATE),
        on_time_rate=stats.on_time_rate if stats else None,
        lead_std=stats.lead_std if stats else 0.0,
        short_skus=short,
    )


def score_orders(
    session: Session,
    orders: list[Order],
    as_of: date | None = None,
    model: RiskModel | None = None,
    persist: bool = False,
) -> list[tuple[Order, RiskResult]]:
    as_of = as_of or today()
    model = model or default_model
    stats = all_supplier_stats(session, as_of)
    queues = _SupplierQueues(session)
    results = []
    for order in orders:
        result = model.predict(build_features(order, stats.get(order.supplier_id), queues, as_of))
        results.append((order, result))
        if persist:
            session.add(
                RiskScore(
                    order_id=order.id,
                    score=result.score,
                    level=result.level,
                    expected_delay_days=result.expected_delay_days,
                    reasons=result.reasons(),
                )
            )
    if persist:
        session.commit()
    return results


def score_order(session: Session, order: Order, as_of: date | None = None, persist: bool = False) -> RiskResult:
    return score_orders(session, [order], as_of, persist=persist)[0][1]


def open_orders(session: Session, buyer_id: int | None = None) -> list[Order]:
    stmt = select(Order).where(Order.status.in_(OPEN_STATUSES)).options(selectinload(Order.lines))
    if buyer_id is not None:
        stmt = stmt.where(Order.buyer_id == buyer_id)
    return list(session.scalars(stmt.order_by(Order.promised_date)))


def latest_scores(session: Session, order_ids: list[int]) -> dict[int, RiskScore]:
    if not order_ids:
        return {}
    latest = (
        select(RiskScore.order_id, func.max(RiskScore.id).label("max_id"))
        .where(RiskScore.order_id.in_(order_ids))
        .group_by(RiskScore.order_id)
        .subquery()
    )
    rows = session.scalars(select(RiskScore).join(latest, RiskScore.id == latest.c.max_id))
    return {r.order_id: r for r in rows}
