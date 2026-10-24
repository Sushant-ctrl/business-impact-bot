from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import SessionDep, party_or_404
from app.models import Inventory, Party, PartyRole, Product, ServiceArea
from app.schemas import InventoryIn, InventoryOut, LinkChatIn, PartyIn, PartyOut, ProductIn, ServiceAreasIn

router = APIRouter(tags=["parties"])


@router.post("/parties", response_model=PartyOut, status_code=201)
def create_party(body: PartyIn, session: SessionDep):
    party = Party(**body.model_dump())
    session.add(party)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, "a party with this phone already exists")
    return party


@router.get("/parties", response_model=list[PartyOut])
def list_parties(session: SessionDep, role: PartyRole | None = None, area: str | None = None):
    stmt = select(Party).order_by(Party.id)
    if role:
        stmt = stmt.where(Party.role == role)
    if area:
        stmt = stmt.where(Party.area == area)
    return session.scalars(stmt).all()


@router.get("/parties/by-chat/{chat_id}", response_model=PartyOut)
def party_by_chat(chat_id: str, session: SessionDep):
    party = session.scalar(select(Party).where(Party.chat_id == chat_id))
    if party is None:
        raise HTTPException(404, "this chat is not linked to any party")
    return party


@router.get("/parties/{party_id}", response_model=PartyOut)
def get_party(party_id: int, session: SessionDep):
    return party_or_404(session, party_id)


def _phone_key(phone: str) -> str:
    """Last 10 digits, so '+91 98450 12345' and '9845012345' match."""
    return "".join(c for c in phone if c.isdigit())[-10:]


@router.post("/parties/link-chat", response_model=PartyOut)
def link_chat(body: LinkChatIn, session: SessionDep):
    key = _phone_key(body.phone)
    candidates = session.scalars(select(Party).where(Party.phone.is_not(None)))
    party = next((p for p in candidates if _phone_key(p.phone) == key), None) if len(key) == 10 else None
    if party is None:
        raise HTTPException(404, "no registered party with this phone number")
    for other in session.scalars(select(Party).where(Party.chat_id == body.chat_id, Party.id != party.id)):
        other.chat_id = None
    party.chat_id = body.chat_id
    session.commit()
    return party


@router.get("/parties/{party_id}/service-areas", response_model=list[str])
def get_service_areas(party_id: int, session: SessionDep):
    party_or_404(session, party_id)
    return session.scalars(
        select(ServiceArea.area).where(ServiceArea.stockist_id == party_id).order_by(ServiceArea.area)
    ).all()


@router.post("/parties/{party_id}/service-areas", response_model=list[str])
def add_service_areas(party_id: int, body: ServiceAreasIn, session: SessionDep):
    party = party_or_404(session, party_id)
    if party.role != PartyRole.stockist:
        raise HTTPException(400, "only stockists have service areas")
    existing = set(get_service_areas(party_id, session))
    for area in set(body.areas) - existing:
        session.add(ServiceArea(stockist_id=party_id, area=area))
    session.commit()
    return get_service_areas(party_id, session)


@router.get("/parties/{party_id}/inventory", response_model=list[InventoryOut])
def get_inventory(party_id: int, session: SessionDep):
    party_or_404(session, party_id)
    return session.scalars(select(Inventory).where(Inventory.party_id == party_id).order_by(Inventory.sku)).all()


@router.put("/parties/{party_id}/inventory", response_model=InventoryOut)
def set_inventory(party_id: int, body: InventoryIn, session: SessionDep):
    party_or_404(session, party_id)
    if session.get(Product, body.sku) is None:
        raise HTTPException(404, f"product {body.sku} not found")
    inv = session.scalar(select(Inventory).where(Inventory.party_id == party_id, Inventory.sku == body.sku))
    if inv is None:
        inv = Inventory(party_id=party_id, sku=body.sku)
        session.add(inv)
    inv.on_hand, inv.reserved = body.on_hand, body.reserved
    session.commit()
    return inv


@router.get("/products", response_model=list[ProductIn])
def list_products(session: SessionDep):
    return session.scalars(select(Product).order_by(Product.sku)).all()


@router.post("/products", response_model=ProductIn, status_code=201)
def create_product(body: ProductIn, session: SessionDep):
    if session.get(Product, body.sku):
        raise HTTPException(409, f"product {body.sku} already exists")
    product = Product(**body.model_dump())
    session.add(product)
    session.commit()
    return product
