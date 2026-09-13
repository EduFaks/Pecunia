import asyncio
from unittest.mock import AsyncMock

import pytest

import pecunia.main as main_module


async def test_sweep_loop_runs_first_sweep_shortly_after_boot_then_every_24h(monkeypatch):
    """An instance restarted more often than daily must still sweep: the first
    sweep should follow a short sleep, not the full 24h period."""
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        if len(sleeps) >= 2:
            raise asyncio.CancelledError()

    run_sweeps_mock = AsyncMock(return_value={"sessions": 0, "login_attempts": 0})
    monkeypatch.setattr(main_module.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(main_module, "run_sweeps", run_sweeps_mock)

    with pytest.raises(asyncio.CancelledError):
        await main_module._sweep_loop(sessionmaker=object())

    assert sleeps[0] == 60
    assert run_sweeps_mock.await_count == 1
    assert sleeps[1] == 24 * 60 * 60
