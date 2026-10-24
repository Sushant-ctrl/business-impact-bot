"""Walk through the disruption flow on seeded data and print what everyone would receive.

    uv run python -m scripts.demo_disruption [--stockist 2] [--areas 248179 248003] [--cause landslide]

Modifies the database (records the disruption); re-run `scripts.seed` to reset.
"""

import argparse
import re
from html import unescape

from sqlalchemy import select

from app.db import SessionLocal
from app.models import DisruptionCause, Notification, Order, PaymentMode
from app.notifications import get_channel
from app.services.alternatives import find_alternatives
from app.services.workflows import report_disruption, set_needed_by


def plain(html: str) -> str:
    return unescape(re.sub(r"<[^>]+>", "", html))


def show(n: Notification, party_name: str) -> None:
    print(f"\n── to {party_name} [{n.kind.value}, via {n.channel}] " + "─" * 20)
    print(plain(n.message))
    for row in n.buttons:
        print("   " + "  ".join(f"[{b['text']}]" for b in row))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stockist", type=int, default=2)
    parser.add_argument("--areas", nargs="*", default=["248179", "248003"])
    parser.add_argument("--cause", default="landslide", choices=[c.value for c in DisruptionCause])
    parser.add_argument("--extra-days", type=int, default=None, help="omit to estimate from past disruptions")
    args = parser.parse_args()

    with SessionLocal() as s:
        disruption, impact = report_disruption(
            s, get_channel(), args.stockist, DisruptionCause(args.cause), args.areas,
            extra_delay_days=args.extra_days, note="Debris on the hill road",
        )
        print(f"Disruption #{disruption.id}: {args.cause} on {', '.join(args.areas)}")
        print(f"Delay estimate: {impact.delay.basis}")
        print(f"{len(impact.affected)} order(s) affected")

        for n in s.scalars(select(Notification).where(Notification.disruption_id == disruption.id)):
            show(n, s.get(Order, n.order_id).buyer.name if n.order_id else disruption.stockist.name)

        # A COD retailer who hadn't given a needed-by date answers "2 days of stock left".
        pending = next(
            (a.order for a in impact.affected if a.order.payment_mode == PaymentMode.cod and a.order.needed_by is None),
            None,
        )
        if pending:
            set_needed_by(s, pending, days_left=2)
            result = find_alternatives(s, pending)
            print(f"\n── {pending.buyer.name} replies '2 days left' for order #{pending.id} " + "─" * 10)
            print(f"Delayed order now expected {result.current_eta}; needed by {result.needed_by}")
            for alt in result.alternatives:
                print(f"   {alt.name}: ETA {alt.eta}, covers {alt.coverage:.0%}"
                      + (f", missing {', '.join(alt.missing_skus)}" if alt.missing_skus else "") + f" ({alt.basis})")
            if not result.alternatives:
                print("   No trusted stockist can deliver in time.")


if __name__ == "__main__":
    main()
