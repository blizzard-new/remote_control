import argparse
import json
import os
from pathlib import Path
import secrets
import ssl

from aiohttp import web

from .app import create_app, is_loopback


def ice_configuration(raw):
    servers = json.loads(raw)
    if not isinstance(servers, list):
        raise ValueError("expected an array")
    for server in servers:
        if not isinstance(server, dict):
            raise ValueError("expected an RTCIceServer object")
        urls = server.get("urls")
        if isinstance(urls, str):
            urls = [urls]
        if not isinstance(urls, list) or not urls or not all(
            isinstance(url, str) and url.startswith(("stun:", "stuns:", "turn:", "turns:")) for url in urls
        ):
            raise ValueError("each server requires valid STUN or TURN URLs")
    return servers


def main(argv=None, *, on_ready=None):
    parser = argparse.ArgumentParser(description="Start a remote desktop session on this computer.")
    parser.add_argument("--bind", default="127.0.0.1", help="loopback address, or 0.0.0.0/:: for other devices")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--request-control", action="store_true",
                        help="request local Accessibility permission for macOS desktop input")
    parser.add_argument("--cert", type=Path, help="TLS certificate chain in PEM format")
    parser.add_argument("--key", type=Path, help="TLS private key in PEM format")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    private = is_loopback(args.bind) or args.bind == "localhost"
    if not private and args.bind not in {"0.0.0.0", "::"}:
        parser.error("use --bind 0.0.0.0 or :: to include the loopback host console")
    if bool(args.cert) != bool(args.key):
        parser.error("--cert and --key are required together")
    if not private and args.cert is None:
        parser.error("provide --cert and --key for non-loopback connections")
    context = None
    if args.cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        try:
            context.load_cert_chain(args.cert, args.key)
        except (ssl.SSLError, OSError) as exc:
            parser.error(str(exc))
    try:
        ice = ice_configuration(os.environ.get("REMOTE_ICE_SERVERS", "[]"))
    except ValueError as exc:
        parser.error(f"REMOTE_ICE_SERVERS: {exc}")
    from native.desktop import Desktop

    token = secrets.token_urlsafe(32)
    desktop = Desktop()
    if args.request_control:
        print(desktop.request_control(), flush=True)
    app = create_app(token, desktop, ice)
    domain = "localhost" if args.bind in {"0.0.0.0", "::", "localhost", "127.0.0.1", "::1"} else args.bind
    if ":" in domain:
        domain = f"[{domain}]"
    url = f"{'https' if context else 'http'}://{domain}:{args.port}/#host={token}"
    def announce(banner):
        print(f"Open on this computer (private host link):\n{url}", flush=True)
        print(banner, flush=True)
        if on_ready:
            on_ready(url)

    web.run_app(app, host=args.bind, port=args.port, ssl_context=context, access_log=None, print=announce)


if __name__ == "__main__":
    main()
