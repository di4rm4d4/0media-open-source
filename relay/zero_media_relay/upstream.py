"""DNS-pinned public TCP connection establishment."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import socket
import time
from typing import Protocol

from .targets import is_public_address


class Reader(Protocol):
    async def read(self, size: int = -1) -> bytes: ...


class Writer(Protocol):
    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...

    def close(self) -> None: ...

    async def wait_closed(self) -> None: ...


UpstreamConnection = tuple[Reader, Writer]
UpstreamConnector = Callable[[str, int, float], Awaitable[UpstreamConnection]]


class UpstreamUnavailable(ConnectionError):
    """Raised when the approved target cannot be reached safely."""


async def open_public_tcp(host: str, port: int, timeout_seconds: float) -> UpstreamConnection:
    """Resolve once, reject non-public answers, and connect to a pinned IP.

    The socket remains plain TCP. TLS records from the browser are never
    terminated or interpreted by this process.
    """

    if port != 443:
        raise UpstreamUnavailable("the relay only opens TCP port 443")

    loop = asyncio.get_running_loop()
    deadline = time.monotonic() + timeout_seconds
    try:
        infos = await asyncio.wait_for(
            loop.getaddrinfo(
                host,
                port,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
                proto=socket.IPPROTO_TCP,
            ),
            timeout=max(0.01, deadline - time.monotonic()),
        )
    except (TimeoutError, OSError) as exc:
        raise UpstreamUnavailable("upstream DNS resolution failed") from exc

    candidates: list[tuple[int, int, int, tuple[object, ...]]] = []
    seen: set[tuple[int, tuple[object, ...]]] = set()
    for family, socktype, proto, _canonname, sockaddr in infos:
        address = str(sockaddr[0])
        key = (family, sockaddr)
        if key in seen or not is_public_address(address):
            continue
        seen.add(key)
        candidates.append((family, socktype, proto, sockaddr))

    if not candidates:
        raise UpstreamUnavailable("upstream DNS returned no public address")

    last_error: BaseException | None = None
    for family, socktype, proto, sockaddr in candidates:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        sock = socket.socket(family=family, type=socktype, proto=proto)
        sock.setblocking(False)
        try:
            await asyncio.wait_for(loop.sock_connect(sock, sockaddr), timeout=remaining)
            return await asyncio.wait_for(
                asyncio.open_connection(sock=sock),
                timeout=max(0.01, deadline - time.monotonic()),
            )
        except (TimeoutError, OSError) as exc:
            last_error = exc
            sock.close()
        except BaseException:
            # Cancellation can interrupt connection establishment. Until
            # open_connection returns, this function still owns the socket.
            sock.close()
            raise

    raise UpstreamUnavailable("all public upstream addresses failed") from last_error
