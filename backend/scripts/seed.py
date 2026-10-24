"""Mock data for local development and demos.

Builds a small Pune FMCG network (distributors -> stockists -> sub-stockist -> retailers) with ~180 days of
delivered order history and a hand-picked set of open orders that exercise every risk factor. All dates are
relative to `as_of` (today by default), so the scenario stays meaningful whenever the data is re-seeded.

    uv run python -m scripts.seed           # create tables and seed (refuses if data already exists)
    uv run python -m scripts.seed --reset   # drop everything first
"""

import argparse
import random
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.clock import today
from app.db import Base, SessionLocal, engine
from app.models import (
    Alert,
    AlertType,
    Inventory,
    Order,
    OrderEvent,
    OrderLine,
    OrderStatus,
    Party,
    PartyRole,
    Product,
    SupplyLink,
)
from app.services.risk import in_peak_period, open_orders, score_orders

HISTORY_DAYS = 180

PRODUCTS = [
    ("COLA24", "Fizz Cola 24×300ml", "carton"),
    ("MANGO12", "Sunny Mango Juice 12×1L", "carton"),
    ("CHIPS48", "Crunchy Salted Chips 48-pack", "case"),
    ("DET12", "BrightWash Detergent 1kg ×12", "case"),
    ("ATTA10", "GoldHarvest Atta 10kg", "bag"),
]
ALL_SKUS = [sku for sku, _, _ in PRODUCTS]

# key, name, role, region, phone
PARTIES = [
    ("apex", "Apex Distribution", PartyRole.distributor, "Pune East", "+91 98220 10001"),
    ("horizon", "Horizon Traders", PartyRole.distributor, "Pune West", "+91 98220 10002"),
    ("freshlink", "FreshLink Wholesale", PartyRole.distributor, "Hadapsar", "+91 98220 10003"),
    ("metromart", "MetroMart Cash & Carry", PartyRole.distributor, "Chakan", "+91 98220 10004"),
    ("ganesh", "Shree Ganesh Stockists", PartyRole.stockist, "Hadapsar", "+91 98500 20001"),
    ("laxmi", "Laxmi Agencies", PartyRole.stockist, "Kothrud", "+91 98500 20002"),
    ("omsai", "Om Sai Sub-Stockist", PartyRole.sub_stockist, "Wagholi", "+91 98500 30001"),
    ("sharma", "Sharma General Store", PartyRole.retailer, "Viman Nagar", "+91 99700 40001"),
    ("patel", "Patel Kirana", PartyRole.retailer, "Kharadi", "+91 99700 40002"),
    ("citymart", "City Mart Express", PartyRole.retailer, "Baner", "+91 99700 40003"),
    ("greenbasket", "Green Basket Supermarket", PartyRole.retailer, "Aundh", "+91 99700 40004"),
    ("balaji", "New Balaji Mart", PartyRole.retailer, "Wakad", "+91 99700 40005"),
]


@dataclass(frozen=True)
class Reliability:
    on_time: float  # probability an order lands on or before the promised date
    max_delay: int  # worst-case days late


RELIABILITY = {
    "apex": Reliability(0.88, 3),
    "horizon": Reliability(0.55, 5),
    "freshlink": Reliability(0.95, 2),
    "metromart": Reliability(0.75, 4),
    "ganesh": Reliability(0.82, 3),
    "laxmi": Reliability(0.65, 4),
    "omsai": Reliability(0.72, 3),
}

# buyer, supplier, lead days, price multiplier, skus (None = all). The first link per buyer is its primary source.
LINKS = [
    ("ganesh", "apex", 2, 1.00, None),
    ("ganesh", "horizon", 3, 1.03, None),
    ("ganesh", "freshlink", 1, 1.12, ["COLA24", "MANGO12", "CHIPS48"]),
    ("laxmi", "horizon", 3, 1.00, None),
    ("laxmi", "apex", 2, 1.02, None),
    ("laxmi", "metromart", 4, 0.95, None),
    ("omsai", "ganesh", 1, 1.00, None),
    ("omsai", "laxmi", 2, 1.02, None),
    ("sharma", "ganesh", 1, 1.00, None),
    ("sharma", "laxmi", 2, 1.03, None),
    ("patel", "ganesh", 1, 1.00, None),
    ("patel", "omsai", 1, 1.04, ["COLA24", "CHIPS48", "DET12"]),
    ("citymart", "laxmi", 1, 1.00, None),
    ("citymart", "ganesh", 2, 1.02, None),
    ("greenbasket", "laxmi", 1, 1.00, None),
    ("greenbasket", "ganesh", 2, 1.03, None),
    ("balaji", "laxmi", 1, 1.00, None),
    ("balaji", "omsai", 1, 1.04, None),
]

