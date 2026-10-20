#!/usr/bin/env python3
"""Check local TUI credential recovery and exit keys through a real PTY.

Run after deploying the complete build to the fixed test directory.
AREAL_TEST_BIN=/absolute/path/areal python3 scripts/tui-recovery-smoke.py
Evidence and isolated service state remain under /private/tmp by default.
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
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TerminalScreen = runpy.run_path(str(Path(__file__).with_name("terminal_screen.py")))[
    "TerminalScreen"
]
KEY_ENV = "AREAL_CREDENTIAL_TUI_FIXTURE"
OVERRIDE_ENV = "TUI_FIXTURE_KEY"
SECRET = "local-tui-fixture-not-a-provider-key"
REPLY = "tui-fixture-reply:"
RESTORED = b"TUI_RECOVERY_TERMINAL_RESTORED"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_identity():
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=ROOT)

    diff = git("diff", "HEAD", "--binary")
    return {
        "root": str(ROOT),
        "commit": git("rev-parse", "HEAD").decode().strip(),
        "status": git("status", "--short").decode(),
        "diffSha256": hashlib.sha256(diff).hexdigest(),
        "runnerSha256": digest(__file__),
    }


class Report:
    def __init__(self, root, timeout):
        self.root, self.timeout = root, timeout
        self.cases = []
        self.commands = []
        self.services = []

    def check(self, name, operation, session=None):
        result = {"name": name, "passed": False}
        try:
            detail = operation()
            result["passed"] = True
            if detail is not None:
                result["detail"] = detail
        except Exception as error:
            result["error"] = str(error).replace(SECRET, "[fixture secret]")
        if session:
            result["screen"] = str(session.capture(name))
        self.cases.append(result)
        print(f"{'PASS' if result['passed'] else 'FAIL'} {name}", flush=True)
        return result["passed"]


class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            prompt = next(
                message["content"]
                for message in reversed(body["messages"])
                if message["role"] == "user"
                and not str(message["content"]).startswith(
                    "AReaL runtime context (not a user request):"
                )
            )
            authorized = self.headers.get("Authorization") == f"Bearer {SECRET}"
            self.server.requests.append(
                {"prompt": prompt, "model": body["model"], "authorized": authorized}
            )
            if not authorized:
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"fixture authorization failed"}}')
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            def event(delta, reason=None):
                value = {"choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                self.wfile.flush()

            event({"content": REPLY + prompt})
            if prompt == "tui-fixture-hold":
                self.connection.settimeout(30)
                try:
                    self.connection.recv(1)
                except (OSError, TimeoutError):
                    pass
                return
            event({}, "stop")
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.server.errors.append(repr(error))
        finally:
            self.close_connection = True


class Session:
    def __init__(self, fixture, name, env=None, args=None):
        self.fixture, self.name = fixture, name
        self.master, self.slave = os.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", 44, 180, 0, 0))
        self.output = bytearray()
        self.screen = TerminalScreen(44, 180)

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        wrapper = """
import subprocess, sys, termios
code = subprocess.call(sys.argv[1:])
assert termios.tcgetattr(0)[3] & termios.ICANON, 'TUI left the terminal in raw mode'
print('TUI_RECOVERY_TERMINAL_RESTORED', flush=True)
sys.exit(code)
"""
        self.child = subprocess.Popen(
            [sys.executable, "-I", "-S", "-c", wrapper, *(args or fixture.tui_args)],
            stdin=self.slave,
            stdout=self.slave,
            stderr=self.slave,
            env=env or fixture.env,
            cwd=fixture.workspace,
            preexec_fn=controlling_terminal,
        )
        fixture.sessions.append(self)

    def pump(self, seconds=0.1):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not select.select(
                [self.master], [], [], min(0.1, max(0, deadline - time.monotonic()))
            )[0]:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                return
            if not chunk:
                return
            self.output.extend(chunk)
            self.screen.feed(chunk)

    def expect(self, pattern, timeout=None):
        deadline = time.monotonic() + (timeout or self.fixture.report.timeout)
        while time.monotonic() < deadline:
            self.pump()
            if re.search(pattern, self.screen.text()):
                return
            if self.child.poll() is not None:
                break
        raise AssertionError(f"screen did not match {pattern!r}; exit={self.child.poll()}")

    def send(self, value):
        assert self.child.poll() is None, "TUI exited before key input"
        os.write(self.master, value)

    def exit(self, keys):
        self.send(keys)
        deadline = time.monotonic() + 4
        while self.child.poll() is None and time.monotonic() < deadline:
            self.pump()
        self.pump(0.2)
        assert self.child.poll() == 0, f"TUI did not exit cleanly; exit={self.child.poll()}"
        assert RESTORED in self.output, "terminal canonical mode was not restored"
        assert b"\x1b[?1049l" in self.output, "alternate screen was not restored"
        assert b"\x1b[?1000l" in self.output, "mouse capture was not disabled"

    def capture(self, label):
        self.pump(0.05)
        path = self.fixture.root / f"{self.name}-{label}.screen.txt"
        path.write_bytes(self.screen.text())
        (self.fixture.root / f"{self.name}.pty.log").write_bytes(self.output)
        return path

    def close(self):
        if self.child.poll() is None:
            self.send(b"\x11")
            deadline = time.monotonic() + 4
            while self.child.poll() is None and time.monotonic() < deadline:
                self.pump()
        if self.child.poll() is None:
            os.killpg(self.child.pid, signal.SIGTERM)
            try:
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(self.child.pid, signal.SIGKILL)
                self.child.wait(timeout=3)
        self.capture("final")
        os.close(self.master)
        os.close(self.slave)


class Fixture:
    def __init__(self, report, binary, model, name, valid=False, extra=(), override=None):
        self.report, self.binary, self.model = report, binary, model
        self.root = report.root / name
        self.root.mkdir()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.sessions = []
        self.service = None
        self.config = self.root / "config.toml"
        self.config.write_text(f'''schema_version = 1
[server]
data_dir = "{self.root / "data"}"
[model]
catalog_version = 1
provider = "fixture"
name = "fixture-model"
[model.providers.fixture]
protocol = "chat-completions"
endpoint = "http://127.0.0.1:{model.server_port}"
api_key_env = "{KEY_ENV}"
models = [{{id="fixture-model",enabled=true}}]
''')
        self.env = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(self.root / "user"),
            "XDG_CONFIG_HOME": str(self.root / "preferences"),
            "AREAL_HARNESS_HOME": str(self.root / "home"),
            "AREAL_HARNESS_SERVICE_HOME": str(self.root / "r"),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "OTEL_SDK_DISABLED": "true",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
            KEY_ENV: SECRET if valid else "",
        }
        if override:
            self.env.update(override)
        self.local_args = ["--workspace", str(self.workspace), "--config", str(self.config), *extra]
        self.tui_args = [
            str(binary),
            *self.local_args,
            "--local-mode=shared",
            "--ascii=true",
            "--theme=dark",
        ]

    def cli(self, args, env=None):
        result = subprocess.run(
            [str(self.binary), *args],
            cwd=self.workspace,
            env=env or self.env,
            capture_output=True,
            timeout=45,
        )
        number = len(self.report.commands)
        log = self.root / f"command-{number}.log"
        log.write_bytes(result.stdout + result.stderr)
        self.report.commands.append({"args": args, "exit": result.returncode, "log": str(log)})
        assert result.returncode == 0, f"command failed with {result.returncode}; see {log}"
        return json.loads(result.stdout)

    def start(self):
        self.service = self.cli(["service", "ensure", "--json", *self.local_args])
        assert self.service["state"] == "ready", self.service
        self.report.services.append(self.service)

    def session(self, name, env=None):
        return Session(self, name, env)

    def ready(self, name, args=None):
        session = Session(self, name, args=args)
        session.expect(rb"[a-f0-9]{8}-[a-f0-9]{4}-")
        session.expect(rb"Welcome")
        return session

    def close(self):
        for session in self.sessions:
            session.close()
        records = list((self.root / "r/services").glob("*/service.json"))
        for path in records:
            service = json.loads(path.read_text())
            if service["state"] != "stopped":
                stopped = self.cli(
                    [
                        "service",
                        "stop",
                        "--json",
                        "--instance",
                        service["serviceId"],
                        "--expected-generation",
                        service["generation"],
                        "--cancel",
                    ]
                )
                assert stopped["state"] == "stopped", stopped
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                alive = []
                for pid in (service["hostPid"], service["corePid"]):
                    inspection = subprocess.run(
                        ["/bin/ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True
                    )
                    assert inspection.returncode in (0, 1) and not inspection.stderr.strip(), (
                        "could not inspect owned process"
                    )
                    state = inspection.stdout.strip()
                    if state and not state.startswith("Z"):
                        alive.append(pid)
                if not alive:
                    break
                time.sleep(0.05)
            assert not alive, f"owned service processes still alive: {alive}"
            port = int(service["endpoint"].rsplit(":", 1)[1].rstrip("/"))
            with socket.socket() as connection:
                connection.settimeout(1)
                assert connection.connect_ex(("127.0.0.1", port)) != 0, "owned Core listener leaked"


def require(value, message):
    assert value, message


def missing_cases(fixture):
    report = fixture.report
    fixture.start()
    session = fixture.session("missing")
    report.check("missing-env-name", lambda: session.expect(KEY_ENV.encode()), session)
    report.check(
        "missing-env-recovery-guidance",
        lambda: (
            session.expect(rb"(?i)(missing|not set|empty|unavailable|required|credential)"),
            require(
                re.search(rb"(?i)restart", session.screen.text()),
                "missing service restart guidance",
            ),
            require(
                re.search(rb"(?i)(export|environment|config)", session.screen.text()),
                "missing environment/config guidance",
            ),
        ),
        session,
    )
    report.check(
        "failed-thread-has-no-loading-target",
        lambda: require(
            b"To loading" not in session.screen.text(), "failed thread still displays To loading"
        ),
        session,
    )
    session.send(b"/model\r")
    report.check(
        "missing-default-unavailable",
        lambda: (
            session.expect(rb"Models.*Enter apply"),
            session.expect(rb"Default[^\n]*unavailable"),
        ),
        session,
    )
    report.check("missing-picker-ctrl-q-exits", lambda: session.exit(b"\x11"), session)

    before = len(fixture.model.requests)
    generation = fixture.service["generation"]
    child_env = {**fixture.env, KEY_ENV: SECRET}
    reused = fixture.session("reused-with-new-client-env", child_env)
    reused.pump(2)
    if reused.child.poll() is None:
        reused.send(b"must-not-reach-model-before-restart\r")
        reused.pump(1)
    report.check(
        "reused-service-does-not-import-client-secret",
        lambda: (
            require(
                len(fixture.model.requests) == before,
                "old service sent a model request after client-only environment change",
            ),
            require(
                fixture.cli(
                    ["service", "status", "--json", "--instance", fixture.service["serviceId"]]
                )["generation"]
                == generation,
                "client silently restarted the shared service",
            ),
        ),
        reused,
    )
    if reused.child.poll() is None:
        report.check("reused-client-exits", lambda: reused.exit(b"\x11"), reused)

    fixture.env[KEY_ENV] = SECRET
    fixture.service = fixture.cli(["service", "restart", "--json", *fixture.local_args])
    fixture.report.services.append(fixture.service)
    require(
        fixture.service["generation"] != generation,
        "explicit restart did not replace service generation",
    )
    success_case(fixture, "explicit-service-restart-recovers")


def success_case(fixture, name):
    session = fixture.ready(name)
    prompt = name
    before = len(fixture.model.requests)
    session.send(prompt.encode() + b"\r")
    session.expect((REPLY + prompt).encode())
    session.expect(rb"Completed")
    requests = fixture.model.requests[before:]
    require(
        any(r["prompt"] == prompt and r["authorized"] for r in requests),
        "model fixture did not receive the configured environment credential",
    )
    require(SECRET.encode() not in session.output, "credential appeared in terminal output")
    session.exit(b"\x11")


def exit_cases(fixture):
    fixture.start()
    report = fixture.report
    for name, prepare, keys in [
        ("idle-ctrl-c-exits", b"", b"\x03"),
        ("idle-ctrl-q-exits", b"", b"\x11"),
        ("model-picker-ctrl-q-exits", b"/model\r", b"\x11"),
        ("model-picker-full-quit-exits", b"/model\r", b"/quit\r"),
        ("navigation-slash-quit-exits", b"\t", b"/quit\r"),
        ("content-slash-quit-exits", b"\t\t", b"/quit\r"),
    ]:

        def run_case():
            session = fixture.ready(name)
            if prepare:
                session.send(prepare)
                if b"/model" in prepare:
                    session.expect(rb"Models.*Enter apply")
                else:
                    session.pump(0.2)
            report.check(name, lambda: session.exit(keys), session)

        report.check(name + "-setup", run_case)

    def cancellation():
        session = fixture.ready("active-cancel")
        session.send(b"tui-fixture-hold\r")
        session.expect(rb"Waiting for model response")
        deadline = time.monotonic() + report.timeout
        while (
            not any(r["prompt"] == "tui-fixture-hold" for r in fixture.model.requests)
            and time.monotonic() < deadline
        ):
            session.pump()
        require(
            any(
                r["prompt"] == "tui-fixture-hold" and r["authorized"]
                for r in fixture.model.requests
            ),
            "active request never reached the authorized HTTP fixture",
        )
        session.send(b"\x03")
        report.check(
            "active-ctrl-c-cancels-and-stays",
            lambda: (
                session.expect(rb"Interrupted"),
                require(
                    session.child.poll() is None,
                    "Ctrl-C exited instead of cancelling the active turn",
                ),
            ),
            session,
        )
        report.check("idle-ctrl-c-after-cancel-exits", lambda: session.exit(b"\x03"), session)

    report.check("active-cancel-setup", cancellation)

    def disconnected():
        service = fixture.service
        session = fixture.ready(
            "disconnected",
            args=[
                str(fixture.binary),
                "--endpoint",
                service["endpoint"],
                "--auth-file",
                service["authFile"],
                "--ascii=true",
                "--theme=dark",
            ],
        )
        stopped = fixture.cli(
            [
                "service",
                "stop",
                "--json",
                "--instance",
                service["serviceId"],
                "--expected-generation",
                service["generation"],
            ]
        )
        require(stopped["state"] == "stopped", "isolated Core did not stop")
        session.expect(rb"RECONNECTING")
        session.send(b"\x03")
        session.pump(0.3)
        require(
            session.child.poll() is None, "Ctrl-C treated an unconfirmed cached snapshot as idle"
        )
        session.expect(rb"(?i)(awaiting confirmation|check status)")
        session.exit(b"\x11")

    report.check("disconnected-ctrl-c-preserves-uncertainty", disconnected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=os.environ.get("AREAL_TEST_EVIDENCE"))
    parser.add_argument("--timeout", type=float, default=12)
    args = parser.parse_args()
    binary_value = os.environ.get("AREAL_TEST_BIN")
    if not binary_value:
        parser.error("set AREAL_TEST_BIN to the fixed real areal executable")
    binary = Path(binary_value)
    if not binary.is_absolute() or binary.is_symlink() or not binary.is_file():
        parser.error("AREAL_TEST_BIN must be an absolute regular executable path")
    binary = binary.resolve()
    binaries = [binary, binary.with_name("areal-runtime"), binary.with_name("areal-runtime-fs")]
    if sys.platform.startswith("linux"):
        binaries.append(binary.with_name("areal-runtime-reaper"))
    for component in binaries:
        if component.is_symlink() or not component.is_file():
            parser.error(f"missing regular fixed-path component {component}")
    evidence = args.evidence or Path(tempfile.mkdtemp(prefix="atr-", dir="/private/tmp"))
    evidence = evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    report = Report(evidence, args.timeout)
    identity = source_identity()
    build_info = json.loads(subprocess.check_output([str(binary), "build-info"], cwd=ROOT))
    before = {str(path): digest(path) for path in binaries}
    model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    model.daemon_threads = True
    model.requests, model.errors = [], []
    threading.Thread(target=model.serve_forever, daemon=True).start()
    fixtures = []
    try:
        for name, valid, extra, override, operation in [
            ("missing-config-env", False, (), None, missing_cases),
            ("valid-config-env", True, (), None, exit_cases),
            (
                "cli-env-override",
                False,
                ("--api-key-env", OVERRIDE_ENV),
                {OVERRIDE_ENV: SECRET},
                lambda f: (f.start(), success_case(f, "cli-api-key-env-recovers")),
            ),
            (
                "environment-env-override",
                False,
                (),
                {"AREAL_HARNESS_API_KEY_ENV": OVERRIDE_ENV, OVERRIDE_ENV: SECRET},
                lambda f: (f.start(), success_case(f, "environment-api-key-env-recovers")),
            ),
        ]:
            fixture = Fixture(report, binary, model, name, valid, extra, override)
            fixtures.append(fixture)
            report.check(name + "-scenario", lambda: operation(fixture))
            report.check(name + "-cleanup", fixture.close)
        report.check("http-fixture-errors", lambda: require(not model.errors, repr(model.errors)))
        report.check(
            "http-authorization",
            lambda: require(
                model.requests and all(r["authorized"] for r in model.requests),
                "HTTP fixture received no authenticated requests or received invalid Authorization",
            ),
        )
        report.check(
            "binaries-unchanged",
            lambda: require(
                before == {str(path): digest(path) for path in binaries},
                "fixed binaries changed during the run",
            ),
        )
        report.check(
            "fixture-secret-not-in-output",
            lambda: require(
                not any(
                    SECRET.encode() in path.read_bytes()
                    for path in evidence.rglob("*")
                    if path.is_file()
                    and (path.suffix == ".log" or path.name.endswith(".screen.txt"))
                ),
                "fixture credential appeared in terminal, command, or service output",
            ),
        )
    finally:
        model.shutdown()
        model.server_close()
        (evidence / "requests.json").write_text(json.dumps(model.requests, indent=2) + "\n")
        result = {
            "passed": bool(report.cases) and all(case["passed"] for case in report.cases),
            "scope": "real shared Core/Runtime and PTY with local deterministic HTTP model; no paid provider or package acceptance",
            "source": identity,
            "buildInfo": build_info,
            "binaries": before,
            "evidence": str(evidence),
            "cases": report.cases,
            "commands": report.commands,
            "services": report.services,
        }
        (evidence / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Evidence: {evidence}", flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
