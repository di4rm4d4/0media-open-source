from __future__ import annotations

import pytest

from zero_media_relay.config import ALLOWED_TLS_HOSTS, ALLOWED_TLS_SUFFIXES
from zero_media_relay.targets import TargetRejected, is_public_address, parse_wsproxy_authority


CUSTOM_HOSTS = frozenset({"www.example.com", "i.example.com", "static.cdn.example.net"})
CUSTOM_SUFFIXES = frozenset({".example.com", ".cdn.example.net", ".media.example.net"})


def test_default_policy_permits_only_the_public_example() -> None:
    assert ALLOWED_TLS_HOSTS == {"example.com"}
    assert ALLOWED_TLS_SUFFIXES == frozenset()
    assert parse_wsproxy_authority("example.com:443", ALLOWED_TLS_HOSTS).host == "example.com"
    with pytest.raises(TargetRejected):
        parse_wsproxy_authority("www.example.com:443", ALLOWED_TLS_HOSTS)


@pytest.mark.parametrize("authority", ["www.example.com:443", "i.example.com:443", "static.cdn.example.net:443"])
def test_exact_allowlisted_authority_is_accepted(authority: str) -> None:
    target = parse_wsproxy_authority(authority, CUSTOM_HOSTS, CUSTOM_SUFFIXES)
    assert authority == f"{target.host}:{target.port}"


@pytest.mark.parametrize(
    "authority",
    [
        "edge-chat.example.com:443",
        "scontent-lga3-2.cdn.example.net:443",
        "video.edge-1.media.example.net:443",
    ],
)
def test_explicitly_configured_subdomain_suffixes_are_accepted(authority: str) -> None:
    target = parse_wsproxy_authority(authority, CUSTOM_HOSTS, CUSTOM_SUFFIXES)
    assert authority == f"{target.host}:{target.port}"


@pytest.mark.parametrize(
    "authority",
    [
        "www.example.com:80",
        "www.example.com:0443",
        "WWW.Example.com:443",
        "www.example.com.:443",
        "evil.example:443",
        "www.example.com@evil.example:443",
        "www.example.com%252f.evil.example:443",
        "www.example.com/path:443",
        "127.0.0.1:443",
        "[::1]:443",
        "10.0.0.1:443",
        "www.example.com:443 ",
        "www.example.com",
        "evilexample.com:443",
        "cdn.example.net.evil.example:443",
        "media.example.net.evil.example:443",
    ],
)
def test_noncanonical_or_open_proxy_targets_are_rejected(authority: str) -> None:
    with pytest.raises(TargetRejected):
        parse_wsproxy_authority(authority, CUSTOM_HOSTS, CUSTOM_SUFFIXES)


@pytest.mark.parametrize("address", ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
def test_public_addresses_are_accepted(address: str) -> None:
    assert is_public_address(address)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "0.0.0.0",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "224.0.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "not-an-address",
    ],
)
def test_nonpublic_dns_answers_are_rejected(address: str) -> None:
    assert not is_public_address(address)
