from sqlalchemy.orm import Session

from app.models import Notification, NotificationKind, Party
from app.notifications.base import Button, NotificationChannel


def notify(
    session: Session,
    channel: NotificationChannel,
    party: Party,
    kind: NotificationKind,
    text: str,
    buttons: list[list[Button]] | None = None,
    order_id: int | None = None,
    disruption_id: int | None = None,
) -> Notification:
    """Persist the notification (so it shows in the party's feed) and push it if they linked a chat."""
    buttons = buttons or []
    sent = bool(party.chat_id) and channel.send(party.chat_id, text, buttons)
    notification = Notification(
        party_id=party.id,
        order_id=order_id,
        disruption_id=disruption_id,
        kind=kind,
        message=text,
        buttons=buttons,
        channel=channel.name if sent else "none",
    )
    session.add(notification)
    return notification
