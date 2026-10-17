"""Pydantic models for request/response bodies.

These shapes are the public API contract with the frontend — field names
and defaults must not change.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Health(BaseModel):
    status: str = "ok"
    version: str = "0.1.0"


class Settings(BaseModel):
    endpoint: str = ""
    api_key: str = ""
    model: str = ""
    temperature: float = 0.7
    system_prompt: str = ""
    theme: Literal["system", "light", "dark"] = "system"
    stream: bool = True
    # Which saved provider is connected. Empty means "no provider yet", in
    # which case endpoint/api_key/model above are still authoritative.
    active_provider_id: str = ""


class ProviderBase(BaseModel):
    name: str = ""
    endpoint: str = ""
    api_key: str = ""
    model: str = ""


class ProviderCreate(ProviderBase):
    """POST /api/providers — a blank endpoint is allowed but not useful."""


class ProviderPatch(BaseModel):
    """PATCH-style update of one saved provider; absent fields are left alone."""

    name: str | None = None
    endpoint: str | None = None
    api_key: str | None = None
    model: str | None = None


class ProviderOut(ProviderBase):
    id: str
    created_at: str
    updated_at: str
    connected: bool = False


class TestConnectionRequest(BaseModel):
    endpoint: str
    api_key: str = ""


class SessionOut(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    model: str | None = None
    provider_id: str | None = None
    message_count: int | None = None


class SessionCreate(BaseModel):
    """POST /api/sessions accepts an empty body {}."""

    pass


class SessionPatch(BaseModel):
    title: str | None = None
    model: str | None = None


class MessageOut(BaseModel):
    id: str
    session_id: str
    role: Literal["user", "assistant"]
    content: str
    created_at: str
    status: Literal["complete", "error", "aborted"] = "complete"
    error: str | None = None
    model: str | None = None
    elapsed_ms: int | None = None


class ChatRequest(BaseModel):
    content: str
    stream: bool = True
    model: str | None = None


class ModelsOut(BaseModel):
    models: list[str] = Field(default_factory=list)


class ErrorOut(BaseModel):
    error: str


class DeleteAllOut(BaseModel):
    ok: bool = True
    deleted_sessions: int = 0
    deleted_messages: int = 0
