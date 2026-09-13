from asgi_lifespan import LifespanManager

import pecunia.db as db_module
from pecunia.main import create_app


async def test_lifespan_resolves_secret_and_initializes_engine(tmp_path, monkeypatch, pg_url):
    monkeypatch.setenv("PECUNIA_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("PECUNIA_SECRET_KEY", "")
    app = create_app()
    async with LifespanManager(app):
        assert len(app.state.secret_key) == 64
        assert (tmp_path / "secret_key").exists()
        assert db_module._engine is not None
