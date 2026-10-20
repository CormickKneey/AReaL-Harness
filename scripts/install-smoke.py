#!/usr/bin/env python3
"""使用完整包和真实共享服务验证入口更新不接管旧后台；只操作本轮隔离实例。"""

import argparse
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class HeldModel(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if any(
            message.get("role") == "system"
            and isinstance(message.get("content"), str)
            and message["content"].startswith("Generate a concise semantic session title")
            for message in request["messages"]
        ):
            assert not request.get("tools"), "session naming must not receive tools"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(
                b'data: {"choices":[{"index":0,"delta":{"content":"Installed session"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
            )
            self.wfile.flush()
            return
        self.server.requests += 1
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(
            b'data: {"choices":[{"index":0,"delta":{"content":"retained turn"},"finish_reason":null}]}\n\n'
        )
        self.wfile.flush()
        self.server.entered.set()
        if not self.server.release.wait(40):
            return
        self.wfile.write(
            b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        )
        self.wfile.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--homebrew-executable", type=Path)
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    manifest = json.loads((bundle / "manifest.json").read_text())
    version = manifest["productVersion"].removeprefix("areal ")
    target = {"darwin/arm64": "aarch64-apple-darwin", "linux/x86_64": "x86_64-unknown-linux-gnu"}[
        manifest["platform"]
    ]
    root = Path(tempfile.mkdtemp(prefix="ai-", dir="/tmp")).resolve()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AREAL_", "OTEL_"))}
    env.update(HOME=str(root / "user"), AREAL_HARNESS_HOME=str(root / "home"))
    (root / "user").mkdir()
    workspace = root / "workspace"
    workspace.mkdir()
    model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HeldModel)
    model.entered = threading.Event()
    model.release = threading.Event()
    model.requests = 0
    threading.Thread(target=model.serve_forever, daemon=True).start()
    config = root / "config.toml"
    config.write_text(
        'schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\n'
        f'endpoint="http://127.0.0.1:{model.server_port}/v1/chat/completions"\n'
    )
    archive = root / f"areal-harness-v{version}-{target}.tar.gz"
    with tarfile.open(archive, "w:gz") as stream:
        stream.add(bundle, arcname="areal")
    sums = root / "SHA256SUMS"
    sums.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")
    prefix = root / "installed bundle"
    entry = prefix / "bin/areal"
    service = None
    turn = None
    report = {
        "passed": False,
        "sourceRevision": manifest["sourceRevision"],
        "version": version,
        "platform": manifest["platform"],
        "root": str(root),
        "checks": [],
    }

    def run(command, check=True):
        return subprocess.run(
            command, env=env, capture_output=True, text=True, timeout=90, check=check
        )

    def install(destination, requested=version):
        return run(
            [
                sys.executable,
                str(ROOT / "scripts/install.py"),
                "--version",
                requested,
                "--prefix",
                str(destination),
                "--archive",
                str(archive),
                "--checksums",
                str(sums),
            ],
            check=False,
        )

    try:
        first = install(prefix)
        assert first.returncode == 0, first.stderr
        before = entry.resolve()
        # 同一真实二进制的合成旧布局；不冒充已发布旧版本。
        baseline = before.parent.parent.with_name("baseline-fixture")
        before.parent.parent.rename(baseline)
        entry.unlink()
        entry.symlink_to(baseline / "bin/areal")
        old_entry = entry.resolve()
        retained = {
            str(p.relative_to(baseline)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in baseline.rglob("*")
            if p.is_file()
        }
        service = json.loads(
            run(
                [
                    str(entry),
                    "service",
                    "ensure",
                    "--json",
                    "--workspace",
                    str(workspace),
                    "--config",
                    str(config),
                ]
            ).stdout
        )
        assert service["state"] == "ready", service
        original = {key: service[key] for key in ["serviceId", "generation", "hostPid", "corePid"]}
        config_before = config.read_bytes()
        # 通过公开协议挂住真实 Turn；入口切换不得取消任务或重新提交模型请求。
        turn = subprocess.Popen(
            [
                "node",
                "--input-type=module",
                "-e",
                """
const { connect } = await import(process.argv[1]);
const service = JSON.parse(process.argv[2]);
const client = await connect(service.endpoint, service.authFile);
try {
  const { thread } = await client.call("areal/thread/start", {
    requestId: crypto.randomUUID(), cwd: process.argv[3],
  });
  await client.call("areal/turn/start", {
    requestId: crypto.randomUUID(), threadId: thread.id,
    input: [{ type: "text", text: "hold through entry update" }],
  });
  const completed = await client.waitEvent("turn/completed", p => p.threadId === thread.id);
  if (completed.turn.status !== "completed") throw Error(JSON.stringify(completed));
  console.log(JSON.stringify({ status: completed.turn.status }));
} finally { await client.close(); }
""",
                (ROOT / "examples/desktop-api/client.mjs").as_uri(),
                json.dumps(service),
                str(workspace),
            ],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert model.entered.wait(20), "real turn did not reach the held model fixture"
        if args.homebrew_executable:
            blocked = run([str(args.homebrew_executable), "upgrade"], check=False)
            assert blocked.returncode != 0 and "stop all shared services" in blocked.stderr, blocked
            assert turn.poll() is None
            report["checks"].append(
                "Homebrew upgrade refuses an active task without stopping or replacing its service"
            )
        installed = install(prefix)
        assert installed.returncode == 0, installed.stderr
        observed = json.loads(
            run(
                [str(entry), "service", "status", "--json", "--instance", service["serviceId"]]
            ).stdout
        )
        assert observed["state"] == "ready", observed
        assert {key: observed[key] for key in original} == original
        assert turn.poll() is None, "active turn ended before the model fixture was released"
        assert model.requests == 1, "entry update replayed the model request"
        assert old_entry.exists() and entry.resolve() != old_entry
        assert run([str(old_entry), "--version"]).stdout.strip() == "areal " + version
        assert run([str(entry), "--version"]).stdout.strip() == "areal " + version
        assert config.read_bytes() == config_before
        assert retained == {
            str(p.relative_to(baseline)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in baseline.rglob("*")
            if p.is_file()
        }
        report["checks"].append(
            "entry switches while the real old service retains PID/generation and its complete unchanged bundle"
        )
        model.release.set()
        stdout, stderr = turn.communicate(timeout=30)
        assert turn.returncode == 0, stderr
        assert json.loads(stdout)["status"] == "completed"
        assert model.requests == 1
        turn = None
        report["checks"].append(
            "the original active turn completes once without interruption or replay"
        )
        # 新前缀安装不接管另一个安装的后台。
        second = install(root / "second-prefix")
        assert second.returncode == 0, second.stderr
        assert (
            json.loads(
                run(
                    [str(entry), "service", "status", "--json", "--instance", service["serviceId"]]
                ).stdout
            )["generation"]
            == original["generation"]
        )
        report["checks"].append(
            "installing another prefix never stops or replaces the existing service"
        )
        run([str(entry), "service", "stop", "--json", "--instance", service["serviceId"]])
        state = json.loads(
            run(
                [str(entry), "service", "status", "--json", "--instance", service["serviceId"]]
            ).stdout
        )
        assert state["state"] == "stopped", state
        service = None
        report["passed"] = True
    except BaseException as error:
        report["error"] = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            report["stderr"] = error.stderr
            report["stdout"] = error.stdout
        raise
    finally:
        model.release.set()
        if turn is not None:
            try:
                turn.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                turn.terminate()
                turn.communicate(timeout=5)
        if service is not None:
            stopped = run(
                [
                    str(entry),
                    "service",
                    "stop",
                    "--json",
                    "--instance",
                    service["serviceId"],
                    "--cancel",
                ],
                check=False,
            )
            report["cleanupStopExitCode"] = stopped.returncode
            if stopped.returncode != 0:
                report["passed"] = False
        model.shutdown()
        model.server_close()
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(json.dumps(report, indent=2) + "\n")
        if report["passed"]:
            shutil.rmtree(root)
        print(json.dumps(report))


if __name__ == "__main__":
    main()
