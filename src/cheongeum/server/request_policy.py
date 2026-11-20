"""루프백 API의 호스트, 출처, 본문 계약."""

from __future__ import annotations

import re

from starlette.requests import Request

_HOST = re.compile(r"(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?", re.ASCII | re.IGNORECASE)
_AUDIO_TYPES = {"application/octet-stream", "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg",
                "audio/wav", "audio/x-wav", "audio/flac", "audio/aac", "audio/x-m4a"}
_AUDIO_ROUTES = {"/api/audio/turn", "/api/audio/stop", "/api/audio/transcribe", "/api/audio/recording"}
_EMPTY_POST = re.compile(r"/api/session/[^/]+/(cancel|detach|resume)")
JSON_LIMIT = 16 * 1024
AUDIO_LIMIT = 10 * 1024 * 1024
TURN_TEXT_LIMIT = 500


def origin_refusal(headers, scheme: str, port: int | None, *, required: bool = False) -> tuple[int, str] | None:
    hosts = headers.getlist("host")
    host = _HOST.fullmatch(hosts[0]) if len(hosts) == 1 else None
    if host is None:
        return 400, "INVALID_HOST"
    host_port = int(host[2] or ("443" if scheme == "https" else "80"))
    if not 0 < host_port < 65536 or (port is not None and host_port != port):
        return 400, "INVALID_HOST"
    origins = headers.getlist("origin")
    expected = f"{scheme}://{hosts[0]}".lower()
    if (required and not origins) or (origins and (len(origins) != 1 or origins[0].lower() != expected)) or headers.get("sec-fetch-site") in (
        "cross-site", "same-site",
    ):
        return 403, "INVALID_ORIGIN"
    return None


def request_refusal(request: Request, port: int | None) -> tuple[int, str] | None:
    if denied := origin_refusal(request.headers, request.scope["scheme"], port):
        return denied
    if request.method not in ("POST", "DELETE"):
        return None

    path = request.scope["path"]
    audio = path in _AUDIO_ROUTES
    empty = request.method == "DELETE" or bool(_EMPTY_POST.fullmatch(path))
    content_types = request.headers.getlist("content-type")
    media_type = content_types[0].split(";", 1)[0].strip().lower() if len(content_types) == 1 else ""
    expected_types = _AUDIO_TYPES if audio else {"application/json"}
    if path in ("/api/audio/turn", "/api/audio/stop"):
        expected_types = _AUDIO_TYPES | {"application/json"}
    allow_empty_type = empty or path == "/api/session"
    if len(content_types) > 1 or (media_type not in expected_types and (content_types or not allow_empty_type)):
        return 415, "UNSUPPORTED_MEDIA_TYPE"
    length = request.headers.get("content-length")
    if length is not None and (not length.isascii() or not length.isdecimal() or len(length) > 12):
        return 400, "INVALID_LENGTH"
    if int(length or 0) > (0 if empty else AUDIO_LIMIT if media_type in _AUDIO_TYPES else JSON_LIMIT):
        return 413, "BODY_TOO_LARGE"
    return None


async def bounded_body(request: Request, limit: int) -> bytes | None:
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            return None
        data.extend(chunk)
    return bytes(data)
