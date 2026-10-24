import enum

from sqlalchemy import Boolean, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class PartyRole(str, enum.Enum):
    distributor = "distributor"
    stockist = "stockist"
    retailer = "retailer"


class Party(Base):
    __tablename__ = "parties"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[PartyRole] = mapped_column(Enum(PartyRole, native_enum=False, length=20), index=True)
    area: Mapped[str] = mapped_column(String(20), index=True)  # pincode
    phone: Mapped[str | None] = mapped_column(String(40), unique=True)
    chat_id: Mapped[str | None] = mapped_column(String(64), index=True)
    trusted: Mapped[bool] = mapped_column(Boolean, default=True)


class ServiceArea(Base):
    """A pincode a stockist delivers to."""

    __tablename__ = "service_areas"
    __table_args__ = (UniqueConstraint("stockist_id", "area"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    stockist_id: Mapped[int] = mapped_column(ForeignKey("parties.id"), index=True)
    area: Mapped[str] = mapped_column(String(20), index=True)


class Product(Base):
    __tablename__ = "products"

    sku: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    unit: Mapped[str] = mapped_column(String(20), default="unit")


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
