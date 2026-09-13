import hmac
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from pecunia.api.auth import (
    TokenResponse,
    build_token_response,
    check_origin,
    client_ip,
    set_refresh_cookie,
)
from pecunia.api.deps import get_instance_state, require_uninitialized
from pecunia.config import get_settings
from pecunia.db import get_db
from pecunia.models.instance import InstanceState
from pecunia.services.setup import SetupAlreadyCompleteError, initialize_instance

router = APIRouter(prefix="/setup", tags=["setup"])


class OwnerIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)


class PreferencesIn(BaseModel):
    base_currency: str = Field(pattern=r"^[A-Z]{3}$")
    locale: str = Field(min_length=2, max_length=35)
    date_format: str = Field(min_length=1, max_length=32)
    number_format: str = Field(min_length=1, max_length=32)
    timezone: str = Field(min_length=1, max_length=64)
    first_day_of_week: Literal["monday", "sunday", "saturday"]

    @field_validator("timezone")
    @classmethod
    def _known_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("unknown timezone") from exc
        return value


class InitializeRequest(BaseModel):
    owner: OwnerIn
    preferences: PreferencesIn
    client: Literal["web", "native"] = "web"


@router.get("/status")
async def setup_status(
    state: Annotated[InstanceState, Depends(get_instance_state)],
) -> dict[str, bool]:
    return {"initialized": state.initialized_at is not None}


@router.post("/initialize", status_code=201, dependencies=[Depends(require_uninitialized)])
async def initialize(
    body: InitializeRequest,
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TokenResponse:
    check_origin(request)
    expected = get_settings().setup_token
    if expected:
        provided = request.headers.get("x-setup-token", "")
        if not hmac.compare_digest(provided, expected):
            raise HTTPException(status_code=403, detail="INVALID_SETUP_TOKEN")
    try:
        user, session, refresh_token = await initialize_instance(
            db,
            owner_name=body.owner.name,
            owner_email=body.owner.email,
            owner_password=body.owner.password,
            preferences=body.preferences.model_dump(),
            client=body.client,
            ip=client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    except SetupAlreadyCompleteError:
        raise HTTPException(status_code=409, detail="SETUP_ALREADY_COMPLETE") from None
    await db.commit()
    if body.client == "web":
        set_refresh_cookie(response, request, refresh_token)
        return build_token_response(request, user, session.family_id, None)
    return build_token_response(request, user, session.family_id, refresh_token)
