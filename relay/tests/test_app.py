from __future__ import annotations

import logging

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import FakeWriter, RecordingConnector, ScriptedReader
from zero_media_relay.app import create_app
from zero_media_relay.upstream import UpstreamUnavailable


ORIGIN_HEADERS = {"origin": "https://client.example.org"}


def rejected_upgrade(client: TestClient, path: str, headers: dict[str, str] | None = None) -> int:
    with pytest.raises(WebSocketDisconnect) as caught:
        with client.websocket_connect(path, headers=headers or {}):
            pass
    return caught.value.code


def test_healthz_is_local_and_identifies_release(relay_settings) -> None:
    connector = RecordingConnector()
    with TestClient(create_app(relay_settings, connector)) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "0media-relay",
        "release": "a" * 40,
    }
    assert response.headers["cache-control"] == "no-store"
    assert connector.calls == []


def test_exact_libcurl_wsproxy_path_passes_binary_both_directions(
    relay_settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    writer = FakeWriter()
    upstream_bytes = b"opaque upstream TLS record"
    reader = ScriptedReader(
        [upstream_bytes],
        wait_for_first_write=writer,
        eof_after_chunks=True,
    )
    connector = RecordingConnector(reader, writer)
    app = create_app(relay_settings, connector)
    client_bytes = b"opaque client TLS record with secret marker"

    caplog.set_level(logging.INFO, logger="zero_media_relay")
    with TestClient(app) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            websocket.send_bytes(client_bytes)
            assert websocket.receive_bytes() == upstream_bytes
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1000

    assert connector.calls == [("www.example.com", 443, 0.5)]
    assert writer.writes == [client_bytes]
    assert writer.closed
    assert "secret marker" not in caplog.text


def test_url_encoded_colon_is_compatible_with_wsproxy(relay_settings) -> None:
    writer = FakeWriter()
    reader = ScriptedReader([b"server"], wait_for_first_write=writer, eof_after_chunks=True)
    connector = RecordingConnector(reader, writer)
    with TestClient(create_app(relay_settings, connector)) as client:
        with client.websocket_connect("/ws/i.example.com%3A443", headers=ORIGIN_HEADERS) as websocket:
            websocket.send_bytes(b"client")
            assert websocket.receive_bytes() == b"server"
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1000

    assert connector.calls[0][:2] == ("i.example.com", 443)


@pytest.mark.parametrize(
    "path",
    [
        "/ws/evil.example:443",
        "/ws/127.0.0.1:443",
        "/ws/www.example.com:80",
        "/ws/WWW.Example.com:443",
        "/ws/www.example.com:443?next=evil.example:443",
    ],
)
def test_bad_target_or_open_proxy_shape_is_rejected_before_connect(relay_settings, path: str) -> None:
    connector = RecordingConnector()
    with TestClient(create_app(relay_settings, connector)) as client:
        assert rejected_upgrade(client, path, ORIGIN_HEADERS) == 1008
    assert connector.calls == []


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"origin": "null"},
        {"origin": "https://evil.example"},
        {"origin": "https://client.example.org.evil.example"},
    ],
)
def test_missing_or_bad_origin_is_rejected_before_connect(relay_settings, headers) -> None:
    connector = RecordingConnector()
    with TestClient(create_app(relay_settings, connector)) as client:
        assert rejected_upgrade(client, "/ws/www.example.com:443", headers) == 1008
    assert connector.calls == []


def test_explicit_local_origin_can_open_a_tunnel(settings_factory) -> None:
    settings = settings_factory(allowed_origins=frozenset({"http://127.0.0.1:4173"}))
    writer = FakeWriter()
    connector = RecordingConnector(
        ScriptedReader([b"server"], wait_for_first_write=writer, eof_after_chunks=True),
        writer,
    )
    with TestClient(create_app(settings, connector)) as client:
        with client.websocket_connect(
            "/ws/www.example.com:443",
            headers={"origin": "http://127.0.0.1:4173"},
        ) as websocket:
            websocket.send_bytes(b"client")
            assert websocket.receive_bytes() == b"server"
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1000
    assert connector.calls[0][:2] == ("www.example.com", 443)


