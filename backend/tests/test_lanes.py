from app.models import OrderDisruption
from app.services.lanes import lane_estimate


def test_lane_uses_history_for_that_stockist_and_pincode(f, session):
    s, r = f.stockist(), f.retailer(area="560001")
    f.history(r, s, [1, 2, 2, 3, 4], promised_days=3)

    est = lane_estimate(session, s.id, "560001")

    assert (est.scope, est.n, est.median_days, est.p80_days) == ("lane", 5, 2, 3)
    assert est.on_time_rate == 0.8  # the 4-day delivery missed its 3-day promise
    assert "5 past deliveries to 560001" in est.basis


def test_lane_falls_back_to_other_stockists_on_the_same_pincode(f, session):
    s1, s2, r = f.stockist("S1"), f.stockist("S2"), f.retailer()
    f.history(r, s1, [5])  # too few samples for S1 alone
    f.history(r, s2, [2, 2, 3])

    est = lane_estimate(session, s1.id, "560001")

    assert est.scope == "area"
    assert est.n == 4 and est.median_days == 3  # median 2.5 rounds up: ETAs err late


def test_lane_falls_back_to_stockist_history_elsewhere(f, session):
    s, far = f.stockist(), f.retailer(area="560099")
    f.history(far, s, [3, 3, 4])

    est = lane_estimate(session, s.id, "560001")

    assert est.scope == "stockist" and est.median_days == 3


def test_lane_default_without_history(f, session):
    est = lane_estimate(session, f.stockist().id, "560001")
    assert est.scope == "default" and est.n == 0 and est.median_days == 2


def test_lane_excludes_orders_hit_by_disruptions(f, session):
    s, r = f.stockist(), f.retailer()
    f.history(r, s, [2, 2, 2])
    slow = f.history(r, s, [9, 9, 9])
    d = f.past_disruption(s, "landslide", "560050", [])
    for o in slow:
        session.add(OrderDisruption(order_id=o.id, disruption_id=d.id, original_eta=o.promised_date,
                                    revised_eta=o.promised_date))
    session.flush()

    est = lane_estimate(session, s.id, "560001")

    assert est.n == 3 and est.median_days == 2
