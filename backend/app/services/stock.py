"""Stock availability that accounts for orders a supplier has accepted but not yet shipped."""

from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Inventory, Order, OrderLine, OrderStatus

# Orders whose stock is still sitting in the supplier's warehouse.
UNSHIPPED_STATUSES = (OrderStatus.placed, OrderStatus.confirmed)


def backlog(session: Session, supplier_id: int) -> dict[str, int]:
    """Qty per SKU the supplier owes on accepted-but-unshipped orders."""
    rows = session.execute(
        select(OrderLine.sku, OrderLine.qty)
        .join(Order, Order.id == OrderLine.order_id)
        .where(Order.supplier_id == supplier_id, Order.status.in_(UNSHIPPED_STATUSES))
    ).all()
    owed: dict[str, int] = defaultdict(int)
    for sku, qty in rows:
        owed[sku] += qty
    return owed


def inventory_map(session: Session, party_id: int) -> dict[str, Inventory]:
    return {inv.sku: inv for inv in session.scalars(select(Inventory).where(Inventory.party_id == party_id))}


def free_stock(session: Session, supplier_id: int) -> dict[str, int]:
    """Stock the supplier could ship on a *new* order today."""
    owed = backlog(session, supplier_id)
    return {
        sku: max(0, inv.available - owed.get(sku, 0)) for sku, inv in inventory_map(session, supplier_id).items()
    }
