from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import ChannelDep, SessionDep, get_or_404
from app.models import Disruption, PartyRole, PaymentMode
from app.schemas import AffectedOrderOut, DisruptionIn, DisruptionOut, DisruptionReportOut
from app.services import workflows
from app.services.disruptions import DisruptionImpact, assess

router = APIRouter(prefix="/disruptions", tags=["disruptions"])


def _report(disruption: Disruption | None, impact: DisruptionImpact) -> DisruptionReportOut:
    return DisruptionReportOut(
        disruption=DisruptionOut.model_validate(disruption) if disruption else None,
        delay_basis=impact.delay.basis,
        affected=[AffectedOrderOut.of(a) for a in impact.affected],
        cod_count=sum(a.order.payment_mode == PaymentMode.cod for a in impact.affected),
    )


@router.post("", response_model=DisruptionReportOut)
def report(body: DisruptionIn, session: SessionDep, channel: ChannelDep, dry_run: bool = False):
    """Report an unexpected disruption. With `dry_run=true`, only preview which orders it would delay."""
    if dry_run:
        workflows.require_party(session, body.stockist_id, PartyRole.stockist)
        impact = assess(
            session, body.stockist_id, body.cause, body.areas, body.extra_delay_days, body.expected_clear_date
        )
        return _report(None, impact)
    disruption, impact = workflows.report_disruption(
        session,
        channel,
        body.stockist_id,
        body.cause,
        body.areas,
        body.extra_delay_days,
        body.expected_clear_date,
        body.note,
    )
    return _report(disruption, impact)


@router.get("", response_model=list[DisruptionOut])
def list_disruptions(session: SessionDep, stockist_id: int | None = None, active: bool = False):
    stmt = select(Disruption).order_by(Disruption.reported_at.desc())
    if stockist_id is not None:
        stmt = stmt.where(Disruption.stockist_id == stockist_id)
    if active:
        stmt = stmt.where(Disruption.resolved_at.is_(None))
    return session.scalars(stmt).all()


@router.post("/{disruption_id}/resolve", response_model=DisruptionOut)
def resolve(disruption_id: int, session: SessionDep):
    disruption = get_or_404(session, Disruption, disruption_id, "disruption")
    return workflows.resolve_disruption(session, disruption)