BASE_PRICE = {"COLA24": 500, "MANGO12": 620, "CHIPS48": 400, "DET12": 1150, "ATTA10": 420}

# Recurring history: buyer, supplier, mean days between orders, (min, max) qty per line.
HISTORY = [
    ("ganesh", "apex", 4, (20, 60)),
    ("ganesh", "horizon", 15, (15, 40)),
    ("ganesh", "freshlink", 25, (10, 25)),
    ("laxmi", "horizon", 4, (20, 60)),
    ("laxmi", "apex", 14, (15, 40)),
    ("laxmi", "metromart", 20, (20, 50)),
    ("omsai", "ganesh", 5, (8, 20)),
    ("omsai", "laxmi", 18, (6, 15)),
    ("sharma", "ganesh", 3, (2, 8)),
    ("patel", "ganesh", 3, (2, 8)),
    ("patel", "omsai", 9, (2, 6)),
    ("citymart", "laxmi", 2, (3, 10)),
    ("greenbasket", "laxmi", 3, (2, 8)),
    ("greenbasket", "ganesh", 20, (2, 6)),
    ("balaji", "laxmi", 4, (2, 6)),
    ("balaji", "omsai", 6, (2, 6)),
]

# party, sku, on_hand, reserved
INVENTORY = [
    # Apex is short on cola: the open Ganesh order below can only be partly covered.
    ("apex", "COLA24", 30, 0),
    ("apex", "MANGO12", 180, 10),
    ("apex", "CHIPS48", 220, 0),
    ("apex", "DET12", 140, 0),
    ("apex", "ATTA10", 300, 20),
    ("horizon", "COLA24", 150, 0),
    ("horizon", "MANGO12", 90, 0),
    ("horizon", "CHIPS48", 40, 0),
    ("horizon", "DET12", 60, 0),
    ("horizon", "ATTA10", 120, 0),
    ("freshlink", "COLA24", 200, 0),
    ("freshlink", "MANGO12", 60, 0),
    ("freshlink", "CHIPS48", 150, 0),
    ("metromart", "COLA24", 250, 0),
    ("metromart", "MANGO12", 200, 0),
    ("metromart", "CHIPS48", 300, 0),
    ("metromart", "DET12", 120, 0),
    ("metromart", "ATTA10", 400, 0),
    # Ganesh is running low on atta, so the later of its two open retailer atta orders is short.
    ("ganesh", "COLA24", 45, 5),
    ("ganesh", "MANGO12", 30, 0),
    ("ganesh", "CHIPS48", 60, 4),
    ("ganesh", "DET12", 25, 0),
    ("ganesh", "ATTA10", 12, 2),
    ("laxmi", "COLA24", 70, 0),
    ("laxmi", "MANGO12", 8, 0),
    ("laxmi", "CHIPS48", 55, 0),
    ("laxmi", "DET12", 18, 0),
    ("laxmi", "ATTA10", 40, 0),
    ("omsai", "COLA24", 20, 0),
    ("omsai", "MANGO12", 10, 0),
    ("omsai", "CHIPS48", 25, 0),
    ("omsai", "DET12", 6, 0),
    ("omsai", "ATTA10", 15, 0),
    ("sharma", "COLA24", 8, 0),
    ("sharma", "CHIPS48", 14, 0),
    ("sharma", "ATTA10", 9, 0),
    ("patel", "COLA24", 4, 0),
    ("patel", "CHIPS48", 6, 0),
    ("patel", "DET12", 7, 0),
    ("citymart", "COLA24", 25, 0),
    ("citymart", "CHIPS48", 20, 0),
    ("citymart", "MANGO12", 11, 0),
    ("greenbasket", "MANGO12", 10, 0),
    ("greenbasket", "DET12", 3, 0),
    ("greenbasket", "ATTA10", 15, 0),
    ("balaji", "COLA24", 12, 0),
    ("balaji", "ATTA10", 6, 0),
]


@dataclass(frozen=True)
class OpenOrder:
    buyer: str
    supplier: str
    status: OrderStatus
    placed_days_ago: int
    promised_in_days: int  # relative to as_of; negative = already overdue
    lines: dict[str, int]
    note: str | None = None


