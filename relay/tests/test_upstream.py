from __future__ import annotations

import asyncio
import socket

import pytest

from zero_media_relay.upstream import UpstreamUnavailable, open_public_tcp


class FakeLoop:
    def __init__(self, answers):
        self.answers = answers
        self.connected: list[tuple[object, ...]] = []

    async def getaddrinfo(self, *_args, **_kwargs):
        return self.answers

    async def sock_connect(self, _sock, sockaddr):
        self.connected.append(sockaddr)


def answer(address: str):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    sockaddr = (address, 443, 0, 0) if family == socket.AF_INET6 else (address, 443)
    return (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)


def test_connector_uses_only_the_resolved_public_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    loop = FakeLoop([answer("127.0.0.1"), answer("10.0.0.1"), answer("8.8.8.8")])
    reader = object()
    writer = object()

    async def fake_open_connection(*, sock):
        assert isinstance(sock, socket.socket)
        sock.close()
        return reader, writer

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: loop)
    monkeypatch.setattr(asyncio, "open_connection", fake_open_connection)

    assert asyncio.run(open_public_tcp("www.example.com", 443, 0.5)) == (reader, writer)
    assert loop.connected == [("8.8.8.8", 443)]


def test_connector_rejects_dns_with_no_public_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    loop = FakeLoop([answer("127.0.0.1"), answer("169.254.169.254"), answer("::1")])
    monkeypatch.setattr(asyncio, "get_running_loop", lambda: loop)

    with pytest.raises(UpstreamUnavailable, match="no public address"):
        asyncio.run(open_public_tcp("www.example.com", 443, 0.5))
    assert loop.connected == []


def test_connector_refuses_every_other_port() -> None:
    with pytest.raises(UpstreamUnavailable, match="only opens TCP port 443"):
        asyncio.run(open_public_tcp("www.example.com", 80, 0.5))


def test_connector_closes_untransferred_socket_on_cancellation(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = []

    class CancelLoop(FakeLoop):
        async def sock_connect(self, sock, sockaddr):
            captured.append(sock)
            raise asyncio.CancelledError()

    monkeypatch.setattr(asyncio, "get_running_loop", lambda: CancelLoop([answer("8.8.8.8")]))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(open_public_tcp("www.example.com", 443, 0.5))
    assert len(captured) == 1
    assert captured[0].fileno() == -1
