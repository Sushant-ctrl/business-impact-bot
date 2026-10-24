"""Seed a synthetic hill-region network of trusted stockists and retailers.

Run after `alembic upgrade head`. Wipes existing rows. Deterministic (fixed random seed).

    uv run python -m scripts.seed
"""

import random
from datetime import date, datetime, time, timedelta

from sqlalchemy import inspect

from app.clock import today
from app.db import Base, SessionLocal, engine
from app.models import (
    Disruption,
    DisruptionCause,
    Inventory,
    Order,
    OrderDisruption,
    OrderEvent,
    OrderLine,
    OrderStatus,
    Party,
    PartyRole,
    PaymentMode,
    Product,
    ServiceArea,
)

rng = random.Random(42)

# Pincodes laid out along a valley road; distance along the road drives normal delivery days.
AREAS = {
    "248001": "Clock Tower",
    "248002": "Rajpur",
    "248003": "Mussoorie Rd",
    "248005": "Prem Nagar",
    "248007": "Raipur",
    "248009": "Sahastradhara",
    "248121": "Doiwala",
    "248140": "Rishikesh Rd",
    "248179": "Kempty",
    "248195": "Vikasnagar",
}
AREA_LIST = list(AREAS)

STOCKISTS = [  # name, home pincode index, served pincode indexes
    ("Doon Valley Traders", 0, [0, 1, 2, 3, 4]),
    ("Himalaya Distributors", 2, [1, 2, 8, 3]),
    ("Ganga Wholesale", 7, [6, 7, 4, 5]),
    ("Shivalik Supplies", 4, [3, 4, 5, 6, 0]),
    ("Mountain Mart Stockist", 8, [8, 2, 9, 1]),
    ("Yamuna Agencies", 9, [9, 3, 0, 8]),
]

PRODUCTS = [
    ("ATTA-10", "Wheat flour 10kg", "bag"), ("RICE-25", "Basmati rice 25kg", "bag"),
    ("OIL-1L", "Mustard oil 1L", "bottle"), ("SUGAR-5", "Sugar 5kg", "bag"),
    ("SALT-1", "Iodised salt 1kg", "pack"), ("DAL-1", "Toor dal 1kg", "pack"),
    ("TEA-500", "Tea 500g", "pack"), ("MILK-PWD", "Milk powder 1kg", "pack"),
    ("SOAP-4", "Bath soap 4-pack", "pack"), ("DETG-1", "Detergent 1kg", "pack"),
    ("BISC-BOX", "Biscuits carton", "carton"), ("NOOD-BOX", "Instant noodles carton", "carton"),
    ("SPICE-MIX", "Garam masala 100g", "pack"), ("GHEE-1L", "Ghee 1L", "tin"),
    ("WATER-12", "Bottled water 12-pack", "case"),
]

RETAILER_NAMES = [
    "Sharma Kirana", "Negi General Store", "Rawat Provisions", "Bisht Mart", "Gupta Stores",
    "Pant Bazaar", "Joshi Traders", "Thapa Daily Needs", "Kumar Supermart", "Rana Kirana",
    "Chauhan Store", "Bhatt Provisions", "Semwal Mart", "Dobhal General", "Uniyal Stores",
    "Nautiyal Kirana", "Panwar Daily", "Rautela Mart", "Kandari Stores", "Butola Provisions",
    "Mehra Bazaar", "Aswal Kirana", "Gusain Mart", "Bhandari Stores", "Kothari Traders",
]

HISTORY_DAYS = 180
NOW = datetime.combine(today(), time(10))


def lane_days(stockist_home: int, area: int) -> int:
    return 1 + abs(stockist_home - area) // 2


def wipe(session) -> None:
    for table in reversed(Base.metadata.sorted_tables):
        session.execute(table.delete())
    session.commit()


def at(d: date, hour: int) -> datetime:
    return datetime.combine(d, time(hour))


def random_lines() -> list[OrderLine]:
    return [OrderLine(sku=sku, qty=rng.randint(2, 20)) for sku, _, _ in rng.sample(PRODUCTS, rng.randint(1, 3))]