# Ordered oldest first, since a supplier's stock is allocated to unshipped orders in creation order.
OPEN_ORDERS = [
    OpenOrder("ganesh", "horizon", OrderStatus.confirmed, 4, -1, {"MANGO12": 30, "DET12": 20},
              "Horizon confirmed but has not dispatched"),
    OpenOrder("laxmi", "apex", OrderStatus.confirmed, 2, 1, {"COLA24": 20}),
    OpenOrder("laxmi", "horizon", OrderStatus.dispatched, 3, 1, {"COLA24": 40, "CHIPS48": 30, "ATTA10": 25}),
    OpenOrder("ganesh", "apex", OrderStatus.placed, 1, 2, {"COLA24": 60, "CHIPS48": 40},
              "Festival-season top-up"),
    OpenOrder("laxmi", "metromart", OrderStatus.confirmed, 1, 3, {"MANGO12": 50, "DET12": 30}),
    OpenOrder("omsai", "ganesh", OrderStatus.dispatched, 1, 0, {"COLA24": 15, "CHIPS48": 12}),
    OpenOrder("sharma", "ganesh", OrderStatus.confirmed, 1, 1, {"ATTA10": 6, "COLA24": 6}),
    OpenOrder("patel", "ganesh", OrderStatus.placed, 0, 1, {"ATTA10": 8, "DET12": 4}),
    OpenOrder("citymart", "laxmi", OrderStatus.placed, 0, 1, {"MANGO12": 12, "CHIPS48": 6}),
    OpenOrder("greenbasket", "laxmi", OrderStatus.confirmed, 1, 1, {"DET12": 5, "ATTA10": 6}),
    OpenOrder("balaji", "omsai", OrderStatus.placed, 0, 1, {"COLA24": 4, "ATTA10": 3}),
    OpenOrder("balaji", "laxmi", OrderStatus.dispatched, 2, 0, {"CHIPS48": 5}),
]


def _at(d: date, hour: int, minute: int = 0) -> datetime:
    return datetime.combine(d, time(hour, minute))


def _add_events(order: Order, timeline: list[tuple[OrderStatus, datetime, str | None]]) -> None:
    order.events = [OrderEvent(status=s, timestamp=ts, note=note) for s, ts, note in timeline]


def _history_order(
    rng: random.Random, buyer: Party, supplier: Party, link_lead: int, rel: Reliability,
    skus: list[str], qty_range: tuple[int, int], created_at: datetime,
) -> Order:
    promised = created_at.date() + timedelta(days=link_lead)
    lines = [OrderLine(sku=s, qty=rng.randint(*qty_range)) for s in rng.sample(skus, rng.randint(1, min(3, len(skus))))]
    order = Order(buyer=buyer, supplier=supplier, created_at=created_at, promised_date=promised, lines=lines)
    confirmed_at = created_at + timedelta(hours=rng.randint(1, 6))

    if rng.random() < 0.03:
        order.status = OrderStatus.cancelled
        _add_events(order, [
            (OrderStatus.placed, created_at, None),
            (OrderStatus.cancelled, confirmed_at, rng.choice(["Buyer cancelled", "Supplier out of stock"])),
        ])
        return order

    on_time = rel.on_time - (0.15 if in_peak_period(promised) else 0.0)
    if rng.random() < on_time:
        delay = rng.choice([-1, 0, 0, 0]) if link_lead >= 2 else 0
    else:
        delay = rng.randint(1, rel.max_delay)
    delivered_at = _at(promised + timedelta(days=delay), rng.randint(9, 18), rng.choice([0, 15, 30, 45]))
    dispatched_at = max(confirmed_at + timedelta(hours=1), delivered_at - timedelta(hours=rng.randint(4, 20)))

    order.status = OrderStatus.delivered
    order.delivered_at = delivered_at
    _add_events(order, [
        (OrderStatus.placed, created_at, None),
        (OrderStatus.confirmed, confirmed_at, None),
        (OrderStatus.dispatched, dispatched_at, None),
        (OrderStatus.delivered, delivered_at, f"Delivered {delay} day(s) late" if delay > 0 else None),
    ])
    return order


def _open_order(rng: random.Random, spec: OpenOrder, parties: dict[str, Party], as_of: date) -> Order:
    created_at = _at(as_of - timedelta(days=spec.placed_days_ago), rng.randint(8, 12), rng.choice([0, 20, 40]))
    order = Order(
        buyer=parties[spec.buyer],
        supplier=parties[spec.supplier],
        status=spec.status,
        created_at=created_at,
        promised_date=as_of + timedelta(days=spec.promised_in_days),
        lines=[OrderLine(sku=sku, qty=qty) for sku, qty in spec.lines.items()],
    )
    timeline = [(OrderStatus.placed, created_at, spec.note)]
    if spec.status in (OrderStatus.confirmed, OrderStatus.dispatched):
        timeline.append((OrderStatus.confirmed, created_at + timedelta(hours=3), None))
    if spec.status == OrderStatus.dispatched:
        timeline.append((OrderStatus.dispatched, created_at + timedelta(hours=20), None))
    _add_events(order, timeline)
    return order


