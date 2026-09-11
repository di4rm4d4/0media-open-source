"""Bounded binary passthrough between one WebSocket and one TCP socket."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
import time

from starlette.websockets import WebSocket

from .config import RelaySettings
from .upstream import Reader, Writer


@dataclass(frozen=True, slots=True)
class CloseDecision:
    code: int | None
    reason: str


@dataclass(frozen=True, slots=True)
class RelayResult:
    decision: CloseDecision
    client_to_upstream_bytes: int
    upstream_to_client_bytes: int


@dataclass(slots=True)
class _Activity:
    started_at: float
    last_activity_at: float
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    client_to_upstream_bytes: int = 0
    upstream_to_client_bytes: int = 0

    def touch(self) -> None:
        self.last_activity_at = time.monotonic()
        self.changed.set()


async def _client_to_upstream(
    websocket: WebSocket,
    writer: Writer,
    state: _Activity,
    settings: RelaySettings,
) -> CloseDecision:
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return CloseDecision(None, "client disconnected")
            if message["type"] != "websocket.receive":
                return CloseDecision(1002, "unexpected WebSocket event")
            if message.get("text") is not None:
                return CloseDecision(1003, "binary frames only")
            payload = message.get("bytes")
            if payload is None:
                return CloseDecision(1003, "binary frames only")
            if len(payload) > settings.max_frame_bytes:
                return CloseDecision(1009, "frame limit exceeded")
            if not payload:
                continue
            projected = state.client_to_upstream_bytes + len(payload)
            if projected > settings.max_bytes_each_direction:
                return CloseDecision(1009, "client byte limit exceeded")
            writer.write(payload)
            await writer.drain()
            state.client_to_upstream_bytes = projected
            state.touch()
    except asyncio.CancelledError:
        raise
    except Exception:
        return CloseDecision(1011, "upstream write failed")


async def _upstream_to_client(
    websocket: WebSocket,
    reader: Reader,
    state: _Activity,
    settings: RelaySettings,
) -> CloseDecision:
    try:
        while True:
            payload = await reader.read(settings.read_buffer_bytes)
            if not payload:
                return CloseDecision(1000, "upstream closed")
            projected = state.upstream_to_client_bytes + len(payload)
            if projected > settings.max_bytes_each_direction:
                return CloseDecision(1009, "upstream byte limit exceeded")
            await websocket.send_bytes(payload)
            state.upstream_to_client_bytes = projected
            state.touch()
    except asyncio.CancelledError:
        raise
    except Exception:
        return CloseDecision(1011, "upstream read failed")


async def _watch_limits(state: _Activity, settings: RelaySettings) -> CloseDecision:
    while True:
        now = time.monotonic()
        lifetime_deadline = state.started_at + settings.max_connection_seconds
        idle_deadline = state.last_activity_at + settings.idle_timeout_seconds
        deadline = min(lifetime_deadline, idle_deadline)
        remaining = deadline - now
        if remaining <= 0:
            if lifetime_deadline <= idle_deadline:
                return CloseDecision(1000, "connection lifetime reached")
            return CloseDecision(1000, "idle timeout")

        state.changed.clear()
        try:
            await asyncio.wait_for(state.changed.wait(), timeout=remaining)
        except TimeoutError:
            continue


async def _close_writer(writer: Writer, timeout_seconds: float) -> None:
    with suppress(Exception):
        writer.close()
    with suppress(Exception, asyncio.CancelledError):
        await asyncio.wait_for(writer.wait_closed(), timeout=timeout_seconds)


async def _close_websocket(websocket: WebSocket, decision: CloseDecision) -> None:
    if decision.code is None:
        return
    with suppress(Exception, RuntimeError):
        await websocket.close(code=decision.code, reason=decision.reason)


def _choose_decision(decisions: list[CloseDecision]) -> CloseDecision:
    # If two directions finish in the same event-loop turn, report the most
    # actionable protocol/error close instead of hiding it behind normal EOF.
    return max(decisions, key=lambda decision: decision.code or 0)


async def relay_bidirectional(
    websocket: WebSocket,
    reader: Reader,
    writer: Writer,
    settings: RelaySettings,
) -> RelayResult:
    """Relay opaque bytes until either peer closes or a bound is reached."""

    now = time.monotonic()
    state = _Activity(started_at=now, last_activity_at=now)
    tasks = {
        asyncio.create_task(
            _client_to_upstream(websocket, writer, state, settings),
            name="relay-client-to-upstream",
        ),
        asyncio.create_task(
            _upstream_to_client(websocket, reader, state, settings),
            name="relay-upstream-to-client",
        ),
        asyncio.create_task(_watch_limits(state, settings), name="relay-limit-watchdog"),
    }
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await _close_writer(writer, settings.close_timeout_seconds)
        await _close_websocket(websocket, CloseDecision(1012, "server shutting down"))
        raise
    decisions: list[CloseDecision] = []
    for task in done:
        try:
            decisions.append(task.result())
        except Exception:
            decisions.append(CloseDecision(1011, "relay task failed"))

    decision = _choose_decision(decisions)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    await _close_writer(writer, settings.close_timeout_seconds)
    await _close_websocket(websocket, decision)
    return RelayResult(
        decision=decision,
        client_to_upstream_bytes=state.client_to_upstream_bytes,
        upstream_to_client_bytes=state.upstream_to_client_bytes,
    )
