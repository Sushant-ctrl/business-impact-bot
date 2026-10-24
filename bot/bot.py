"""Telegram bot: stockists report disruptions; retailers get delays, say how many days of stock
they have left, and switch COD orders to another trusted stockist.

Callback data prefixes:
  dc:<cause>        report flow: pick cause
  da:<area>|*|done  report flow: toggle area / all areas / finished
  dd:<days>|?       report flow: extra days known, or unknown (estimate from history)
  dx:yes|no         report flow: confirm or cancel
  rs:<id>           resolve a disruption
  dl:<order>:<n>    retailer: n days of stock left
  sw:<order>:<sid>  retailer: switch COD order to stockist sid
  keep:<order>      retailer: keep the delayed order
"""

import logging
import os
from datetime import date
from html import escape

from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    Update,
)
from telegram.constants import ParseMode
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

from api_client import ApiError, Backend

log = logging.getLogger("bot")

CAUSES = {
    "weather": "🌧 Weather",
    "road_closure": "🚧 Road closure",
    "landslide": "⛰ Landslide",
    "flood": "🌊 Flood",
    "strike": "✊ Strike",
    "vehicle_breakdown": "🚚 Vehicle breakdown",
    "other": "Other",
}
DELAY_CHOICES = (1, 2, 3, 5)

backend = Backend(os.environ.get("BACKEND_URL", "http://localhost:8000"))


def kb(rows: list[list[tuple[str, str]]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton(t, callback_data=d) for t, d in row] for row in rows])


def fmt_date(iso: str) -> str:
    return f"{date.fromisoformat(iso):%a %d %b}"


async def reply(update: Update, text: str, markup=None) -> None:
    await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)


async def me(update: Update) -> dict | None:
    party = await backend.party_by_chat(update.effective_chat.id)
    if party is None:
        await reply(update, "This chat isn't linked yet. Send /start and share your phone number.")
    return party


# ── Linking ────────────────────────────────────────────────────────────────────

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    party = await backend.party_by_chat(update.effective_chat.id)
    if party:
        await reply(update, f"You're linked as <b>{escape(party['name'])}</b> ({party['role']}).\n\n" + help_text(party))
        return
    button = KeyboardButton("📱 Share my phone number", request_contact=True)
    await reply(
        update,
        "Welcome! Share your registered phone number to link this chat to your stockist or retailer account.",
        ReplyKeyboardMarkup([[button]], one_time_keyboard=True, resize_keyboard=True),
    )


