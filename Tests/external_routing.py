#!/usr/bin/env python3
"""First-request routing sessions in a disposable hidden world.

Run ./build.sh debug, then python3 Tests/external_routing.py from a worktree.
Uses the existing bench and split_view harness; no installed app or real
browser settings are changed. Only a local HTTP server receives requests.
"""
import json
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import split_view as sv

sv.use("external-routing")
seen = {}
lock = threading.Lock()


class Site(BaseHTTPRequestHandler):
    def do_GET(self):
        with lock:
            seen.setdefault(self.path, []).append(self.headers.get("Cookie", ""))
        data = b"<!doctype html><title>routing fixture</title>"
        self.send_response(200)
        if self.path.startswith("/seed/"):
            self.send_header("Set-Cookie", f"who={self.path.rsplit('/', 1)[1]}; Path=/; Max-Age=3600")
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def wait_for(path, timeout=10):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        with lock:
            if path in seen:
                return list(seen[path])
        time.sleep(0.05)
    return []


def defaults(key, kind, value):
    subprocess.run(["defaults", "write", sv.SUITE, key, kind, value], check=True)


def windows():
    return sv.cmd({"do": "windows"})


def hidden(t, label):
    state = windows()
    shown = [w for w in state["windows"] if w["shown"]]
    t.ok(f"all windows hidden ({label})", not shown, shown)
    if shown:
        raise RuntimeError("a probe window became visible")
    return state


def main():
    t = sv.T()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_port
    local = f"http://127.0.0.1:{port}"
    localhost = f"http://localhost:{port}"
    work, research, other, other_home = [str(uuid.uuid4()).upper() for _ in range(4)]

    def rule(host, destination, profile=sv.PERSONAL):
        return {"id": str(uuid.uuid4()), "domain": host, "port": port,
                "profileID": profile, "spaceID": destination, "spaceName": "Fixture"}

    rules = [rule("127.0.0.1", work), rule("localhost", research)]

    def seed(base, who, index=None, window=1):
        if index:
            sv.cmd({"do": "space", "action": "go", "index": index, "window": window})
        sv.cmd({"do": "split", "action": "open", "url": f"{base}/seed/{who}", "window": window})
        if not wait_for(f"/seed/{who}"):
            raise RuntimeError(f"cookie fixture failed: {who}")
        # A request received by the fixture precedes WebKit accepting its response.
        until = time.monotonic() + 10
        while time.monotonic() < until:
            state = sv.cmd({"do": "split", "action": "state", "window": window})
            tab = next((x for x in state["tabs"] if x["url"] == f"{base}/seed/{who}"), None)
            if tab and sv.cmd({"do": "eval", "id": tab["id"], "js": "document.cookie", "window": window}).get("value") == f"who={who}":
                return
            time.sleep(0.05)
        raise RuntimeError(f"cookie not stored: {who}")

    def external(base, path, who):
        sv.cmd({"do": "windows", "action": "link", "url": base + path})
        cookies = wait_for(path)
        t.ok(f"{path}: first request uses {who}, exactly once", cookies == [f"who={who}"], cookies)

    try:
        sv.setup(spaces=True, **{"tabs.lazy": False, "links.little": False})
        Path(sv.SUPPORT).mkdir(parents=True, exist_ok=True)
        Path(sv.SUPPORT, "spaces.json").write_text(json.dumps([
            {"id": sv.FIRST_SPACE.upper(), "name": "Personal", "colour": 0},
            {"id": work, "name": "Work", "colour": 0, "sharesSignIns": False},
            {"id": research, "name": "Research", "colour": 0, "sharesSignIns": False},
            {"id": other_home, "name": "Other", "colour": 0, "profile": other, "sharesSignIns": True},
        ]))
        Path(sv.SUPPORT, "profiles.json").write_text(json.dumps([
            {"id": other, "name": "Other", "home": other_home},
        ]))
        defaults("external.routing", "-data", json.dumps({"enabled": True, "rules": rules}).encode().hex())
        sv.launch()
        hidden(t, "initial launch")
        seed(local, "source", 1)
        seed(local, "work", 2)
        seed(localhost, "research", 3)
        sv.cmd({"do": "space", "action": "go", "index": 1})
        external(local, "/warm", "work")
        t.ok("warm external link selects Work", sv.cmd({"do": "space"})["current"] == "Work")
        hidden(t, "warm external link")

        # The same rule must not apply in a different profile's window.
        sv.cmd({"do": "profile", "action": "window", "name": "Other"})
        hidden(t, "second profile")
        seed(local, "other", window=2)
        sv.cmd({"do": "windows", "action": "front", "n": 2})
        external(local, "/other-profile", "other")
        hidden(t, "other profile link")
        sv.cmd({"do": "windows", "action": "close", "n": 2})
        sv.cmd({"do": "windows", "action": "front", "n": 1})
        sv.cmd({"do": "space", "action": "go", "index": 1})
        sv.quit()

        # These are taken by Links.take before Links.hand, like launch Apple Events.
        # Two hosts route consecutive queued links into different cookie stores.
        defaults("routing.probe.launchURLs", "-array", local + "/cold-first")
        subprocess.run(["defaults", "write", sv.SUITE, "routing.probe.launchURLs", "-array-add", localhost + "/cold-second"], check=True)
        sv.launch()
        for path, who in [("/cold-first", "work"), ("/cold-second", "research")]:
            cookies = wait_for(path)
            t.ok(f"{path}: queued first request uses {who}, exactly once", cookies == [f"who={who}"], cookies)
        state = hidden(t, "queued launch links")
        t.ok("tab links never mark browser windows kept away", not state["keptAway"], state)
        t.ok("routed launch links never make a preview", not state["littles"], state["littles"])
        sv.quit()

        # Even with previews enabled, a matched cold link belongs to its Space.
        defaults("links.little", "-bool", "true")
        defaults("routing.probe.launchURLs", "-array", local + "/cold-preview-enabled")
        sv.launch()
        cookies = wait_for("/cold-preview-enabled")
        t.ok("matched cold link bypasses preview with destination session", cookies == ["who=work"], cookies)
        state = hidden(t, "preview enabled")
        t.ok("matched cold link keeps normal browser-window behavior", not state["keptAway"] and not state["littles"], state)
        sv.cmd({"do": "space", "action": "go", "index": 1})
        sv.quit()

        defaults("links.little", "-bool", "false")
        defaults("external.routing", "-data", json.dumps({"enabled": False, "rules": rules}).encode().hex())
        defaults("routing.probe.launchURLs", "-array", local + "/cold-disabled")
        sv.launch()
        cookies = wait_for("/cold-disabled")
        t.ok("disabled routing keeps the source session at launch", cookies == ["who=source"], cookies)
        state = hidden(t, "routing disabled")
        t.ok("disabled routing never keeps browser windows away", not state["keptAway"], state)
        sv.quit()

        missing = rule("127.0.0.1", str(uuid.uuid4()))
        defaults("external.routing", "-data", json.dumps({"enabled": True, "rules": [missing]}).encode().hex())
        defaults("routing.probe.launchURLs", "-array", local + "/cold-missing")
        sv.launch()
        t.ok("missing destination blocks the queued request instead of using source cookies", not wait_for("/cold-missing", timeout=1))
        state = hidden(t, "missing destination")
        t.ok("missing destination never loads the URL in another tab", all(local + "/cold-missing" not in w["tabs"] for w in state["windows"]), state)
    finally:
        sv.finish()
        server.shutdown()
        server.server_close()
        t.done()
    return 1 if t.failed else 0


if __name__ == "__main__":
    sys.exit(main())
