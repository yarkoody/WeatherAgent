"""Alert delivery: Discord webhooks (URL guard and POST) and email through Resend.

Discord: the server only ever posts to Discord webhook URLs: https, host exactly discord.com or
discordapp.com (no port, no user info, no IP literal), path /api/webhooks/<id>/<token>, no query or
fragment. Redirects are not followed and the timeout is 5 s. Webhook URLs are secrets (anyone holding
one can post to that channel), so they are never logged or echoed back.

Email: one provider, Resend, configured only by env vars (RESEND_API_KEY and ALERT_EMAIL_FROM). With
either unset, email alerts are off and no email is ever sent.
"""

from __future__ import annotations

import os
import re
from typing import Any
from urllib.parse import urlsplit

import httpx

DISCORD_HOSTS = frozenset({"discord.com", "discordapp.com"})
_PATH = re.compile(r"/api/webhooks/\d{1,25}/[A-Za-z0-9_-]{1,200}")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}")
MAX_URL_CHARS = 300
MAX_EMAIL_CHARS = 254
TIMEOUT_SECONDS = 5.0
USERNAME = "Hub Weather Risk"
CONTENT_MAX = 2000  # Discord's message limit
RESEND_URL = "https://api.resend.com/emails"
EMAIL_DISABLED = "Email alerts need an email provider configured on the server."


class SendError(Exception):
    """A delivery that failed. `status` is the HTTP status our API answers with; the message names no URL or key."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# ---------- Discord ----------


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


def message(content: str) -> dict[str, Any]:
    """A webhook body that can never ping anyone (@everyone, roles or users)."""
    return {"username": USERNAME, "content": truncate(content, CONTENT_MAX), "allowed_mentions": {"parse": []}}


def post_discord(url: str, content: str) -> None:
    """POST one message to a validated Discord webhook. Raises SendError."""
    validate_discord_webhook(url)
    try:
        res = httpx.post(url, json=message(content), timeout=TIMEOUT_SECONDS, follow_redirects=False)
    except httpx.TimeoutException as exc:
        raise SendError(504, "Discord did not answer within 5 seconds.") from exc
    except httpx.HTTPError as exc:
        raise SendError(502, "Could not reach Discord.") from exc
    if res.status_code in (401, 403, 404):
        raise SendError(404, "Discord does not know this webhook. It may have been deleted; copy a new one from the channel settings.")
    if res.status_code == 429:
        raise SendError(429, "Discord is rate-limiting this webhook. Wait a moment and try again.")
    if not 200 <= res.status_code < 300:  # 3xx included: redirects are never followed
        raise SendError(502, f"Discord answered {res.status_code}.")


# ---------- email (Resend) ----------


def email_configured() -> bool:
    return bool(os.environ.get("RESEND_API_KEY", "").strip() and os.environ.get("ALERT_EMAIL_FROM", "").strip())


def validate_email(address: str) -> str:
    """The address, trimmed and lower-cased (one subscription per mailbox), or ValueError."""
    if not isinstance(address, str):
        raise ValueError("Not an email address.")
    value = address.strip().lower()
    if len(value) > MAX_EMAIL_CHARS or not _EMAIL.fullmatch(value):
        raise ValueError("Not an email address.")
    return value


def send_email(to: str, subject: str, text: str) -> None:
    """Send one plain-text email through Resend. Raises SendError (503 when no provider is configured)."""
    if not email_configured():
        raise SendError(503, EMAIL_DISABLED)
    to = validate_email(to)
    body = {"from": os.environ["ALERT_EMAIL_FROM"].strip(), "to": [to], "subject": subject[:200], "text": text}
    headers = {"Authorization": f"Bearer {os.environ['RESEND_API_KEY'].strip()}"}
    try:
        res = httpx.post(RESEND_URL, json=body, headers=headers, timeout=TIMEOUT_SECONDS, follow_redirects=False)
    except httpx.TimeoutException as exc:
        raise SendError(504, "The email provider did not answer within 5 seconds.") from exc
    except httpx.HTTPError as exc:
        raise SendError(502, "Could not reach the email provider.") from exc
    if res.status_code == 429:
        raise SendError(429, "The email provider is rate-limiting this server. Try again later.")
    if res.status_code in (400, 422):
        raise SendError(422, "The email provider refused this address.")
    if not 200 <= res.status_code < 300:
        raise SendError(502, f"The email provider answered {res.status_code}.")
