"""Lane history: how many days deliveries from a stockist to a pincode normally take.

Orders that were hit by a reported disruption are left out so the baseline reflects normal days.
"""

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from statistics import median

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.clock import today
from app.config import get_settings
from app.models import Order, OrderDisruption, OrderStatus


@dataclass(frozen=True)
class LaneEstimate:
    stockist_id: int
    area: str
    n: int
    median_days: int
    p80_days: int
    on_time_rate: float | None
    scope: str  # lane | area | stockist | default
    basis: str


@dataclass(frozen=True)
class _Sample:
    days: int
    on_time: bool


def _percentile(values: list[int], q: float) -> int:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q * len(ordered)) - 1)]


class LaneBook:
    """Loads delivery history once and answers lane estimates with a fallback chain:
    this stockist → this pincode, then any stockist → this pincode, then this stockist → anywhere."""

    def __init__(self, session: Session, as_of: date | None = None):
        settings = get_settings()
        self.min_samples = settings.lane_min_samples
        self.default_days = settings.default_lane_days
        as_of = as_of or today()
        start = datetime.combine(as_of - timedelta(days=settings.lane_lookback_days), time.min)

        disrupted = select(OrderDisruption.order_id)
        rows = session.execute(
            select(Order.supplier_id, Order.delivery_area, Order.created_at, Order.delivered_at, Order.promised_date)
            .where(
                Order.status == OrderStatus.delivered,
                Order.delivered_at.is_not(None),
                Order.created_at >= start,
                Order.id.not_in(disrupted),
            )
        ).all()

        self._lane: dict[tuple[int, str], list[_Sample]] = defaultdict(list)
        self._area: dict[str, list[_Sample]] = defaultdict(list)
        self._stockist: dict[int, list[_Sample]] = defaultdict(list)
        for supplier_id, area, created_at, delivered_at, promised in rows:
            sample = _Sample(
                days=(delivered_at.date() - created_at.date()).days,
                on_time=delivered_at.date() <= promised,
            )
            self._lane[(supplier_id, area)].append(sample)
            self._area[area].append(sample)
            self._stockist[supplier_id].append(sample)

    def estimate(self, stockist_id: int, area: str) -> LaneEstimate:
        candidates = [
            ("lane", self._lane.get((stockist_id, area), []), f"past deliveries to {area}"),
            ("area", self._area.get(area, []), f"past deliveries to {area} across the network"),
            ("stockist", self._stockist.get(stockist_id, []), "this stockist's past deliveries to all areas"),
        ]
        for scope, samples, label in candidates:
            if len(samples) >= self.min_samples:
                days = [s.days for s in samples]
                med = math.ceil(median(days))
                return LaneEstimate(
                    stockist_id=stockist_id,
                    area=area,
                    n=len(samples),
                    median_days=med,
                    p80_days=max(med, _percentile(days, 0.8)),
                    on_time_rate=round(sum(s.on_time for s in samples) / len(samples), 3),
                    scope=scope,
                    basis=f"usually {med} day(s), based on {len(samples)} {label}",
                )
        return LaneEstimate(
            stockist_id=stockist_id,
            area=area,
            n=0,
            median_days=self.default_days,
            p80_days=self.default_days,
            on_time_rate=None,
            scope="default",
            basis=f"no delivery history yet; assuming {self.default_days} day(s)",
        )


def lane_estimate(session: Session, stockist_id: int, area: str, as_of: date | None = None) -> LaneEstimate:
    return LaneBook(session, as_of).estimate(stockist_id, area)
