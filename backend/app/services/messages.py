"""Text and buttons for the notifications we send. Telegram HTML formatting."""

from html import escape

from app.models import Disruption, Order, PaymentMode
from app.notifications import Button
from app.services.alternatives import AlternativesResult
from app.services.disruptions import AffectedOrder, DelayEstimate

DAYS_LEFT_CHOICES = (1, 2, 3, 5, 7)


def _d(value) -> str:
    return f"{value:%a %d %b}"


def cause_label(disruption: Disruption) -> str:
    return disruption.cause.value.replace("_", " ")


def days_left_buttons(order_id: int) -> list[list[Button]]:
    return [[{"text": f"{n}d", "data": f"dl:{order_id}:{n}"} for n in DAYS_LEFT_CHOICES]]


def alternatives_block(result: AlternativesResult) -> tuple[str, list[list[Button]]]:
    if not result.eligible:
        return "", []
    if result.needed_by is None:
        text = (
            "\n\nThis is a cash-on-delivery order, so you can switch to another trusted stockist. "
            "<b>How many days of stock do you have left?</b>"
        )
        return text, days_left_buttons(result.order_id)

    if result.arrives_in_time:
        head = f"\n\nIt should still arrive before you need it ({_d(result.needed_by)})."
    else:
        head = f"\n\n⚠️ This is after your needed-by date ({_d(result.needed_by)}, {result.days_left} day(s) left)."

    if not result.alternatives:
        return head + "\nNo other trusted stockist can deliver to you before then.", days_left_buttons(result.order_id)

    lines = [head, "<b>Trusted stockists who can deliver in time (COD):</b>"]
    buttons: list[list[Button]] = []
    for i, alt in enumerate(result.alternatives, 1):
        cover = "full order" if alt.coverage >= 1 else f"{alt.coverage:.0%} of order"
        reliability = f", {alt.on_time_rate:.0%} on time" if alt.on_time_rate is not None else ""
        lines.append(f"{i}. {escape(alt.name)}: by {_d(alt.eta)}, {cover}{reliability}")
        buttons.append([{"text": f"Switch to {alt.name}"[:40], "data": f"sw:{result.order_id}:{alt.stockist_id}"}])
    buttons.append([{"text": "Keep my order", "data": f"keep:{result.order_id}"}])
    return "\n".join(lines), buttons


def alternatives_message(order: Order, result: AlternativesResult) -> tuple[str, list[list[Button]]]:
    """Reply after the retailer tells us how many days of stock they have left."""
    block, buttons = alternatives_block(result)
    text = f"Order #{order.id} from {escape(order.supplier.name)} is now expected <b>{_d(result.current_eta)}</b>."
    return text + block, buttons


def retailer_delay(
    disruption: Disruption, affected: AffectedOrder, alternatives: AlternativesResult
) -> tuple[str, list[list[Button]]]:
    order = affected.order
    text = (
        f"🚧 <b>Order #{order.id} from {escape(order.supplier.name)} is delayed</b>\n"
        f"Reason: {cause_label(disruption)}"
        + (f" ({escape(disruption.note)})" if disruption.note else "")
        + f"\nWas due: {_d(affected.original_eta)}\n"
        f"Now expected: <b>{_d(affected.revised_eta)}</b> (+{affected.slip_days} day(s))\n"
        f"<i>Deliveries to {order.delivery_area}: {escape(affected.lane.basis)}</i>"
    )
    extra, buttons = alternatives_block(alternatives)
    return text + extra, buttons


def stockist_summary(
    disruption: Disruption, delay: DelayEstimate, affected: list[AffectedOrder], shown: int, asked: int
) -> str:
    areas = ", ".join(disruption.affected_areas) or "all your areas"
    lines = [
        f"📣 <b>Disruption #{disruption.id} recorded: {cause_label(disruption)}</b> ({areas})",
        f"Delay estimate: {escape(delay.basis)}",
        f"{len(affected)} open order(s) affected; retailers have been notified.",
    ]
    if shown:
        lines.append(f"{shown} COD order(s): retailer was shown other stockists who can deliver in time.")
    if asked:
        lines.append(f"{asked} COD order(s): retailer was asked how many days of stock they have left.")
    for a in affected[:15]:
        lines.append(
            f"• #{a.order.id} {escape(a.order.buyer.name)} ({a.order.delivery_area}): "
            f"{_d(a.original_eta)} → {_d(a.revised_eta)}"
            + (" [COD]" if a.order.payment_mode == PaymentMode.cod else "")
        )
    if len(affected) > 15:
        lines.append(f"…and {len(affected) - 15} more")
    return "\n".join(lines)


def switch_confirmed(old: Order, new: Order, remaining_qty: int) -> str:
    text = (
        f"✅ Switched: new order #{new.id} placed with {escape(new.supplier.name)} (COD), "
        f"expected {_d(new.expected_delivery_date)}."
    )
    if remaining_qty:
        text += f"\n{remaining_qty} unit(s) they couldn't supply stay on order #{old.id} with {escape(old.supplier.name)}."
    else:
        text += f"\nOrder #{old.id} with {escape(old.supplier.name)} has been cancelled."
    return text


def order_switched_away(old: Order, new: Order, cancelled: bool) -> str:
    what = "cancelled" if cancelled else "reduced"
    return (
        f"ℹ️ {escape(old.buyer.name)} {what} COD order #{old.id} because of the delay and moved "
        f"{sum(l.qty for l in new.lines)} unit(s) to another stockist."
    )


def new_order(order: Order, disruption_id: int | None) -> str:
    items = ", ".join(f"{l.sku} × {l.qty}" for l in order.lines)
    origin = f" (moved from a stockist hit by disruption #{disruption_id})" if disruption_id else ""
    return (
        f"🆕 New COD order #{order.id} from {escape(order.buyer.name)} ({order.delivery_area}){origin}\n"
        f"{items}\nPlease deliver by {_d(order.expected_delivery_date)}."
    )
