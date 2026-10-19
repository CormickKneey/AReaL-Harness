#!/usr/bin/env python3
"""Keep a new shared backend alive when an old, still-open TUI reconnects.

Use two complete, immutable real binary directories. This exercises explicit
service activation and real PTYs, not the installer or a paid model provider.
"""

import argparse
import errno
import fcntl
import hashlib
import http.server
import json
import os
import re
import runpy
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TerminalScreen = runpy.run_path(str(Path(__file__).with_name("terminal_screen.py")))[
    "TerminalScreen"
]
REPLY = "upgrade-reply:"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def bundle(directory):
    binary = directory / "areal"
    runtime = directory / "../libexec/areal"
    if not runtime.is_dir():
        runtime = directory
    paths = [binary, runtime / "areal-runtime", runtime / "areal-runtime-fs"]
    if sys.platform.startswith("linux"):
        paths.append(runtime / "areal-runtime-reaper")
    for path in paths:
        require(
            path.is_absolute() and not path.is_symlink() and path.is_file(),
            f"expected an absolute regular executable: {path}",
        )
    return {str(path.resolve()): digest(path) for path in paths}


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            prompt = next(
                item["content"]
                for item in reversed(body["messages"])
                if item["role"] == "user"
                and not str(item["content"]).startswith(
                    "AReaL runtime context (not a user request):"
                )
            )
            self.server.requests.append({"prompt": prompt, "model": body["model"]})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, reason in [({"content": REPLY + prompt}, None), ({}, "stop")]:
                event = {"choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.server.errors.append(repr(error))
        finally:
            self.close_connection = True


class Session:
    def __init__(self, fixture, name, binary):
        self.fixture, self.name = fixture, name
        self.output = bytearray()
        self.screen = TerminalScreen(44, 180)
        self.paused = False
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 180, 0, 0))

        def terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.child = subprocess.Popen(
            [
                str(binary),
                *fixture.local_args,
                "--local-mode=shared",
                "--ascii=true",
                "--theme=dark",
            ],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=fixture.workspace,
            env=fixture.env,
            preexec_fn=terminal,
        )
        os.close(slave)
        fixture.sessions.append(self)

    def pump(self, timeout=0.05):
        if self.master is None:
            return
        if not select.select([self.master], [], [], timeout)[0]:
            return
        try:
            data = os.read(self.master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        self.output.extend(data)
        self.screen.feed(data)

    def send(self, keys):
        require(self.child.poll() is None, f"{self.name} TUI exited before input")
        os.write(self.master, keys)

    def expect(self, text):
        self.fixture.until(
            lambda: text in self.screen.text(),
            f"{self.name} TUI did not display {text!r}; exit={self.child.poll()}",
        )

    def pause(self):
        os.kill(self.child.pid, signal.SIGSTOP)
        self.paused = True
        self.fixture.until(
            lambda: os.WIFSTOPPED(os.waitpid(self.child.pid, os.WNOHANG | os.WUNTRACED)[1]),
            "old TUI did not pause",
        )

    def resume(self):
        if self.paused and self.child.poll() is None:
            os.kill(self.child.pid, signal.SIGCONT)
        self.paused = False

    def capture(self, label):
        (self.fixture.root / f"{self.name}-{label}.screen.txt").write_bytes(self.screen.text())
        (self.fixture.root / f"{self.name}.pty.log").write_bytes(self.output)

    def close(self):
        self.resume()
        if self.child.poll() is None:
            self.send(b"\x11")
            try:
                self.fixture.until(
                    lambda: self.child.poll() is not None,
                    f"{self.name} TUI did not quit",
                    timeout=4,
                )
            except AssertionError:
                self.child.terminate()
                try:
                    self.child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=3)
        self.pump(0)
        self.capture("final")
        os.close(self.master)
        self.master = None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class Fixture:
    def __init__(self, root, old, new, model, timeout, report):
        self.root, self.old, self.new = root, old, new
        self.model, self.timeout, self.report = model, timeout, report
        self.sessions = []
        self.workspace, self.data = root / "workspace", root / "data"
        self.workspace.mkdir()
        self.config = root / "config.toml"
        self.config.write_text(f'''schema_version = 1
[server]
data_dir = "{self.data}"
[model]
provider = "fixture"
name = "upgrade-fixture"
[model.providers.fixture]
protocol = "chat-completions"
endpoint = "http://127.0.0.1:{model.server_port}"
''')
        self.env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(root / "user"),
            "XDG_CONFIG_HOME": str(root / "preferences"),
            "AREAL_HARNESS_HOME": str(root / "home"),
            "AREAL_HARNESS_SERVICE_HOME": str(root / "registry"),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "OTEL_SDK_DISABLED": "true",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
        self.local_args = ["--workspace", str(self.workspace), "--config", str(self.config)]

    def until(self, predicate, message, timeout=None):
        deadline = time.monotonic() + (timeout or self.timeout)
        while time.monotonic() < deadline:
            for session in self.sessions:
                session.pump(0.025)
            if predicate():
                return
        raise AssertionError(message)

    def command(self, binary, args, expected_exit=0):
        result = subprocess.run(
            [str(binary), *args], cwd=self.workspace, env=self.env, capture_output=True, timeout=60
        )
        log = self.root / f"command-{len(self.report['commands'])}.log"
        log.write_bytes(result.stdout + result.stderr)
        self.report["commands"].append(
            {"binary": str(binary), "args": args, "exit": result.returncode, "log": str(log)}
        )
        require(
            result.returncode == expected_exit, f"command exited {result.returncode}; see {log}"
        )
        return json.loads(result.stdout if expected_exit == 0 else result.stderr)

    def status(self):
        return self.command(
            self.new, ["service", "status", "--json", "--workspace", str(self.workspace)]
        )

    def observe(self, name):
        service = self.status()
        self.report["services"].append({"name": name, **service})
        self.record_processes(service)
        return service

    def record_processes(self, service):
        pids = {service["hostPid"], service["corePid"]}
        log = Path(service["logFile"])
        if log.is_file():
            pids.update(
                int(pid) for pid in re.findall(r"AReaL launcher [^\n]* PID: (\d+)", log.read_text())
            )
        self.report["processes"] = sorted(set(self.report["processes"]) | pids)

    def identity(self, service):
        auth = json.loads(Path(service["authFile"]).read_text())
        url = service["endpoint"].replace("ws://", "http://").rstrip("/") + "/areal/service"
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": "Bearer " + auth["principals"][0]["token"],
            },
        )
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            request, timeout=3
        ) as response:
            value = json.load(response)
        require(value["generation"] == service["generation"], "HTTP identity changed generation")
        require(value["serviceId"] == service["serviceId"], "HTTP identity changed service")
        return value

    def rpc(self, service, method, params):
        program = f"""
import {{connect}} from {json.dumps((ROOT / "examples/desktop-api/client.mjs").as_uri())};
const [service, method, params] = JSON.parse(process.argv[1]);
const client = await connect(service.endpoint, service.authFile);
try {{ console.log(JSON.stringify(await client.call(method, params))); }}
finally {{ await client.close(); }}
"""
        result = subprocess.run(
            [
                shutil.which("node"),
                "--input-type=module",
                "-e",
                program,
                json.dumps([service, method, params]),
            ],
            cwd=ROOT,
            env=self.env,
            capture_output=True,
            timeout=30,
        )
        require(
            result.returncode == 0,
            "read-only RPC failed: " + result.stderr.decode(errors="replace"),
        )
        return json.loads(result.stdout)

    def completed(self, prompt, version):
        for path in self.data.glob("*.json"):
            value = json.loads(path.read_text())
            thread = value.get("thread", {})
            if any(
                turn.get("status") == "completed"
                and any(
                    item.get("type") == "agentMessage" and item.get("text") == REPLY + prompt
                    for item in turn.get("items", [])
                )
                for turn in thread.get("turns", [])
            ):
                require(
                    value.get("version") == version,
                    f"persisted session version is {value.get('version')}, expected {version}",
                )
                return thread["id"]
        return None

    def turn(self, session, prompt, version):
        session.send((prompt + "\r").encode())
        session.expect((REPLY + prompt).encode())
        self.until(
            lambda: self.completed(prompt, version), f"turn {prompt!r} did not persist as completed"
        )
        session.capture(prompt)
        return self.completed(prompt, version)

    def unchanged(self, expected):
        actual = self.observe("old-reconnect-observation")
        require(
            actual["state"] == "ready"
            and actual["generation"] == expected["generation"]
            and actual["corePid"] == expected["corePid"]
            and actual["hostPid"] == expected["hostPid"],
            "old TUI reconnect stopped or replaced the new backend: "
            + json.dumps(
                {
                    "expectedGeneration": expected["generation"],
                    "observed": actual,
                },
                sort_keys=True,
            ),
        )
        return actual

    def close(self):
        for session in self.sessions:
            session.close()
        for path in (self.root / "registry/services").glob("*/service.json"):
            service = json.loads(path.read_text())
            self.record_processes(service)
            stopped = self.command(
                self.new,
                [
                    "service",
                    "stop",
                    "--json",
                    "--instance",
                    service["serviceId"],
                    "--expected-generation",
                    service["generation"],
                    "--cancel",
                ],
            )
            require(stopped["state"] == "stopped", "owned backend did not stop")
            pids = self.report["processes"]
            self.until(
                lambda: all(not alive(pid) for pid in pids),
                f"owned backend processes leaked: {pids}",
                timeout=8,
            )
            port = int(service["endpoint"].rsplit(":", 1)[1].rstrip("/"))
            with socket.socket() as connection:
                connection.settimeout(1)
                require(connection.connect_ex(("127.0.0.1", port)) != 0, "owned listener leaked")
        self.report["cleanup"] = {
            "passed": True,
            "tuiPids": [s.child.pid for s in self.sessions],
            "allTuisExited": all(s.child.poll() is not None for s in self.sessions),
        }


