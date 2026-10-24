"""Thin async client for the backend API. The bot never touches the database directly."""

import httpx


class ApiError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class Backend:
    def __init__(self, base_url: str):
        self._http = httpx.AsyncClient(base_url=base_url.rstrip("/") + "/api", timeout=15)

    async def _call(self, method: str, path: str, **kwargs):
        response = await self._http.request(method, path, **kwargs)
        if response.is_error:
            try:
                detail = response.json().get("detail", response.text)
            except ValueError:
                detail = response.text
            raise ApiError(response.status_code, str(detail))
        return response.json()

    async def party_by_chat(self, chat_id: int) -> dict | None:
        try:
            return await self._call("GET", f"/parties/by-chat/{chat_id}")
        except ApiError as e:
            if e.status == 404:
                return None
            raise

    async def link_chat(self, phone: str, chat_id: int) -> dict:
        return await self._call("POST", "/parties/link-chat", json={"phone": phone, "chat_id": str(chat_id)})

    async def service_areas(self, party_id: int) -> list[str]:
        return await self._call("GET", f"/parties/{party_id}/service-areas")

    async def report_disruption(self, body: dict, dry_run: bool) -> dict:
        return await self._call("POST", "/disruptions", params={"dry_run": dry_run}, json=body)

    async def disruptions(self, stockist_id: int) -> list[dict]:
        return await self._call("GET", "/disruptions", params={"stockist_id": stockist_id, "active": True})

    async def resolve(self, disruption_id: int) -> dict:
        return await self._call("POST", f"/disruptions/{disruption_id}/resolve")

    async def orders(self, **filters) -> list[dict]:
        return await self._call("GET", "/orders", params={**filters, "open": True})

    async def order(self, order_id: int) -> dict:
        return await self._call("GET", f"/orders/{order_id}")

    async def set_days_left(self, order_id: int, days: int) -> dict:
        return await self._call("PATCH", f"/orders/{order_id}/needed-by", params={"notify": True}, json={"days_left": days})

    async def switch(self, order_id: int, stockist_id: int) -> dict:
        return await self._call("POST", f"/orders/{order_id}/switch", json={"stockist_id": stockist_id})
