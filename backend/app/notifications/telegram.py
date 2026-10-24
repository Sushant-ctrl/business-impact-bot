import logging

import httpx

from app.notifications.base import Button

log = logging.getLogger(__name__)


class TelegramChannel:
    name = "telegram"

    def __init__(self, token: str, timeout: float = 10.0):
        self._url = f"https://api.telegram.org/bot{token}/sendMessage"
        self._timeout = timeout

    def send(self, chat_id: str, text: str, buttons: list[list[Button]]) -> bool:
        payload: dict = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
        if buttons:
            payload["reply_markup"] = {
                "inline_keyboard": [[{"text": b["text"], "callback_data": b["data"]} for b in row] for row in buttons]
            }
        try:
            response = httpx.post(self._url, json=payload, timeout=self._timeout)
            response.raise_for_status()
            return True
        except httpx.HTTPError:
            log.exception("Telegram send to %s failed", chat_id)
            return False