def scenario(fixture, old_version, new_version):
    report = fixture.report
    old = Session(fixture, "old", fixture.old)
    old.expect(b"live")
    first = fixture.observe("old-ready")
    report["oldIdentity"] = fixture.identity(first)
    fixture.turn(old, "before-upgrade", old_version)
    conflict = fixture.command(
        fixture.new, ["service", "ensure", "--json", *fixture.local_args], expected_exit=1
    )
    require(
        re.search(r"configuration conflict.*binaries", conflict["error"]["message"]),
        "new client did not refuse implicit binary activation",
    )
    fixture.unchanged(first)
    report["implicitActivationRejected"] = True
    old.pause()
    activated = fixture.command(fixture.new, ["service", "restart", "--json", *fixture.local_args])
    report["services"].append({"name": "explicit-new-activation", **activated})
    require(
        activated["generation"] != first["generation"],
        "explicit activation reused the old generation",
    )
    new = Session(fixture, "new", fixture.new)
    new.expect(b"live")
    thread_id = fixture.turn(new, "new-before-reconnect", new_version)
    service = fixture.observe("new-ready")
    require(
        service["generation"] == activated["generation"], "new TUI replaced the activated backend"
    )
    report["newIdentity"] = fixture.identity(service)
    server = fixture.rpc(service, "areal/server/status", {})
    require(
        server["stateVersion"] == new_version and server["restartSafe"],
        "new backend is not idle at the expected state version",
    )
    report["newServerBeforeReconnect"] = server
    old.resume()
    old.send(b"\x12")
    old.expect(b"RECONNECTING")
    old.capture("reconnect-requested")
    fixture.unchanged(service)
    deadline = time.monotonic() + 18
    samples = 0
    while time.monotonic() < deadline:
        for session in fixture.sessions:
            session.pump(0.05)
        require(old.child.poll() is None, "old TUI exited during reconnect")
        require(new.child.poll() is None, "new TUI exited during old reconnect")
        fixture.unchanged(service)
        samples += 1
    report["reconnectObservations"] = samples
    require(samples >= 3, "insufficient live observations of the old reconnect window")
    fixture.turn(new, "new-after-old-reconnect", new_version)
    fixture.unchanged(service)
    restored = fixture.rpc(service, "thread/read", {"threadId": thread_id, "includeTurns": True})
    require(len(restored["thread"]["turns"]) == 2, "new TUI did not preserve both completed turns")
    require(
        all(turn["status"] == "completed" for turn in restored["thread"]["turns"]),
        "new TUI has an incomplete turn after old reconnect",
    )
    report["newThreadAfterReconnect"] = restored
    for session in fixture.sessions:
        session.capture("coexistence")
    require(not fixture.model.errors, repr(fixture.model.errors))
    require(
        [request["prompt"] for request in fixture.model.requests]
        == [
            "before-upgrade",
            "new-before-reconnect",
            "new-after-old-reconnect",
        ],
        "model received unexpected or replayed submissions",
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-bin-dir", required=True, type=Path)
    parser.add_argument("--new-bin-dir", required=True, type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--timeout", type=float, default=20)
    args = parser.parse_args()
    require(shutil.which("node"), "node is required for the existing public RPC client")
    old_files, new_files = bundle(args.old_bin_dir), bundle(args.new_bin_dir)
    require(
        args.old_bin_dir.resolve() != args.new_bin_dir.resolve(), "old and new slots must differ"
    )
    root = (args.evidence or Path(tempfile.mkdtemp(prefix="atu-", dir="/tmp"))).resolve()
    root.mkdir(parents=True, exist_ok=True)
    old, new = args.old_bin_dir / "areal", args.new_bin_dir / "areal"
    builds = {
        name: json.loads(subprocess.check_output([str(path), "build-info"], cwd=ROOT))
        for name, path in [("old", old), ("new", new)]
    }
    require(
        builds["old"]["stateVersion"] < builds["new"]["stateVersion"],
        "regression requires an older state format and a newer state format",
    )

    def git(*items):
        return subprocess.check_output(["git", *items], cwd=ROOT)

    report = {
        "passed": False,
        "scope": "real old/new PTYs and Core/Runtime with local HTTP/SSE model; explicit service restart; installer and paid providers excluded",
        "source": {
            "root": str(ROOT),
            "commit": git("rev-parse", "HEAD").decode().strip(),
            "status": git("status", "--short").decode(),
            "diffSha256": hashlib.sha256(git("diff", "HEAD", "--binary")).hexdigest(),
            "runnerSha256": digest(__file__),
        },
        "buildInfo": builds,
        "binaries": {"old": old_files, "new": new_files},
        "evidence": str(root),
        "commands": [],
        "services": [],
        "processes": [],
    }
    model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    model.daemon_threads = True
    model.requests, model.errors = [], []
    threading.Thread(target=model.serve_forever, daemon=True).start()
    fixture = Fixture(root, old, new, model, args.timeout, report)
    try:
        scenario(fixture, builds["old"]["stateVersion"], builds["new"]["stateVersion"])
        report["passed"] = True
        print(
            "PASS old TUI reconnect preserves the new generation and both new TUI turns", flush=True
        )
    except Exception as error:
        report["error"] = str(error)
        print("FAIL " + str(error), flush=True)
    finally:
        try:
            fixture.close()
        except Exception as error:
            report["passed"] = False
            report["cleanup"] = {"passed": False, "error": str(error)}
            print("FAIL cleanup: " + str(error), flush=True)
        model.shutdown()
        model.server_close()
        report["binariesUnchanged"] = old_files == bundle(args.old_bin_dir) and new_files == bundle(
            args.new_bin_dir
        )
        report["passed"] = report["passed"] and report["binariesUnchanged"]
        report["modelRequests"], report["modelErrors"] = model.requests, model.errors
        (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Evidence: " + str(root), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
