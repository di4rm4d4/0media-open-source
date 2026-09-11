"""ASGI application for the 0media opaque relay."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket

from .config import RelaySettings
from .targets import TargetRejected, parse_wsproxy_authority
from .tunnel import relay_bidirectional
from .upstream import UpstreamConnector, UpstreamUnavailable, open_public_tcp


logger = logging.getLogger("zero_media_relay")


class ConnectionLimiter:
    """Small non-queueing global connection bound."""

    def __init__(self, maximum: int) -> None:
        self._maximum = maximum
        self._active = 0
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def slot(self):
        acquired = False
        async with self._lock:
            if self._active < self._maximum:
                self._active += 1
                acquired = True
        try:
            yield acquired
        finally:
            if acquired:
                async with self._lock:
                    self._active -= 1


def _single_header(websocket: WebSocket, name: bytes) -> str | None:
    values = [value for key, value in websocket.scope["headers"] if key.lower() == name]
    if len(values) != 1:
        return None
    try:
        return values[0].decode("ascii")
    except UnicodeDecodeError:
        return None


def _valid_origin(websocket: WebSocket, settings: RelaySettings) -> bool:
    origin = _single_header(websocket, b"origin")
    return origin is not None and origin in settings.allowed_origins


def _valid_host_header(websocket: WebSocket, settings: RelaySettings) -> bool:
    value = _single_header(websocket, b"host")
    if value is None or any(char.isspace() for char in value):
        return False
    if value.count(":") == 0:
        hostname = value
    elif value.count(":") == 1:
        hostname, port_text = value.rsplit(":", 1)
        if not port_text.isascii() or not port_text.isdigit() or not 1 <= int(port_text) <= 65535:
            return False
    else:
        return False
    return hostname in settings.allowed_http_hosts


async def _deny(websocket: WebSocket, code: int = 1008, reason: str = "request rejected") -> None:
    # Before accept(), an ASGI websocket.close becomes a denied HTTP upgrade.
    # The generic reason avoids turning validation into a target-discovery API.
    await websocket.close(code=code, reason=reason)


def create_app(
    settings: RelaySettings | None = None,
    connector: UpstreamConnector = open_public_tcp,
) -> Starlette:
    resolved_settings = settings or RelaySettings.from_env()
    limiter = ConnectionLimiter(resolved_settings.max_connections)

    async def healthz(_request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "service": "0media-relay",
                "release": resolved_settings.release_sha,
            },
            headers={"Cache-Control": "no-store"},
        )

    async def wsproxy(websocket: WebSocket) -> None:
        if websocket.scope.get("query_string"):
            await _deny(websocket)
            return
        if not _valid_origin(websocket, resolved_settings):
            await _deny(websocket)
            return
        if not _valid_host_header(websocket, resolved_settings):
            await _deny(websocket)
            return

        try:
            target = parse_wsproxy_authority(
                websocket.path_params["authority"],
                resolved_settings.allowed_targets,
                resolved_settings.allowed_target_suffixes,
            )
        except TargetRejected:
            await _deny(websocket)
            return

        async with limiter.slot() as acquired:
            if not acquired:
                await _deny(websocket, code=1013, reason="relay capacity reached")
                return

            await websocket.accept()
            try:
                reader, writer = await connector(
                    target.host,
                    target.port,
                    resolved_settings.connect_timeout_seconds,
                )
            except (UpstreamUnavailable, TimeoutError, OSError):
                await websocket.close(code=1013, reason="upstream unavailable")
                return
            except Exception as exc:
                # Do not serialize exception messages: a future connector must
                # not accidentally surface request-controlled data in logs.
                logger.error("unexpected upstream connector failure type=%s", type(exc).__name__)
                await websocket.close(code=1011, reason="upstream connection failed")
                return

            result = await relay_bidirectional(
                websocket,
                reader,
                writer,
                resolved_settings,
            )
            # Only bounded transport metadata is logged. Frame contents, HTTP
            # headers inside TLS, cookies, and TLS key material are never read.
            logger.info(
                "relay closed target=%s code=%s client_bytes=%d upstream_bytes=%d",
                target.host,
                result.decision.code,
                result.client_to_upstream_bytes,
                result.upstream_to_client_bytes,
            )

    application = Starlette(
        debug=False,
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            WebSocketRoute("/ws/{authority}", wsproxy),
        ],
    )
    application.state.relay_settings = resolved_settings
    return application


app = create_app()