def seed(session: Session, as_of: date | None = None, rng_seed: int = 42) -> None:
    as_of = as_of or today()
    rng = random.Random(rng_seed)

    session.add_all(Product(sku=sku, name=name, unit=unit) for sku, name, unit in PRODUCTS)
    parties = {
        key: Party(name=name, role=role, region=region, phone=phone) for key, name, role, region, phone in PARTIES
    }
    session.add_all(parties.values())
    session.flush()

    link_skus: dict[tuple[str, str], list[str]] = {}
    link_lead: dict[tuple[str, str], int] = {}
    for buyer, supplier, lead, mult, skus in LINKS:
        skus = skus or ALL_SKUS
        link_skus[buyer, supplier] = skus
        link_lead[buyer, supplier] = lead
        session.add_all(
            SupplyLink(
                buyer_id=parties[buyer].id,
                supplier_id=parties[supplier].id,
                product_sku=sku,
                nominal_lead_days=lead,
                price=round(BASE_PRICE[sku] * mult, 2),
            )
            for sku in skus
        )

    session.add_all(
        Inventory(party_id=parties[p].id, sku=sku, on_hand=on_hand, reserved=reserved)
        for p, sku, on_hand, reserved in INVENTORY
    )

    # History stops a few days before as_of so it never overlaps the hand-picked open orders.
    for buyer, supplier, every, qty_range in HISTORY:
        key = (buyer, supplier)
        day = as_of - timedelta(days=HISTORY_DAYS - rng.randint(0, every))
        while True:
            created_at = _at(day, rng.randint(8, 19), rng.choice([0, 15, 30, 45]))
            if created_at.date() + timedelta(days=link_lead[key] + RELIABILITY[supplier].max_delay) >= as_of:
                break
            session.add(_history_order(
                rng, parties[buyer], parties[supplier], link_lead[key], RELIABILITY[supplier],
                link_skus[key], qty_range, created_at,
            ))
            day += timedelta(days=max(1, round(rng.gauss(every, every / 3))))

    for spec in OPEN_ORDERS:
        session.add(_open_order(rng, spec, parties, as_of))

    # A Horizon order that was cancelled and re-placed with FreshLink after a delay alert.
    original = _open_order(
        rng, OpenOrder("ganesh", "horizon", OrderStatus.cancelled, 3, 0, {"COLA24": 30}), parties, as_of
    )
    original.events.append(OrderEvent(
        status=OrderStatus.cancelled, timestamp=original.created_at + timedelta(days=1),
        note="Rerouted to FreshLink Wholesale",
    ))
    session.add(original)
    session.flush()
    rerouted = _open_order(
        rng, OpenOrder("ganesh", "freshlink", OrderStatus.dispatched, 2, 0, {"COLA24": 30}), parties, as_of
    )
    rerouted.rerouted_from_id = original.id
    session.add(rerouted)
    session.commit()

    still_open = open_orders(session)
    for order, result in score_orders(session, still_open, as_of, persist=True):
        if result.level != "high":
            continue
        top = max(result.factors, key=lambda f: f.contribution)
        session.add(Alert(
            party_id=order.buyer_id,
            order_id=order.id,
            type=AlertType.delay_risk,
            message=(
                f"Order #{order.id} from {order.supplier.name} is at high risk of delay "
                f"(~{result.expected_delay_days:g} day(s)). {top.message}."
            ),
        ))
        # Retailers waiting on this stockist feel the knock-on effect.
        for downstream in still_open:
            if downstream.supplier_id == order.buyer_id and {l.sku for l in downstream.lines} & {
                l.sku for l in order.lines
            }:
                session.add(Alert(
                    party_id=downstream.buyer_id,
                    order_id=downstream.id,
                    type=AlertType.downstream_delay,
                    message=(
                        f"{order.buyer.name}'s inbound stock is delayed; order #{downstream.id} may arrive late."
                    ),
                ))

    session.add(Alert(
        party_id=parties["laxmi"].id,
        sku="MANGO12",
        type=AlertType.reorder,
        message="Mango juice stock (8 cartons) is below the reorder point. Suggested order: 40 cartons.",
        acknowledged=False,
    ))
    session.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="drop and recreate all tables before seeding")
    args = parser.parse_args()

    if args.reset:
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with SessionLocal() as session:
        if not args.reset and session.scalar(select(func.count()).select_from(Party)):
            raise SystemExit("Database already has data; rerun with --reset to replace it.")
        seed(session)
        counts = {m.__tablename__: session.scalar(select(func.count()).select_from(m))
                  for m in (Party, SupplyLink, Inventory, Order, OrderEvent, Alert)}
    print("Seeded:", ", ".join(f"{n} {t}" for t, n in counts.items()))


if __name__ == "__main__":
    main()
