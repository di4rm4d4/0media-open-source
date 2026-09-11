"""Exercise peer disconnect and server cancellation independently of TestClient teardown."""
import asyncio

import pytest

from conftest import FakeWriter, ScriptedReader
from zero_media_relay.tunnel import relay_bidirectional


class FakeWebSocket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.started = asyncio.Event()
        self.closed = []

    async def receive(self):
        self.started.set()
        return await self.messages.get()

    async def send_bytes(self, _payload):
        pass

    async def close(self, code, reason):
        self.closed.append((code, reason))


def test_client_disconnect_closes_upstream_and_joins_workers(relay_settings):
    async def run():
        websocket, writer = FakeWebSocket(), FakeWriter()
        websocket.messages.put_nowait({"type": "websocket.disconnect"})
        result = await relay_bidirectional(websocket, ScriptedReader(), writer, relay_settings)
        assert writer.closed
        assert result.decision.code is None
        assert websocket.closed == []
        assert not [task for task in asyncio.all_tasks() if task.get_name().startswith("relay-")]
    asyncio.run(run())


def test_server_cancellation_closes_upstream_and_joins_workers(relay_settings):
    async def run():
        websocket, writer = FakeWebSocket(), FakeWriter()
        task = asyncio.create_task(relay_bidirectional(websocket, ScriptedReader(), writer, relay_settings))
        await websocket.started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert writer.closed
        assert websocket.closed == [(1012, "server shutting down")]
        assert not [worker for worker in asyncio.all_tasks() if worker.get_name().startswith("relay-")]
    asyncio.run(run())
