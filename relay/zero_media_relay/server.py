"""Bounded Uvicorn entry point; binds only loopback by default."""

from __future__ import annotations

import logging
import os

import uvicorn

from .app import create_app
from .config import ConfigurationError, RelaySettings


def _listen_port() -> int:
    raw = os.getenv("PORT", "8080")
    try:
        port = int(raw)
    except ValueError as exc:
        raise ConfigurationError("PORT must be an integer") from exc
    if not 1 <= port <= 65535:
        raise ConfigurationError("PORT is outside the valid TCP range")
    return port


def main() -> None:
    settings = RelaySettings.from_env()
    log_level = os.getenv("LOG_LEVEL", "info").upper()
    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format="%(levelname)s %(name)s %(message)s",
    )
    application = create_app(settings)
    uvicorn.run(
        application,
        host=os.getenv("RELAY_BIND_HOST", "127.0.0.1"),
        port=_listen_port(),
        access_log=False,
        server_header=False,
        proxy_headers=False,
        ws_max_size=settings.max_frame_bytes,
        ws_max_queue=4,
        ws_per_message_deflate=False,
        timeout_keep_alive=5,
        timeout_graceful_shutdown=10,
        log_level=log_level.lower(),
    )


if __name__ == "__main__":
    main()
