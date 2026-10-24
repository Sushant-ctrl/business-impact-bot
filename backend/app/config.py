from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./supply.db"
    telegram_bot_token: str = ""

    # Lane history: how long deliveries from a stockist to a pincode normally take
    lane_lookback_days: int = 180
    lane_min_samples: int = 3
    default_lane_days: int = 2

    # Extra days assumed for a disruption when neither the reporter nor history can tell us
    default_cause_delay_days: dict[str, int] = {
        "weather": 2,
        "road_closure": 2,
        "landslide": 4,
        "flood": 4,
        "strike": 2,
        "vehicle_breakdown": 1,
        "other": 2,
    }

    max_alternatives: int = 5


@lru_cache
def get_settings() -> Settings:
    return Settings()
