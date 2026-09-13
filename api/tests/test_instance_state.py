import pytest
import sqlalchemy as sa

from pecunia.models.instance import InstanceState


async def test_singleton_row_seeded_uninitialized(db):
    state = await db.get(InstanceState, 1)
    assert state is not None
    assert state.initialized_at is None
    assert state.owner_user_id is None
    assert state.instance_id is not None


async def test_second_row_rejected_by_check_constraint(db):
    with pytest.raises(sa.exc.IntegrityError):
        await db.execute(
            sa.text("INSERT INTO instance_state (id, instance_id) VALUES (2, gen_random_uuid())")
        )
    await db.rollback()
