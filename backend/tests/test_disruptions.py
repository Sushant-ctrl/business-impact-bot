from datetime import timedelta

from app.models import DisruptionCause, OrderStatus
from app.services.disruptions import affected_orders, assess, estimate_delay


def test_known_extra_days_push_eta_back(f, session):
    s, r = f.stockist(), f.retailer()
    o = f.order(r, s, promised=f.today + timedelta(days=2))

    impact = assess(session, s.id, DisruptionCause.weather, ["560001"], extra_delay_days=3)

    [a] = impact.affected
    assert a.order.id == o.id
    assert a.revised_eta == f.today + timedelta(days=5)
    assert a.slip_days == 3


def test_overdue_order_is_counted_from_today(f, session):
    s, r = f.stockist(), f.retailer()
    f.order(r, s, promised=f.today - timedelta(days=1))

    [a] = assess(session, s.id, DisruptionCause.weather, [], extra_delay_days=2).affected

    assert a.revised_eta == f.today + timedelta(days=2)


def test_clear_date_adds_normal_transit_after_reopening(f, session):
    s, r = f.stockist(), f.retailer()
    f.history(r, s, [2, 2, 2])
    f.order(r, s, promised=f.today + timedelta(days=1))

    [a] = assess(
        session, s.id, DisruptionCause.road_closure, ["560001"], expected_clear_date=f.today + timedelta(days=3)
    ).affected

    assert a.revised_eta == f.today + timedelta(days=5)


def test_unknown_delay_uses_local_history_for_that_cause(f, session):
    s = f.stockist()
    f.past_disruption(s, DisruptionCause.landslide, "560001", [3, 5])
    f.past_disruption(s, DisruptionCause.landslide, "560077", [10])  # other area, ignored when local exists

    delay = estimate_delay(session, DisruptionCause.landslide, ["560001"])

    assert delay.extra_days == 4
    assert "these areas" in delay.basis


def test_unknown_delay_falls_back_to_network_history_then_default(f, session):
    s = f.stockist()
    f.past_disruption(s, DisruptionCause.flood, "560077", [6])

    assert estimate_delay(session, DisruptionCause.flood, ["560001"]).extra_days == 6
    assert estimate_delay(session, DisruptionCause.landslide, ["560001"]).extra_days == 4  # config default
    assert estimate_delay(session, DisruptionCause.weather, ["560001"]).extra_days == 2


def test_only_open_orders_of_that_stockist_in_affected_areas(f, session):
    s, other = f.stockist("S"), f.stockist("Other")
    near, far = f.retailer(area="560001"), f.retailer(area="560002")
    hit = f.order(near, s, status=OrderStatus.dispatched)
    f.order(near, s, status=OrderStatus.delivered, delivered=f.today)
    f.order(near, s, status=OrderStatus.cancelled)
    f.order(far, s)
    f.order(near, other)

    assert [o.id for o in affected_orders(session, s.id, ["560001"])] == [hit.id]
    assert len(affected_orders(session, s.id, [])) == 2  # empty = every area this stockist delivers to
