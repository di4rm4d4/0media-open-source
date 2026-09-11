"""Explicit destination policy. Edit and review this file for your application.

Keep this in sync with transport/policy.ts. Runtime environment variables and
browser input cannot expand this server-side allowlist.
"""

ALLOWED_TLS_HOSTS = frozenset({"example.com"})
ALLOWED_TLS_SUFFIXES: frozenset[str] = frozenset()