async def contact(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    shared = update.effective_message.contact
    if shared.user_id != update.effective_user.id:
        await reply(update, "Please share your own number using the button.")
        return
    try:
        party = await backend.link_chat(shared.phone_number, update.effective_chat.id)
    except ApiError as e:
        await update.effective_message.reply_text(e.detail, reply_markup=ReplyKeyboardRemove())
        return
    await update.effective_message.reply_text(
        f"Linked as {party['name']} ({party['role']}).", reply_markup=ReplyKeyboardRemove()
    )
    await reply(update, help_text(party))


def help_text(party: dict) -> str:
    if party["role"] == "stockist":
        return (
            "/disrupt: report an unexpected delay (weather, road closure, landslide…)\n"
            "/disruptions: your active disruptions\n"
            "/orders: your open orders to retailers"
        )
    return "/myorders: your open orders and their expected delivery dates"


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if party := await me(update):
        await reply(update, help_text(party))


# ── Stockist: report a disruption ─────────────────────────────────────────────

async def disrupt(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    party = await me(update)
    if not party:
        return
    if party["role"] != "stockist":
        await reply(update, "Only stockists can report disruptions.")
        return
    context.user_data["report"] = {"stockist_id": party["id"], "areas": [], "all_areas": await backend.service_areas(party["id"])}
    causes = list(CAUSES.items())
    rows = [[(label, f"dc:{key}") for key, label in causes[i:i + 2]] for i in range(0, len(causes), 2)]
    await reply(update, "What caused the delay?", kb(rows))


def area_keyboard(report: dict) -> InlineKeyboardMarkup:
    rows = [[(("✅ " if a in report["areas"] else "") + a, f"da:{a}")] for a in report["all_areas"]]
    rows.append([("All my areas", "da:*"), ("Done ➡️", "da:done")])
    return kb(rows)


async def on_report_step(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    report = context.user_data.get("report")
    prefix, value = query.data.split(":", 1)
    if report is None:
        await query.answer()
        await query.edit_message_text("That report expired. Send /disrupt to start again.")
        return
    if prefix == "da" and value == "done" and not report["areas"]:
        await query.answer("Pick at least one area, or 'All my areas'.", show_alert=True)
        return
    await query.answer()

    if prefix == "dc":
        report["cause"] = value
        await query.edit_message_text(f"{CAUSES[value]}. Which delivery areas are affected?", reply_markup=area_keyboard(report))
    elif prefix == "da" and value not in ("*", "done"):
        if value in report["areas"]:
            report["areas"].remove(value)
        else:
            report["areas"].append(value)
        await query.edit_message_reply_markup(area_keyboard(report))
    elif prefix == "da":
        if value == "*":
            report["areas"] = []
        delay_rows = [[(f"+{n} day{'s' if n > 1 else ''}", f"dd:{n}") for n in DELAY_CHOICES], [("Don't know yet", "dd:?")]]
        areas = ", ".join(report["areas"]) or "all your areas"
        await query.edit_message_text(f"Areas: {areas}.\nHow many extra days do you expect?", reply_markup=kb(delay_rows))
    elif prefix == "dd":
        report["extra_delay_days"] = None if value == "?" else int(value)
        preview = await backend.report_disruption(_body(report), dry_run=True)
        await query.edit_message_text(
            _preview_text(preview), parse_mode=ParseMode.HTML,
            reply_markup=kb([[("✅ Confirm & notify retailers", "dx:yes"), ("Cancel", "dx:no")]]),
        )
    elif prefix == "dx":
        context.user_data.pop("report", None)
        if value == "no":
            await query.edit_message_text("Cancelled. Nothing was sent.")
            return
        result = await backend.report_disruption(_body(report), dry_run=False)
        await query.edit_message_text(
            f"Recorded disruption #{result['disruption']['id']}. "
            f"{len(result['affected'])} retailer order(s) notified; summary sent above."
        )


def _body(report: dict) -> dict:
    return {
        "stockist_id": report["stockist_id"],
        "cause": report["cause"],
        "areas": report["areas"],
        "extra_delay_days": report.get("extra_delay_days"),
    }


def _preview_text(preview: dict) -> str:
    affected = preview["affected"]
    lines = [
        f"<b>{len(affected)} open order(s) will be marked delayed</b> ({preview['cod_count']} COD).",
        f"Estimate: {escape(preview['delay_basis'])}",
    ]
    for a in affected[:10]:
        lines.append(f"• #{a['order_id']} {escape(a['retailer_name'])}: {fmt_date(a['original_eta'])} → {fmt_date(a['revised_eta'])}")
    if len(affected) > 10:
        lines.append(f"…and {len(affected) - 10} more")
    return "\n".join(lines)


async def disruptions_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    party = await me(update)
    if not party or party["role"] != "stockist":
        return
    items = await backend.disruptions(party["id"])
    if not items:
        await reply(update, "No active disruptions.")
        return
    for d in items:
        areas = ", ".join(d["affected_areas"]) or "all areas"
        await reply(
            update,
            f"#{d['id']} {CAUSES.get(d['cause'], d['cause'])} on {areas} (reported {fmt_date(d['reported_at'][:10])})",
            kb([[("Mark resolved", f"rs:{d['id']}")]]),
        )


async def on_resolve(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    party = await backend.party_by_chat(update.effective_chat.id)
    disruption_id = int(query.data.split(":")[1])
    mine = {d["id"] for d in await backend.disruptions(party["id"])} if party else set()
    if disruption_id not in mine:
        await query.answer("Not one of your active disruptions.", show_alert=True)
        return
    await backend.resolve(disruption_id)
    await query.answer("Resolved")
    await query.edit_message_text(f"Disruption #{disruption_id} resolved. Thanks, this improves future estimates.")


async def orders_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    party = await me(update)
    if not party:
        return
    key = "supplier_id" if party["role"] == "stockist" else "buyer_id"
    orders = await backend.orders(**{key: party["id"]})
    if not orders:
        await reply(update, "No open orders.")
        return
    lines = []
    for o in orders[:20]:
        other = o["buyer_name"] if party["role"] == "stockist" else o["supplier_name"]
        late = " ⚠️ delayed" if o["expected_delivery_date"] > o["promised_date"] else ""
        lines.append(
            f"#{o['id']} {escape(other)}: {o['status']}, {o['payment_mode'].upper()}, "
            f"expected {fmt_date(o['expected_delivery_date'])}{late}"
        )
    await reply(update, "\n".join(lines))


# ── Retailer: days left, switch, keep ──────────────────────────────────────────

async def _own_order(query, party: dict | None, order_id: int) -> dict | None:
    if party is None:
        await query.answer("Link this chat first with /start.", show_alert=True)
        return None
    order = await backend.order(order_id)
    if order["buyer_id"] != party["id"]:
        await query.answer("That isn't your order.", show_alert=True)
        return None
    return order


async def on_retailer_action(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    parts = query.data.split(":")
    action, order_id = parts[0], int(parts[1])
    party = await backend.party_by_chat(update.effective_chat.id)
    if await _own_order(query, party, order_id) is None:
        return

    try:
        if action == "dl":
            await query.answer(f"Finding stockists who can deliver within {parts[2]} day(s)…")
            await query.edit_message_reply_markup(None)
            await backend.set_days_left(order_id, int(parts[2]))  # backend pushes the alternatives
        elif action == "sw":
            await query.answer("Switching your order…")
            await backend.switch(order_id, int(parts[2]))  # backend pushes the confirmation to everyone
            await query.edit_message_reply_markup(None)
        elif action == "keep":
            await query.answer("Keeping your order")
            await query.edit_message_reply_markup(None)
            await reply(update, f"OK, keeping order #{order_id}. We'll message you if the date changes again.")
    except ApiError as e:
        await reply(update, f"Couldn't do that: {escape(e.detail)}")


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    log.exception("Unhandled error", exc_info=context.error)
    if isinstance(update, Update) and update.effective_message:
        await update.effective_message.reply_text("Something went wrong. Please try again.")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN")
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(MessageHandler(filters.CONTACT, contact))
    app.add_handler(CommandHandler("disrupt", disrupt))
    app.add_handler(CommandHandler("disruptions", disruptions_cmd))
    app.add_handler(CommandHandler(["orders", "myorders"], orders_cmd))
    app.add_handler(CallbackQueryHandler(on_report_step, pattern=r"^(dc|da|dd|dx):"))
    app.add_handler(CallbackQueryHandler(on_resolve, pattern=r"^rs:\d+$"))
    app.add_handler(CallbackQueryHandler(on_retailer_action, pattern=r"^(dl|sw|keep):\d+"))
    app.add_error_handler(on_error)
    app.run_polling()


if __name__ == "__main__":
    main()
