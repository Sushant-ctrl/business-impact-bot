from datetime import timedelta

import pytest

from app.models import Disruption, DisruptionCause, PaymentMode
from app.services.alternatives import find_alternatives

AREA = "560001"


@pytest.fixture
def network(f):
    """Original stockist plus one candidate for every reason a stockist should or shouldn't be offered."""
    r = f.retailer("Retailer", area=AREA)
    original = f.stockist("Original", serves=[AREA])
    fast = f.stockist("Fast", serves=[AREA])
    slow = f.stockist("Slow", serves=[AREA])
    elsewhere = f.stockist("Elsewhere", serves=["560099"])
    empty = f.stockist("Empty", serves=[AREA])
    untrusted = f.stockist("Untrusted", serves=[AREA], trusted=False)
    blocked = f.stockist("Blocked", serves=[AREA])
    partial = f.stockist("Partial", serves=[AREA])

    for s in (original, fast, slow, elsewhere, untrusted, blocked):
        f.stock(s, "SKU1", 100)
    f.stock(empty, "SKU1", 0)
    f.stock(partial, "SKU1", 4)

    f.history(r, fast, [2, 2, 2])
    f.history(r, partial, [1, 1, 1])
    f.history(r, slow, [6, 6, 6])
    f.history(r, blocked, [1, 1, 1])
    f.s.add(Disruption(stockist_id=blocked.id, cause=DisruptionCause.flood, affected_areas=[AREA], extra_delay_days=10))
    f.s.flush()
    return {"retailer": r, "original": original, "fast": fast, "partial": partial, "slow": slow}


def _order(f, n, **kw):
    return f.order(n["retailer"], n["original"], lines=(("SKU1", 10),), **kw)


def test_offers_only_stockists_that_can_deliver_before_needed_by(f, session, network):
    order = _order(f, network, needed_by=f.today + timedelta(days=3), promised=f.today + timedelta(days=6))

    result = find_alternatives(session, order)

    assert result.eligible and result.arrives_in_time is False and result.days_left == 3
    assert [a.name for a in result.alternatives] == ["Fast", "Partial"]  # full coverage beats a faster partial
    fast, partial = result.alternatives
    assert fast.eta == f.today + timedelta(days=2) and fast.coverage == 1.0
    assert partial.coverage == 0.4 and partial.missing_skus == ["SKU1"]


def test_stock_already_owed_on_other_orders_is_not_offered(f, session, network):
    f.order(f.retailer(area=AREA), network["fast"], lines=(("SKU1", 95),))
    order = _order(f, network, needed_by=f.today + timedelta(days=3))

    [fast, partial] = sorted(find_alternatives(session, order).alternatives, key=lambda a: a.name)

    assert fast.coverage == 0.5  # 100 on hand − 95 owed = 5 free of 10


def test_prepaid_orders_get_no_alternatives(f, session, network):
    order = _order(f, network, payment_mode=PaymentMode.prepaid, needed_by=f.today + timedelta(days=3))

    result = find_alternatives(session, order)

    assert not result.eligible and result.alternatives == []


def test_without_needed_by_retailer_is_asked_first(f, session, network):
    result = find_alternatives(session, _order(f, network))
    assert result.eligible and result.needed_by is None and result.alternatives == []
