import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_session
from app.main import app
from app.notifications import NullChannel, get_channel
from tests.factories import Factory


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as s:
        yield s


@pytest.fixture
def channel():
    return NullChannel()


@pytest.fixture
def f(session):
    return Factory(session)


@pytest.fixture
def client(session, channel):
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_channel] = lambda: channel
    yield TestClient(app)
    app.dependency_overrides.clear()
