"""Persistent, allowlisted node defaults. No shell commands or Docker access."""
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

DEFAULTS = {"maxOutbound": 16, "maxInbound": 125, "mempoolSize": 300, "logLevel": "info"}
LIMITS = {"maxOutbound": (1, 128), "maxInbound": (0, 1000), "mempoolSize": (1, 16384)}
FLAGS = {"maxOutbound": "--max-outbound", "maxInbound": "--max-inbound",
         "mempoolSize": "--mempool-size-mb", "logLevel": "--log-level"}


def validate(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULTS):
        raise ValueError("Provide all four supported node settings.")
    for key, (low, high) in LIMITS.items():
        if type(value[key]) is not int or not low <= value[key] <= high:
            raise ValueError(f"{key} must be a whole number from {low} to {high}.")
    if value["logLevel"] not in ("error", "warn", "info", "debug", "trace", "off"):
        raise ValueError("Choose a supported log level.")
    return dict(value)


def read_json(path, fallback):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".settings-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class Settings:
    def __init__(self, directory):
        self.directory = Path(directory)

    def saved(self):
        return validate(read_json(self.directory / "settings.json", DEFAULTS))

    def snapshot(self):
        saved = self.saved()
        launched = read_json(self.directory / "launched.json", None)
        applied = launched["settings"] if launched else None
        return {"saved": saved, "defaults": DEFAULTS, "revision": revision(saved),
                "lastLaunched": applied, "launchedAt": launched["at"] if launched else None,
                "restartRequired": applied != saved}

    def save(self, value, expected_revision):
        value = validate(value)
        if expected_revision != revision(self.saved()):
            raise FileExistsError("Settings changed in another window. Reload settings before saving.")
        atomic_write(self.directory / "settings.json", value)
        return self.snapshot()

    def launch_args(self, args):
        saved = self.saved()
        # Explicit operator CLI flags win, just as they do over upstream conf.
        applied = dict(saved)
        for key, flag in FLAGS.items():
            for i, arg in enumerate(args):
                if arg == flag:
                    if i + 1 >= len(args):
                        raise ValueError(f"{flag} needs a value.")
                    applied[key] = args[i + 1]
                elif arg.startswith(flag + "="):
                    applied[key] = arg.split("=", 1)[1]
            if key in LIMITS:
                applied[key] = int(applied[key])
        # Last-launched is deliberately not a claim that the node is healthy.
        atomic_write(self.directory / "launched.json", {"settings": applied, "at": int(time.time())})
        generated = [item for key, flag in FLAGS.items() for item in (flag, str(saved[key]))]
        return generated + list(args)


def host_gateways(route_file=Path("/proc/net/route")):
    """Umbrel 2's native app gateway connects from the Docker bridge host."""
    addresses = set()
    try:
        lines = route_file.read_text().splitlines()[1:]
    except OSError:
        return addresses
    for line in lines:
        fields = line.split()
        try:
            if (len(fields) >= 8 and fields[1] == "00000000" and fields[7] == "00000000"
                    and int(fields[3], 16) & 3 == 3 and len(fields[2]) == 8):
                address = socket.inet_ntoa(bytes.fromhex(fields[2])[::-1])
                if address != "0.0.0.0":
                    addresses.add(address)
        except (ValueError, OSError):
            continue
    return addresses


class SourceGuard:
    """Trust the TCP peer and nginx's overwritten source header, not user headers."""
    def __init__(self, web_host, proxy_hosts, resolve=None, host_sources=lambda: set()):
        self.web_host = web_host
        self.proxy_hosts = proxy_hosts
        self.resolve = resolve or (lambda host: {row[4][0] for row in socket.getaddrinfo(host, None, socket.AF_INET)})
        self.host_sources = host_sources
        self.expires = 0
        self.web = set()
        self.proxies = set()

    def allows(self, peer, forwarded):
        if time.monotonic() >= self.expires:
            def addresses(host):
                try:
                    return self.resolve(host)
                except OSError:
                    return set()
            self.web = addresses(self.web_host)
            self.proxies = self.host_sources().union(*(addresses(host) for host in self.proxy_hosts))
            self.expires = time.monotonic() + 5
        # Require the web peer and a known container proxy or native host gateway.
        return peer in self.web and forwarded in self.proxies


def handler_for(settings, source_guard=None):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def respond(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if source_guard and not source_guard.allows(self.client_address[0], self.headers.get("X-Dashboard-Client")):
                return self.respond(403, {"error": "Open this dashboard through Umbrel."})
            if self.path != "/settings":
                return self.respond(404, {"error": "Not found"})
            try:
                self.respond(200, settings.snapshot())
            except (OSError, ValueError, KeyError, TypeError):
                self.respond(500, {"error": "Cannot read saved settings. Check the settings service logs and settings.json."})

        def do_PUT(self):
            if source_guard and not source_guard.allows(self.client_address[0], self.headers.get("X-Dashboard-Client")):
                return self.respond(403, {"error": "Open this dashboard through Umbrel."})
            if self.path != "/settings":
                return self.respond(404, {"error": "Not found"})
            try:
                origin = urlsplit(self.headers.get("Origin", ""))
            except ValueError:
                return self.respond(403, {"error": "Invalid request origin."})
            # Browser writes must come through this same-origin dashboard.
            # No CORS support, and a custom header prevents form-based CSRF.
            if (origin.scheme not in ("http", "https") or origin.netloc != self.headers.get("Host")
                    or self.headers.get("X-Requested-With") != "rbitcoin-dashboard"
                    or self.headers.get("Sec-Fetch-Site", "same-origin") != "same-origin"):
                return self.respond(403, {"error": "Save settings from the app dashboard."})
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                return self.respond(415, {"error": "JSON is required."})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096:
                    return self.respond(413, {"error": "Settings request is too large or empty."})
                value = json.loads(self.rfile.read(length))
                if not isinstance(value, dict) or set(value) != {"settings", "revision"}:
                    raise ValueError("Provide settings and their revision.")
                self.respond(200, settings.save(value["settings"], value["revision"]))
            except FileExistsError as error:
                self.respond(409, {"error": str(error)})
            except (ValueError, TypeError) as error:
                self.respond(400, {"error": str(error)})
            except OSError:
                self.respond(500, {"error": "Settings could not be saved. Check storage permissions and free space."})
    return Handler


if __name__ == "__main__":
    settings = Settings(os.environ.get("SETTINGS_DIR", "/settings"))
    if sys.argv[1:2] == ["serve"]:
        # One writer serializes revision checks and atomic saves.
        proxy_hosts = os.environ.get("APP_PROXY_HOSTS", "app_proxy_beignet-rbitcoin,beignet-rbitcoin_app_proxy_1,beignet-rbitcoin-app_proxy-1").split(",")
        guard = SourceGuard(os.environ.get("WEB_HOST", "beignet-rbitcoin_web_1"), proxy_hosts,
                            host_sources=host_gateways)
        HTTPServer(("0.0.0.0", 9333), handler_for(settings, guard)).serve_forever()
    else:
        args = settings.launch_args(sys.argv[1:])
        os.execvp("rbitcoin-node", ["rbitcoin-node", *args])
