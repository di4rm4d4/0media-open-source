"""Parsing and validation for the libcurl.js wsproxy authority path."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import re


_HOST_RE = re.compile(
    r"^(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)


class TargetRejected(ValueError):
    """Raised when a requested upstream is not an approved target."""


@dataclass(frozen=True, slots=True)
class RelayTarget:
    host: str
    port: int = 443


def parse_wsproxy_authority(
    authority: str,
    allowed_hosts: frozenset[str],
    allowed_suffixes: frozenset[str] = frozenset(),
) -> RelayTarget:
    """Validate ``host:port`` after ASGI URL decoding.

    The caller receives an already percent-decoded route parameter. We do not
    decode it a second time, which prevents double-encoding bypasses.
    """

    if not authority or len(authority) > 260 or any(ch.isspace() for ch in authority):
        raise TargetRejected("invalid target authority")

    host, separator, port_text = authority.rpartition(":")
    if not separator or not host or port_text != "443":
        raise TargetRejected("only explicit TCP port 443 is allowed")
    if any(char in host for char in ("/", "\\", "@", "%", "?", "#")):
        raise TargetRejected("invalid target hostname")

    ip_candidate = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        ipaddress.ip_address(ip_candidate)
    except ValueError:
        pass
    else:
        raise TargetRejected("IP literals are forbidden")

    normalized = host.lower()
    if normalized != host or host.endswith(".") or not _HOST_RE.fullmatch(host):
        raise TargetRejected("target hostname must be canonical lowercase DNS")
    if host not in allowed_hosts and not any(host.endswith(suffix) for suffix in allowed_suffixes):
        raise TargetRejected("target hostname is not allowlisted")
    return RelayTarget(host=host)


def is_public_address(address: str) -> bool:
    """Return true only for globally routable IPv4 or IPv6 addresses."""

    try:
        parsed = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    return (
        parsed.is_global
        and not parsed.is_multicast
        and not parsed.is_reserved
        and not parsed.is_unspecified
        and not parsed.is_loopback
        and not parsed.is_link_local
        and not parsed.is_private
    )