@pytest.mark.parametrize(
    "host",
    [
        "relay.example.org.evil.example",
        "testserver:bad",
        "testserver:",
        "testserver:0",
        "testserver:65536",
        "testserver:443:443",
    ],
)
def test_bad_host_header_is_rejected(relay_settings, host: str) -> None:
    connector = RecordingConnector()
    headers = {**ORIGIN_HEADERS, "host": host}
    with TestClient(create_app(relay_settings, connector)) as client:
        assert rejected_upgrade(client, "/ws/www.example.com:443", headers) == 1008
    assert connector.calls == []


def test_numeric_host_port_is_accepted(relay_settings) -> None:
    writer = FakeWriter()
    connector = RecordingConnector(
        ScriptedReader([b"server"], wait_for_first_write=writer, eof_after_chunks=True),
        writer,
    )
    with TestClient(create_app(relay_settings, connector)) as client:
        with client.websocket_connect(
            "/ws/www.example.com:443",
            headers={**ORIGIN_HEADERS, "host": "testserver:8443"},
        ) as websocket:
            websocket.send_bytes(b"client")
            assert websocket.receive_bytes() == b"server"
            # This is a Host-header acceptance test, not a TestClient teardown
            # race. Let the scripted upstream finish and observe the relay's
            # close before the context manager cancels its ASGI task.
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1000
            assert caught.value.reason == "upstream closed"
            assert writer.closed


def test_text_frames_are_closed_without_forwarding(relay_settings) -> None:
    connector = RecordingConnector()
    with TestClient(create_app(relay_settings, connector)) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            websocket.send_text("not TLS")
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1003

    assert connector.writer.writes == []
    assert connector.writer.closed


def test_oversized_frame_is_closed_without_forwarding(relay_settings) -> None:
    connector = RecordingConnector()
    with TestClient(create_app(relay_settings, connector)) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            websocket.send_bytes(b"x" * 1025)
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1009

    assert connector.writer.writes == []


def test_per_direction_byte_limit_is_enforced(settings_factory) -> None:
    settings = settings_factory(max_frame_bytes=1024, max_bytes_each_direction=1024)
    connector = RecordingConnector()
    with TestClient(create_app(settings, connector)) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            websocket.send_bytes(b"a" * 600)
            websocket.send_bytes(b"b" * 600)
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1009

    assert connector.writer.writes == [b"a" * 600]


def test_idle_timeout_closes_both_sides(settings_factory) -> None:
    settings = settings_factory(idle_timeout_seconds=0.03, max_connection_seconds=1)
    connector = RecordingConnector()
    with TestClient(create_app(settings, connector)) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1000
            assert caught.value.reason == "idle timeout"
    assert connector.writer.closed


def test_absolute_lifetime_cannot_be_extended_by_activity(settings_factory) -> None:
    settings = settings_factory(idle_timeout_seconds=1, max_connection_seconds=0.03)
    connector = RecordingConnector()
    with TestClient(create_app(settings, connector)) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            websocket.send_bytes(b"activity")
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1000
            assert caught.value.reason == "connection lifetime reached"
    assert connector.writer.closed


def test_upstream_failure_is_a_retryable_close(relay_settings) -> None:
    connector = RecordingConnector()
    connector.error = UpstreamUnavailable("expected test failure")
    with TestClient(create_app(relay_settings, connector)) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1013


def test_unexpected_connector_exception_message_is_not_logged(
    relay_settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    connector = RecordingConnector()
    connector.error = RuntimeError("request-controlled secret marker")
    caplog.set_level(logging.ERROR, logger="zero_media_relay")

    with TestClient(create_app(relay_settings, connector)) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1011

    assert "request-controlled secret marker" not in caplog.text
    assert "RuntimeError" in caplog.text


def test_global_connection_capacity_rejects_instead_of_queueing(settings_factory) -> None:
    settings = settings_factory(max_connections=1)
    writer = FakeWriter()
    connector = RecordingConnector(
        ScriptedReader([b"server"], wait_for_first_write=writer, eof_after_chunks=True), writer
    )
    with TestClient(create_app(settings, connector)) as client:
        with client.websocket_connect("/ws/www.example.com:443", headers=ORIGIN_HEADERS) as websocket:
            assert rejected_upgrade(client, "/ws/i.example.com:443", ORIGIN_HEADERS) == 1013
            websocket.send_bytes(b"client")
            assert websocket.receive_bytes() == b"server"
            with pytest.raises(WebSocketDisconnect) as caught:
                websocket.receive_bytes()
            assert caught.value.code == 1000
    assert len(connector.calls) == 1
