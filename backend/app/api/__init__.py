from fastapi import APIRouter

from app.api import disruptions, lanes, notifications, orders, parties

router = APIRouter(prefix="/api")
for module in (parties, orders, disruptions, lanes, notifications):
    router.include_router(module.router)
