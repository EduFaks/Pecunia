import time
import uuid


class SessionCache:
    """In-process session-liveness cache (spec D1). Bounds revocation lag to
    ttl_seconds without a per-request database read; same-process revocations
    call invalidate() for instant effect. Single-process by design."""

    def __init__(self, ttl_seconds: float = 30.0):
        self.ttl = ttl_seconds
        self._entries: dict[uuid.UUID, tuple[bool, float]] = {}

    def get(self, family_id: uuid.UUID) -> bool | None:
        entry = self._entries.get(family_id)
        if entry is None or time.monotonic() - entry[1] > self.ttl:
            return None
        return entry[0]

    def set(self, family_id: uuid.UUID, alive: bool) -> None:
        self._entries[family_id] = (alive, time.monotonic())

    def invalidate(self, family_id: uuid.UUID) -> None:
        self._entries.pop(family_id, None)

    def clear(self) -> None:
        self._entries.clear()
