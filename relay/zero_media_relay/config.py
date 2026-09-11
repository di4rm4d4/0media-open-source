"""Validated runtime configuration for the relay."""

from __future__ import annotations

from dataclasses import dataclass, field
import os
import re
from urllib.parse import urlsplit


from .policy import ALLOWED_TLS_HOSTS, ALLOWED_TLS_SUFFIXES


_HOST_RE = re.compile(
    r"^(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)


class ConfigurationError(ValueError):
    """Raised when an unsafe runtime setting is requested."""


def _csv(name: str, default: str) -> frozenset[str]:
    values = frozenset(item.strip() for item in os.getenv(name, default).split(",") if item.strip())
    if not values:
        raise ConfigurationError(f"{name} must contain at least one value")
    return values


def _integer(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


def _seconds(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.getenv(name, str(default))
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be numeric") from exc
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


def _validate_origin(origin: str) -> None:
    if origin in {"*", "null"}:
        raise ConfigurationError("wildcard and null origins are forbidden")
    parsed = urlsplit(origin)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ConfigurationError(f"invalid origin port: {origin!r}") from exc
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationError(f"invalid origin: {origin!r}")
    if parsed.scheme == "https":
        if not _HOST_RE.fullmatch(parsed.hostname) or parsed.hostname != parsed.hostname.lower():
            raise ConfigurationError(f"invalid HTTPS origin: {origin!r}")
        return
    if (
        parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1"}
        and port is not None
        and 1 <= port <= 65535
    ):
        return
    raise ConfigurationError("HTTP origins are limited to explicit localhost or 127.0.0.1 ports")


def _validate_hostname(host: str) -> None:
    if host != host.lower() or not _HOST_RE.fullmatch(host):
        raise ConfigurationError(f"invalid hostname: {host!r}")


@dataclass(frozen=True, slots=True)
class RelaySettings:
    allowed_origins: frozenset[str] = field(
        default_factory=lambda: frozenset({"http://127.0.0.1:4173", "http://localhost:4173"})
    )
    allowed_http_hosts: frozenset[str] = field(
        default_factory=lambda: frozenset({"127.0.0.1", "localhost"})
    )
    allowed_targets: frozenset[str] = field(default_factory=lambda: ALLOWED_TLS_HOSTS)
    allowed_target_suffixes: frozenset[str] = field(default_factory=lambda: ALLOWED_TLS_SUFFIXES)
    connect_timeout_seconds: float = 8.0
    idle_timeout_seconds: float = 60.0
    max_connection_seconds: float = 600.0
    close_timeout_seconds: float = 2.0
    max_frame_bytes: int = 64 * 1024
    max_bytes_each_direction: int = 32 * 1024 * 1024
    read_buffer_bytes: int = 64 * 1024
    max_connections: int = 128
    release_sha: str = "development"

    def __post_init__(self) -> None:
        if not self.allowed_origins:
            raise ConfigurationError("at least one browser origin is required")
        for origin in self.allowed_origins:
            _validate_origin(origin)
        if not self.allowed_http_hosts:
            raise ConfigurationError("at least one HTTP host is required")
        for host in self.allowed_http_hosts:
            _validate_hostname(host)
        if not self.allowed_targets:
            raise ConfigurationError("at least one relay target is required")
        for host in self.allowed_targets:
            _validate_hostname(host)
        for suffix in self.allowed_target_suffixes:
            if not suffix.startswith(".") or suffix.count(".") < 2:
                raise ConfigurationError(f"invalid target suffix: {suffix!r}")
            _validate_hostname(suffix[1:])
        if not 0.01 <= self.connect_timeout_seconds <= 60:
            raise ConfigurationError("connect timeout is outside the safe range")
        if not 0.01 <= self.idle_timeout_seconds <= 600:
            raise ConfigurationError("idle timeout is outside the safe range")
        if not 0.01 <= self.max_connection_seconds <= 3600:
            raise ConfigurationError("connection lifetime is outside the safe range")
        if not 0.01 <= self.close_timeout_seconds <= 10:
            raise ConfigurationError("close timeout is outside the safe range")
        if not 1024 <= self.max_frame_bytes <= 1024 * 1024:
            raise ConfigurationError("frame limit is outside the safe range")
        if not self.max_frame_bytes <= self.max_bytes_each_direction <= 1024 * 1024 * 1024:
            raise ConfigurationError("byte limit must be at least one frame and at most 1 GiB")
        if not 1024 <= self.read_buffer_bytes <= self.max_frame_bytes:
            raise ConfigurationError("read buffer must fit within one frame")
        if not 1 <= self.max_connections <= 4096:
            raise ConfigurationError("connection limit is outside the safe range")
        if len(self.release_sha) > 64 or any(ch not in "0123456789abcdefdevelopment-" for ch in self.release_sha):
            raise ConfigurationError("RELEASE_SHA contains unexpected characters")

    @classmethod
    def from_env(cls) -> "RelaySettings":
        origins = _csv("RELAY_ALLOWED_ORIGINS", "http://127.0.0.1:4173,http://localhost:4173")
        http_hosts = _csv("RELAY_ALLOWED_HTTP_HOSTS", "127.0.0.1,localhost")
        # Destination hosts intentionally have no environment override.
        return cls(
            allowed_origins=origins,
            allowed_http_hosts=http_hosts,
            connect_timeout_seconds=_seconds("RELAY_CONNECT_TIMEOUT_SECONDS", 8, 0.1, 60),
            idle_timeout_seconds=_seconds("RELAY_IDLE_TIMEOUT_SECONDS", 60, 1, 600),
            max_connection_seconds=_seconds("RELAY_MAX_CONNECTION_SECONDS", 600, 10, 3600),
            close_timeout_seconds=_seconds("RELAY_CLOSE_TIMEOUT_SECONDS", 2, 0.1, 10),
            max_frame_bytes=_integer("RELAY_MAX_FRAME_BYTES", 64 * 1024, 1024, 1024 * 1024),
            max_bytes_each_direction=_integer(
                "RELAY_MAX_BYTES_EACH_DIRECTION",
                32 * 1024 * 1024,
                1024,
                1024 * 1024 * 1024,
            ),
            read_buffer_bytes=_integer("RELAY_READ_BUFFER_BYTES", 64 * 1024, 1024, 1024 * 1024),
            max_connections=_integer("RELAY_MAX_CONNECTIONS", 128, 1, 4096),
            release_sha=os.getenv("RELEASE_SHA", "development").strip() or "development",
        )
