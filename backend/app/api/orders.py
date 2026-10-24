from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import ChannelDep, SessionDep, order_or_404
from app.models import OPEN_STATUSES, NotificationKind, Order, OrderDisruption
from app.notifications import notify as send
from app.schemas import (
    AlternativesOut,
    NeededByIn,
    OrderDetailOut,
    OrderEventIn,
    OrderIn,
    OrderOut,
    SwitchIn,
    SwitchOut,
)
from app.services import messages, workflows
from app.services.alternatives import find_alternatives

router = APIRouter(prefix="/orders", tags=["orders"])


def _detail(session, order: Order) -> OrderDetailOut:
    links = session.scalars(select(OrderDisruption).where(OrderDisruption.order_id == order.id)).all()
    return OrderDetailOut.model_validate(
        {**OrderOut.of(order).model_dump(), "events": order.events, "disruptions": links}
    )


@router.post("", response_model=OrderDetailOut, status_code=201)
def create_order(body: OrderIn, session: SessionDep, channel: ChannelDep):
    order = workflows.create_order(
        session,
        channel,
        body.buyer_id,
        body.supplier_id,
        [(line.sku, line.qty) for line in body.lines],
        body.payment_mode,
        body.needed_by,
    )
    return _detail(session, order)


@router.get("", response_model=list[OrderOut])
def list_orders(
    session: SessionDep,
    buyer_id: int | None = None,
    supplier_id: int | None = None,
    open: bool = False,
    limit: int = 100,
):
    stmt = select(Order).options(selectinload(Order.lines)).order_by(Order.id.desc()).limit(limit)
    if buyer_id is not None:
        stmt = stmt.where(Order.buyer_id == buyer_id)
    if supplier_id is not None:
        stmt = stmt.where(Order.supplier_id == supplier_id)
    if open:
        stmt = stmt.where(Order.status.in_(OPEN_STATUSES))
    return [OrderOut.of(o) for o in session.scalars(stmt)]


@router.get("/{order_id}", response_model=OrderDetailOut)
def get_order(order_id: int, session: SessionDep):
    return _detail(session, order_or_404(session, order_id))


@router.post("/{order_id}/events", response_model=OrderDetailOut)
def add_event(order_id: int, body: OrderEventIn, session: SessionDep):
    order = workflows.record_event(session, order_or_404(session, order_id), body.status, body.note)
    return _detail(session, order)


@router.patch("/{order_id}/needed-by", response_model=AlternativesOut)
def set_needed_by(order_id: int, body: NeededByIn, session: SessionDep, channel: ChannelDep, notify: bool = False):
    """Record when the retailer needs the goods and return who can deliver in time.
    With `notify=true` the alternatives are also pushed to the retailer's chat."""
    order = workflows.set_needed_by(session, order_or_404(session, order_id), body.needed_by, body.days_left)
    result = find_alternatives(session, order)
    if notify:
        text, buttons = messages.alternatives_message(order, result)
        send(session, channel, order.buyer, NotificationKind.alternatives, text, buttons, order_id=order.id,
             disruption_id=workflows.latest_disruption_id(session, order.id))
        session.commit()
    return result


@router.get("/{order_id}/alternatives", response_model=AlternativesOut)
def alternatives(order_id: int, session: SessionDep):
    return find_alternatives(session, order_or_404(session, order_id))


@router.post("/{order_id}/switch", response_model=SwitchOut)
def switch(order_id: int, body: SwitchIn, session: SessionDep, channel: ChannelDep):
    result = workflows.switch_order(session, channel, order_or_404(session, order_id), body.stockist_id)
    return SwitchOut(
        old_order=OrderOut.of(result.old_order),
        new_order=OrderOut.of(result.new_order),
        remaining_qty=result.remaining_qty,
    )
