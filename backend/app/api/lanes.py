from fastapi import APIRouter

from app.api.deps import SessionDep
from app.schemas import LaneOut
from app.services.lanes import lane_estimate

router = APIRouter(prefix="/lanes", tags=["lanes"])


@router.get("/estimate", response_model=LaneOut)
def estimate(stockist_id: int, area: str, session: SessionDep):
    """How many days deliveries from this stockist to this pincode normally take."""
    return lane_estimate(session, stockist_id, area)
