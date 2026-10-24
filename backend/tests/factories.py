from datetime import date, datetime, time, timedelta
from itertools import count

from app.clock import today
from app.models import (
    Disruption,
    DisruptionCause,
    Inventory,
    Order,
    OrderDisruption,
    OrderLine,
    OrderStatus,
    Party,
    PartyRole,
    PaymentMode,
    Product,
    ServiceArea,
)

_phones = count(9000000000)


class Factory:
    def __init__(self, session):
        self.s = session
        self.today = today()

    def product(self, sku="SKU1"):
        p = self.s.get(Product, sku) or Product(sku=sku, name=f"Product {sku}")
        self.s.add(p)
        self.s.flush()
        return p

    def stockist(self, name="Stockist", area="560001", serves=("560001",), trusted=True, chat_id=None):
        p = Party(name=name, role=PartyRole.stockist, area=area, phone=str(next(_phones)), trusted=trusted, chat_id=chat_id)
        self.s.add(p)
        self.s.flush()
        for a in serves:
            self.s.add(ServiceArea(stockist_id=p.id, area=a))
        self.s.flush()
        return p

    def retailer(self, name="Retailer", area="560001", chat_id=None):
        p = Party(name=name, role=PartyRole.retailer, area=area, phone=str(next(_phones)), chat_id=chat_id)
        self.s.add(p)
        self.s.flush()
        return p

    def stock(self, party, sku="SKU1", on_hand=100):
        self.product(sku)
        self.s.add(Inventory(party_id=party.id, sku=sku, on_hand=on_hand))
        self.s.flush()

    def order(
        self,
        retailer,
        stockist,
        lines=(("SKU1", 10),),
        status=OrderStatus.placed,
        payment_mode=PaymentMode.cod,
        created: date | None = None,
        promised: date | None = None,
        delivered: date | None = None,
        needed_by: date | None = None,
        area: str | None = None,
    ) -> Order:
        created = created or self.today
        promised = promised or created + timedelta(days=2)
        for sku, _ in lines:
            self.product(sku)
        o = Order(
            buyer_id=retailer.id,
            supplier_id=stockist.id,
            status=status,
            payment_mode=payment_mode,
            delivery_area=area or retailer.area,
            created_at=datetime.combine(created, time(9)),
            promised_date=promised,
            expected_delivery_date=promised,
            needed_by=needed_by,
            delivered_at=datetime.combine(delivered, time(17)) if delivered else None,
            lines=[OrderLine(sku=sku, qty=qty) for sku, qty in lines],
        )
        self.s.add(o)
        self.s.flush()
        return o

    def history(self, retailer, stockist, lead_days: list[int], promised_days: int = 3, area=None):
        """Delivered orders with the given door-to-door days, spread over recent weeks."""
        orders = []
        for i, days in enumerate(lead_days):
            created = self.today - timedelta(days=10 + 3 * i)
            orders.append(
                self.order(
                    retailer, stockist, status=OrderStatus.delivered, created=created,
                    promised=created + timedelta(days=promised_days), delivered=created + timedelta(days=days), area=area,
                )
            )
        return orders

    def past_disruption(self, stockist, cause, area, slips: list[int]):
        """A resolved disruption whose orders arrived `slip` days after their pre-disruption ETA."""
        d = Disruption(
            stockist_id=stockist.id, cause=cause, affected_areas=[area],
            reported_at=datetime.combine(self.today - timedelta(days=60), time(8)),
            resolved_at=datetime.combine(self.today - timedelta(days=55), time(8)),
        )
        self.s.add(d)
        self.s.flush()
        retailer = self.retailer(area=area)
        for slip in slips:
            eta = self.today - timedelta(days=58)
            o = self.order(retailer, stockist, status=OrderStatus.delivered, created=eta - timedelta(days=2),
                           promised=eta, delivered=eta + timedelta(days=slip))
            self.s.add(OrderDisruption(order_id=o.id, disruption_id=d.id, original_eta=eta, revised_eta=eta,
                                       actual_delivery=eta + timedelta(days=slip)))
        self.s.flush()
        return d


__all__ = ["DisruptionCause", "Factory"]
