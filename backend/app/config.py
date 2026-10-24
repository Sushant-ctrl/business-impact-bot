from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./supply.db"
    telegram_bot_token: str = ""

    # Risk / alerting
    risk_alert_threshold: float = 0.6
    risk_medium_threshold: float = 0.35
    service_level: float = 0.95
    review_period_days: int = 7
    stats_lookback_days: int = 180

    # Peak periods (MM-DD ranges, inclusive) when delays are more likely
    peak_periods: list[tuple[str, str]] = [("10-15", "11-15"), ("12-20", "12-31")]

    scheduler_enabled: bool = True
    scheduler_interval_minutes: int = 60


@lru_cache
def get_settings() -> Settings:
    return Settings()
