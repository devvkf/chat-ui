"""Shared helpers for talking to the OpenAI-compatible upstream server."""

from __future__ import annotations

from urllib.parse import urlsplit

import httpx


def host_of(endpoint: str) -> str:
    """Host (with port) of an endpoint URL — the default name for a provider."""
    try:
        netloc = urlsplit(endpoint.strip()).netloc
    except ValueError:
        return ""
    # Drop any userinfo prefix: user:pass@host -> host.
    return netloc.rsplit("@", 1)[-1]


def normalize_endpoint(endpoint: str) -> tuple[str | None, str | None]:
    """Strip whitespace/trailing slashes and validate the scheme.

    Returns (endpoint, None) on success or (None, error_message).
    """
    ep = endpoint.strip().rstrip("/")
    if not ep:
        return None, "Endpoint is empty. Set it to something like http://localhost:1234/v1"
    if not (ep.startswith("http://") or ep.startswith("https://")):
        return None, f"Endpoint must start with http:// or https:// (got: {endpoint!r})"
    return ep, None


def auth_headers(api_key: str) -> dict[str, str]:
    """Authorization header, only when a key is configured."""
    if api_key:
        return {"Authorization": f"Bearer {api_key}"}
    return {}


def extract_model_ids(payload: object) -> list[str]:
    """Pull model ids out of an OpenAI-style /models response.

    Accepts {"data": [{"id": ...}]}, a bare list, or {"models": [...]}.
    Returns sorted unique ids.
    """
    items: list[object]
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), list):
            items = payload["data"]
        elif isinstance(payload.get("models"), list):
            items = payload["models"]
        else:
            items = []
    elif isinstance(payload, list):
        items = payload
    else:
        items = []

    ids: set[str] = set()
    for item in items:
        if isinstance(item, dict):
            mid = item.get("id") or item.get("name")
            if isinstance(mid, str) and mid:
                ids.add(mid)
        elif isinstance(item, str) and item:
            ids.add(item)
    return sorted(ids)


async def fetch_models(endpoint: str, api_key: str) -> tuple[list[str] | None, str | None]:
    """GET {endpoint}/models. Returns (models, None) or (None, error)."""
    ep, err = normalize_endpoint(endpoint)
    if err:
        return None, err
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{ep}/models", headers=auth_headers(api_key))
    except httpx.HTTPError as exc:
        return None, f"Endpoint unreachable: {exc}"
    if resp.status_code >= 400:
        snippet = resp.text[:300]
        return None, f"Server returned HTTP {resp.status_code}: {snippet}"
    try:
        payload = resp.json()
    except ValueError:
        return None, "Server did not return valid JSON for /models"
    return extract_model_ids(payload), None
