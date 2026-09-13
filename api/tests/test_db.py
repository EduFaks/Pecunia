import sqlalchemy as sa


async def test_database_connection(db):
    result = await db.execute(sa.text("SELECT 1"))
    assert result.scalar_one() == 1
