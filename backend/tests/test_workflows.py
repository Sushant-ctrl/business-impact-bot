from datetime import datetime, time, timedelta

import pytest
from sqlalchemy import select

from app.models import (
    DisruptionCause,
    Notification,
    NotificationKind,
    OrderDisruption,
    OrderStatus,
    PaymentMode,
)
from app.services.disruptions import estimate_delay
from app.services.workflows import (
    WorkflowError,
    create_order,
    record_event,
    report_disruption,
    resolve_disruption,
    switch_order,
)

AREA = "560001"


@pytest.fixture
def setup(f):
    original = f.stockist("Original", serves=[AREA], chat_id="c-orig")
    backup = f.stockist("Backup", serves=[AREA], chat_id="c-backup")
    f.stock(backup, "SKU1", 100)
    cod_r = f.retailer("COD Retailer", area=AREA, chat_id="c-cod")
    pre_r = f.retailer("Prepaid Retailer", area=AREA)  # no chat linked
    f.history(cod_r, backup, [1, 1, 1])
    cod = f.order(cod_r, original, promised=f.today + timedelta(days=1), needed_by=f.today + timedelta(days=2))
    prepaid = f.order(pre_r, original, payment_mode=PaymentMode.prepaid, promised=f.today + timedelta(days=1))
    return {"original": original, "backup": backup, "cod": cod, "prepaid": prepaid}


def test_report_disruption_delays_orders_and_notifies_both_sides(session, channel, setup):
    disruption, impact = report_disruption(
        session, channel, setup["original"].id, DisruptionCause.landslide, [AREA], extra_delay_days=3,
        note="NH-48 blocked near ghat",
    )

    cod, prepaid = setup["cod"], setup["prepaid"]
    assert len(impact.affected) == 2
    assert cod.expected_delivery_date == cod.promised_date + timedelta(days=3)
    assert session.scalar(select(OrderDisruption).where(OrderDisruption.order_id == cod.id)).revised_eta == (
        cod.expected_delivery_date
    )
    assert "Delayed by disruption" in cod.events[-1].note

    notes = {(n.party_id, n.kind): n for n in session.scalars(select(Notification))}
    cod_note = notes[(cod.buyer_id, NotificationKind.retailer_delay)]
    assert "NH-48 blocked" in cod_note.message and "Backup" in cod_note.message
    assert {"text": "Switch to Backup", "data": f"sw:{cod.id}:{setup['backup'].id}"} in sum(cod_note.buttons, [])
    assert notes[(prepaid.buyer_id, NotificationKind.retailer_delay)].buttons == []
    assert notes[(prepaid.buyer_id, NotificationKind.retailer_delay)].channel == "none"
    summary = notes[(setup["original"].id, NotificationKind.stockist_summary)]
    assert "2 open order(s) affected" in summary.message and "1 COD order(s): retailer was shown" in summary.message

    assert sorted(chat for chat, _, _ in channel.sent) == ["c-cod", "c-orig"]


def test_full_switch_cancels_original_and_places_new_order(session, channel, setup):
    report_disruption(session, channel, setup["original"].id, DisruptionCause.weather, [AREA], extra_delay_days=3)
    channel.sent.clear()

    result = switch_order(session, channel, setup["cod"], setup["backup"].id)

    old, new = result.old_order, result.new_order
    assert old.status == OrderStatus.cancelled and old.switched_to_id == new.id
    assert [(l.sku, l.qty) for l in old.lines] == [("SKU1", 10)]  # kept for the record
    assert new.supplier_id == setup["backup"].id and new.payment_mode == PaymentMode.cod
    assert [(l.sku, l.qty) for l in new.lines] == [("SKU1", 10)]
    assert new.expected_delivery_date == new.promised_date and new.needed_by == old.needed_by
    assert sorted(chat for chat, _, _ in channel.sent) == ["c-backup", "c-cod", "c-orig"]


def test_partial_switch_leaves_the_rest_with_original(session, channel, f, setup):
    partial = f.stockist("Partial", serves=[AREA])
    f.stock(partial, "SKU1", 6)

    result = switch_order(session, channel, setup["cod"], partial.id)

    assert result.remaining_qty == 4
    assert result.old_order.status == OrderStatus.placed
    assert [(l.sku, l.qty) for l in result.old_order.lines] == [("SKU1", 4)]
    assert [(l.sku, l.qty) for l in result.new_order.lines] == [("SKU1", 6)]


def test_switch_is_refused_for_prepaid_or_unavailable_stockists(session, channel, f, setup):
    with pytest.raises(WorkflowError, match="cash-on-delivery"):
        switch_order(session, channel, setup["prepaid"], setup["backup"].id)
    far = f.stockist("Far", serves=["560099"])
    f.stock(far, "SKU1", 100)
    with pytest.raises(WorkflowError, match="can't supply"):
        switch_order(session, channel, setup["cod"], far.id)


def test_delivery_feeds_back_into_future_delay_estimates(session, channel, setup):
    disruption, _ = report_disruption(session, channel, setup["original"].id, DisruptionCause.landslide, [AREA])
    cod = setup["cod"]
    record_event(session, cod, OrderStatus.delivered, at=datetime.combine(cod.promised_date + timedelta(days=6), time(12)))
    resolve_disruption(session, disruption)

    link = session.scalar(select(OrderDisruption).where(OrderDisruption.order_id == cod.id))
    assert link.actual_delivery == cod.promised_date + timedelta(days=6)
    assert estimate_delay(session, DisruptionCause.landslide, [AREA]).extra_days == 6


def test_new_order_into_disrupted_lane_starts_delayed(session, channel, f, setup):
    report_disruption(session, channel, setup["original"].id, DisruptionCause.flood, [AREA], extra_delay_days=2)

    order = create_order(session, channel, setup["cod"].buyer_id, setup["original"].id, [("SKU1", 5)])

    assert order.expected_delivery_date == order.promised_date + timedelta(days=2)


def test_invalid_status_transition_is_rejected(session, setup):
    record_event(session, setup["cod"], OrderStatus.delivered)
    with pytest.raises(WorkflowError):
        record_event(session, setup["cod"], OrderStatus.dispatched)
