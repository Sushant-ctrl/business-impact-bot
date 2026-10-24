import enum

from sqlalchemy import Enum, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class PartyRole(str, enum.Enum):
    distributor = "distributor"
    stockist = "stockist"
    sub_stockist = "sub_stockist"
    retailer = "retailer"


class Party(Base):
    __tablename__ = "parties"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[PartyRole] = mapped_column(Enum(PartyRole, native_enum=False, length=20))
    region: Mapped[str | None] = mapped_column(String(80))
    phone: Mapped[str | None] = mapped_column(String(40))
    chat_id: Mapped[str | None] = mapped_column(String(64), index=True)


class Product(Base):
    __tablename__ = "products"

    sku: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    unit: Mapped[str] = mapped_column(String(20), default="unit")


class SupplyLink(Base):
    """Who can buy which SKU from whom. Every link beyond the primary one is an alternate source."""

    __tablename__ = "supply_links"
    __table_args__ = (UniqueConstraint("buyer_id", "supplier_id", "product_sku"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    buyer_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    product_sku: Mapped[str] = mapped_column(ForeignKey("products.sku"))
    nominal_lead_days: Mapped[int] = mapped_column(Integer)
    price: Mapped[float] = mapped_column(Float)

    supplier: Mapped[Party] = relationship(foreign_keys=[supplier_id])


class Inventory(Base):
    __tablename__ = "inventory"
    __table_args__ = (UniqueConstraint("party_id", "sku"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    party_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    sku: Mapped[str] = mapped_column(ForeignKey("products.sku"))
    on_hand: Mapped[int] = mapped_column(Integer, default=0)
    reserved: Mapped[int] = mapped_column(Integer, default=0)

    @property
    def available(self) -> int:
        return max(0, self.on_hand - self.reserved)
