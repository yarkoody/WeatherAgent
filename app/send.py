"""Discord delivery: the webhook URL guard and one POST helper.

The server only ever posts to Discord webhook URLs: https, host exactly discord.com or
discordapp.com (no port, no user info, no IP literal), path /api/webhooks/<id>/<token>, no query
or fragment. Redirects are not followed and the timeout is 5 s. Webhook URLs are secrets (anyone
holding one can post to that channel), so they are never logged or echoed back.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

import httpx

DISCORD_HOSTS = frozenset({"discord.com", "discordapp.com"})
_PATH = re.compile(r"/api/webhooks/\d{1,25}/[A-Za-z0-9_-]{1,200}")
MAX_URL_CHARS = 300
TIMEOUT_SECONDS = 5.0
USERNAME = "Hub Weather Risk"
# Discord's limits for one embed.
TITLE_MAX, DESCRIPTION_MAX, FIELDS_MAX, FIELD_NAME_MAX, FIELD_VALUE_MAX, FOOTER_MAX = 256, 4096, 25, 256, 1024, 2048
CONTENT_MAX = 2000


class WebhookError(Exception):
    """A Discord post that failed. `status` is the HTTP status our API should answer with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def validate_discord_webhook(url: str) -> str:
    """Return the URL if it is a Discord webhook URL, else raise ValueError (the message names no part of it)."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_CHARS or url != url.strip() or any(c in url for c in "\\\t\r\n "):
        raise ValueError("Not a Discord webhook URL.")
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise ValueError("A Discord webhook URL starts with https://.")
    # The netloc must be the bare host: this rejects ports, user@host tricks and IP literals.
    if parts.netloc not in DISCORD_HOSTS:
        raise ValueError("A Discord webhook URL is on discord.com or discordapp.com.")
    if parts.query or parts.fragment or "#" in url or "?" in url or not _PATH.fullmatch(parts.path):
        raise ValueError("A Discord webhook URL looks like https://discord.com/api/webhooks/<id>/<token>.")
    return url


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def message(content: str = "", embed: dict[str, Any] | None = None) -> dict[str, Any]:
    """A webhook body that can never ping anyone (@everyone, roles or users)."""
    body: dict[str, Any] = {"username": USERNAME, "allowed_mentions": {"parse": []}}
    if content:
        body["content"] = truncate(content, CONTENT_MAX)
    if embed:
        body["embeds"] = [embed]
    return body


def post(url: str, body: dict[str, Any], *, client: httpx.Client | None = None) -> None:
    """POST one message to a validated Discord webhook. Raises WebhookError; the error never contains the URL."""
    validate_discord_webhook(url)
    try:
        if client is not None:
            res = client.post(url, json=body, timeout=TIMEOUT_SECONDS, follow_redirects=False)
        else:
            res = httpx.post(url, json=body, timeout=TIMEOUT_SECONDS, follow_redirects=False)
    except httpx.TimeoutException as exc:
        raise WebhookError(504, "Discord did not answer within 5 seconds.") from exc
    except httpx.HTTPError as exc:
        raise WebhookError(502, "Could not reach Discord.") from exc
    if res.status_code in (401, 403, 404):
        raise WebhookError(404, "Discord does not know this webhook. It may have been deleted; copy a new one from the channel settings.")
    if res.status_code == 429:
        raise WebhookError(429, "Discord is rate-limiting this webhook. Wait a moment and try again.")
    if res.status_code == 400:
        raise WebhookError(422, "Discord rejected the message.")
    if not 200 <= res.status_code < 300:  # 3xx included: redirects are never followed
        raise WebhookError(502, f"Discord answered {res.status_code}.")
