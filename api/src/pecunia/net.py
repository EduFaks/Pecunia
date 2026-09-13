import ipaddress


def client_ip_from_scope(
    client_host: str | None, forwarded_for: str | None, trusted_proxies: list[str]
) -> str | None:
    """Resolve the caller's IP for audit/display only (never a security signal).
    Honor X-Forwarded-For solely when the immediate peer is a configured trusted
    proxy; otherwise the socket peer is authoritative. The leftmost token is
    client-supplied and unvalidated by the proxy, so it must parse as a real IP
    before we trust it — a garbage value (e.g. "unknown") would otherwise flow
    straight into an INET column and blow up the write."""
    if client_host in trusted_proxies and forwarded_for:
        first = forwarded_for.split(",")[0].strip()
        if first:
            try:
                ipaddress.ip_address(first)
            except ValueError:
                return client_host
            return first
    return client_host