def main() -> None:
    if not inspect(engine).has_table("orders"):
        raise SystemExit("Tables missing; run `uv run alembic upgrade head` first.")

    with SessionLocal() as s:
        wipe(s)
        s.add_all(Product(sku=sku, name=name, unit=unit) for sku, name, unit in PRODUCTS)

        stockists = []
        for i, (name, home, served) in enumerate(STOCKISTS, 1):
            p = Party(name=name, role=PartyRole.stockist, area=AREA_LIST[home], phone=f"90000000{i:02d}")
            p.home, p.served = home, served
            s.add(p)
            stockists.append(p)
        s.flush()
        for p in stockists:
            s.add_all(ServiceArea(stockist_id=p.id, area=AREA_LIST[a]) for a in p.served)
            for sku, _, _ in PRODUCTS:
                # A few SKUs run dry so alternatives sometimes have only partial coverage.
                on_hand = 0 if rng.random() < 0.12 else rng.randint(20, 300)
                s.add(Inventory(party_id=p.id, sku=sku, on_hand=on_hand))

        retailers = []
        for i, name in enumerate(RETAILER_NAMES, 1):
            area = i % len(AREA_LIST)
            p = Party(name=name, role=PartyRole.retailer, area=AREA_LIST[area], phone=f"91000000{i:02d}")
            p.area_idx = area
            p.suppliers = [st for st in stockists if area in st.served]
            s.add(p)
            retailers.append(p)
        s.flush()

        past = [  # cause, stockist index, pincode indexes, days ago, extra days the orders actually slipped
            (DisruptionCause.landslide, 1, [8, 2], 75, (3, 6)),
            (DisruptionCause.landslide, 4, [8], 40, (4, 5)),
            (DisruptionCause.road_closure, 2, [6, 7], 50, (1, 3)),
            (DisruptionCause.weather, 0, [1, 2], 20, (1, 2)),
        ]
        past_disruptions = []
        for cause, st_idx, areas, ago, slip in past:
            d = Disruption(
                stockist_id=stockists[st_idx].id, cause=cause, affected_areas=[AREA_LIST[a] for a in areas],
                reported_at=at(today() - timedelta(days=ago), 7), resolved_at=at(today() - timedelta(days=ago - 4), 18),
            )
            s.add(d)
            past_disruptions.append((d, st_idx, set(areas), ago, slip))
        s.flush()

        n_history = 0
        for r in retailers:
            day = today() - timedelta(days=HISTORY_DAYS)
            while day < today() - timedelta(days=7):
                supplier = r.suppliers[0] if rng.random() < 0.75 or len(r.suppliers) == 1 else rng.choice(r.suppliers[1:])
                normal = lane_days(supplier.home, r.area_idx)
                promised = day + timedelta(days=normal + 1)
                actual = normal + (1 if rng.random() < 0.15 else 0) - (1 if normal > 1 and rng.random() < 0.2 else 0)
                hit = next(
                    (pd for pd in past_disruptions
                     if pd[1] == stockists.index(supplier) and r.area_idx in pd[2]
                     and 0 <= (today() - timedelta(days=pd[3]) - day).days <= normal + 1),
                    None,
                )
                extra = rng.randint(*hit[4]) if hit else 0
                delivered = day + timedelta(days=actual + extra)
                order = Order(
                    buyer_id=r.id, supplier_id=supplier.id, status=OrderStatus.delivered,
                    payment_mode=PaymentMode.cod if rng.random() < 0.65 else PaymentMode.prepaid,
                    delivery_area=r.area, created_at=at(day, rng.randint(8, 18)), promised_date=promised,
                    expected_delivery_date=promised + timedelta(days=extra), delivered_at=at(delivered, 15),
                    lines=random_lines(),
                    events=[OrderEvent(status=OrderStatus.placed, timestamp=at(day, 8)),
                            OrderEvent(status=OrderStatus.delivered, timestamp=at(delivered, 15))],
                )
                s.add(order)
                if hit:
                    s.flush()
                    s.add(OrderDisruption(order_id=order.id, disruption_id=hit[0].id, original_eta=promised,
                                          revised_eta=promised + timedelta(days=extra), actual_delivery=delivered))
                n_history += 1
                day += timedelta(days=rng.randint(3, 6))

        n_open = 0
        statuses = [OrderStatus.placed, OrderStatus.confirmed, OrderStatus.dispatched]
        for r in retailers:
            supplier = r.suppliers[0]
            for _ in range(rng.choice([1, 1, 2])):
                created = today() - timedelta(days=rng.randint(0, 2))
                promised = created + timedelta(days=lane_days(supplier.home, r.area_idx) + 1)
                s.add(Order(
                    buyer_id=r.id, supplier_id=supplier.id, status=rng.choice(statuses),
                    payment_mode=PaymentMode.cod if rng.random() < 0.65 else PaymentMode.prepaid,
                    delivery_area=r.area, created_at=at(created, rng.randint(8, 18)), promised_date=promised,
                    expected_delivery_date=promised,
                    needed_by=promised + timedelta(days=rng.randint(0, 3)) if rng.random() < 0.5 else None,
                    lines=random_lines(),
                    events=[OrderEvent(status=OrderStatus.placed, timestamp=at(created, 8))],
                ))
                n_open += 1
        s.commit()

        print(f"Seeded {len(stockists)} stockists, {len(retailers)} retailers, {len(PRODUCTS)} SKUs, "
              f"{n_history} delivered orders, {n_open} open orders, {len(past)} past disruptions.\n")
        print("Stockists (phone → link in Telegram with /start):")
        for p in stockists:
            print(f"  #{p.id:<3} {p.name:<24} {p.phone}  serves {', '.join(AREA_LIST[a] for a in p.served)}")
        print("\nRetailers:")
        for p in retailers:
            print(f"  #{p.id:<3} {p.name:<20} {p.phone}  {p.area} {AREAS[p.area]:<14} buys from {p.suppliers[0].name}")


if __name__ == "__main__":
    main()
