from functools import lru_cache
from typing import Protocol, TypedDict

from app.config import get_settings


class Button(TypedDict):
    text: str
    data: str  # callback payload, max 64 bytes for Telegram


class NotificationChannel(Protocol):
    name: str

    def send(self, chat_id: str, text: str, buttons: list[list[Button]]) -> bool: ...


class NullChannel:
    """Records messages instead of sending them. Used in tests and when no bot token is configured."""

    name = "none"

    def __init__(self) -> None:
        self.sent: list[tuple[str, str, list[list[Button]]]] = []

    def send(self, chat_id: str, text: str, buttons: list[list[Button]]) -> bool:
        self.sent.append((chat_id, text, buttons))
        return True


@lru_cache
def get_channel() -> NotificationChannel:
    token = get_settings().telegram_bot_token
    if token:
        from app.notifications.telegram import TelegramChannel

        return TelegramChannel(token)
    return NullChannel()
