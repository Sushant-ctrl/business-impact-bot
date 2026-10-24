from datetime import date, datetime, timezone


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def today() -> date:
    return utcnow().date()
