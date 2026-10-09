"""Outbound HTTP helpers.

urllib's global urlopen() honors HTTP(S)_PROXY environment variables and the
OS proxy configuration. On a host whose proxy lacks a localhost bypass, calls
to OmniRoute would route through it — handing the upstream bearer token to
the proxy. All local/trusted calls go through urlopen() here, which never
consults proxy settings. External connectivity checks (the diagnose probes)
intentionally keep the default opener: a host behind a corporate egress
proxy *needs* it, and their requests are HTTPS where the auth header rides
inside TLS anyway.
"""

import urllib.request

# One shared opener: OpenerDirector is stateless between open() calls for
# these handlers, so a module-level instance is safe to share.
_DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def urlopen(req, timeout=None):
    """urlopen() that bypasses all system proxy configuration."""
    if timeout is None:
        return _DIRECT.open(req)
    return _DIRECT.open(req, timeout=timeout)
