from __future__ import annotations

import pytest

from zero_media_relay.config import (
    ConfigurationError,
    ALLOWED_TLS_HOSTS,
    ALLOWED_TLS_SUFFIXES,
    RelaySettings,
)


def test_default_config_has_no_destination_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RELAY_ALLOWED_ORIGINS", "https://preview.example,https://client.example.org")
    monkeypatch.setenv("RELAY_ALLOWED_TARGETS", "evil.example")

    settings = RelaySettings.from_env()

    assert settings.allowed_origins == {
        "https://preview.example",
        "https://client.example.org",
    }
    assert settings.allowed_targets == ALLOWED_TLS_HOSTS
    assert settings.allowed_target_suffixes == ALLOWED_TLS_SUFFIXES


@pytest.mark.parametrize(
    "origin",
    ["*", "null", "http://client.example.org", "https://client.example.org/path", "data:text/plain,x"],
)
def test_unsafe_origins_fail_closed(monkeypatch: pytest.MonkeyPatch, origin: str) -> None:
    monkeypatch.setenv("RELAY_ALLOWED_ORIGINS", origin)
    with pytest.raises(ConfigurationError):
        RelaySettings.from_env()


@pytest.mark.parametrize("origin", ["http://localhost:4173", "http://127.0.0.1:8081"])
def test_explicit_loopback_http_origins_are_allowed_for_local_verification(
    monkeypatch: pytest.MonkeyPatch,
    origin: str,
) -> None:
    monkeypatch.setenv("RELAY_ALLOWED_ORIGINS", origin)
    assert RelaySettings.from_env().allowed_origins == {origin}


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost",
        "http://127.0.0.1",
        "http://0.0.0.0:4173",
        "http://localhost.evil.example:4173",
        "http://192.168.1.10:4173",
        "http://[::1]:4173",
        "http://client.example.org:80",
    ],
)
def test_other_http_origins_remain_forbidden(monkeypatch: pytest.MonkeyPatch, origin: str) -> None:
    monkeypatch.setenv("RELAY_ALLOWED_ORIGINS", origin)
    with pytest.raises(ConfigurationError):
        RelaySettings.from_env()


def test_byte_limit_cannot_be_smaller_than_a_frame() -> None:
    with pytest.raises(ConfigurationError):
        RelaySettings(max_frame_bytes=4096, max_bytes_each_direction=2048)


def test_invalid_release_sha_is_rejected() -> None:
    with pytest.raises(ConfigurationError):
        RelaySettings(release_sha="$(secret)")


@pytest.mark.parametrize("suffix", ["example.com", ".com", ".Example.com", ".example.com."])
def test_invalid_target_suffix_is_rejected(suffix: str) -> None:
    with pytest.raises(ConfigurationError):
        RelaySettings(allowed_target_suffixes=frozenset({suffix}))
