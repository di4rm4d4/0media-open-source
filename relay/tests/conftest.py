from __future__ import annotations

from collections import deque
import asyncio
from dataclasses import replace
from typing import Any

import pytest

from zero_media_relay.config import RelaySettings


class FakeWriter:
    def __init__(self) -> None:
        self.writes: list[bytes] = []
        self.closed = False
        self.first_write = asyncio.Event()

    def write(self, data: bytes) -> None:
        self.writes.append(bytes(data))
        self.first_write.set()

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


class ScriptedReader:
    def __init__(
        self,
        chunks: list[bytes] | None = None,
        *,
        wait_for_first_write: FakeWriter | None = None,
        eof_after_chunks: bool = False,
    ) -> None:
        self._chunks = deque(chunks or [])
        self._writer = wait_for_first_write
        self._eof_after_chunks = eof_after_chunks
        self._never: asyncio.Event | None = None

    async def read(self, _size: int = -1) -> bytes:
        if self._writer is not None:
            await self._writer.first_write.wait()
            self._writer = None
        if self._chunks:
            return self._chunks.popleft()
        if self._eof_after_chunks:
            return b""
        if self._never is None:
            self._never = asyncio.Event()
        await self._never.wait()
        return b""


class RecordingConnector:
    def __init__(self, reader: Any | None = None, writer: FakeWriter | None = None) -> None:
        self.writer = writer or FakeWriter()
        self.reader = reader or ScriptedReader()
        self.calls: list[tuple[str, int, float]] = []
        self.error: BaseException | None = None

    async def __call__(self, host: str, port: int, timeout: float):
        self.calls.append((host, port, timeout))
        if self.error is not None:
            raise self.error
        return self.reader, self.writer


@pytest.fixture
def relay_settings() -> RelaySettings:
    return RelaySettings(
        allowed_origins=frozenset({"https://client.example.org"}),
        allowed_http_hosts=frozenset({"testserver"}),
        allowed_targets=frozenset({"www.example.com", "i.example.com", "static.cdn.example.net"}),
        allowed_target_suffixes=frozenset({".example.com", ".cdn.example.net", ".media.example.net"}),
        connect_timeout_seconds=0.5,
        idle_timeout_seconds=1.0,
        max_connection_seconds=2.0,
        close_timeout_seconds=0.1,
        max_frame_bytes=1024,
        max_bytes_each_direction=4096,
        read_buffer_bytes=1024,
        max_connections=2,
        release_sha="a" * 40,
    )


@pytest.fixture
def settings_factory(relay_settings: RelaySettings):
    def factory(**changes: Any) -> RelaySettings:
        return replace(relay_settings, **changes)

    return factory
