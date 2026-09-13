from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PECUNIA_", extra="ignore")

    database_url: str = "postgresql+asyncpg://pecunia:pecunia@localhost:5432/pecunia"
    secret_key: str = ""
    config_dir: Path = Path("data/config")
    setup_token: str = ""
    trusted_proxies_raw: str = ""
    server_names_raw: str = ""
    # Gates the daily in-process crypto price sync (Track Q) — the app's
    # first outbound network call. On by default; set to false for a fully
    # offline / no-egress deployment. The on-demand refresh endpoint works
    # regardless of this flag.
    enable_price_sync: bool = True

    @property
    def trusted_proxies(self) -> list[str]:
        return [p.strip() for p in self.trusted_proxies_raw.split(",") if p.strip()]

    @property
    def server_names(self) -> list[str]:
        return [s.strip() for s in self.server_names_raw.split(",") if s.strip()]


def get_settings() -> Settings:
    return Settings()
