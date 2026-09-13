#!/bin/sh
set -e

echo "pecunia: starting"
python -m pecunia.wait_for_db
echo "pecunia: running migrations"
alembic upgrade head
echo "pecunia: launching api"
exec uvicorn pecunia.main:app --host 0.0.0.0 --port 8000
