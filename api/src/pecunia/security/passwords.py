from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4)

# Verified against when a login email doesn't exist, so unknown emails pay the
# same argon2 cost as wrong passwords (no timing side-channel for enumeration).
DUMMY_HASH = _hasher.hash("pecunia-timing-equalizer")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False
