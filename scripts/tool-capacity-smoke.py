#!/usr/bin/env python3
"""短时同 Scope 并发文件操作与受限 Node 初始化回归；保留失败回执。"""

import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import time

SPEC = importlib.util.spec_from_file_location(
    "runtime_smoke", Path(__file__).with_name("runtime-smoke.py")
)
runtime_smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime_smoke)
REPO = Path(__file__).resolve().parent.parent


def parallel_files(binary, root):
    source = b"fixture content\n"
    (root / "source.txt").write_bytes(source)
    for index in range(2):
        (root / f"edit-{index}.txt").write_bytes(source)
    runtime = runtime_smoke.Runtime(
        binary,
        root,
        ["--max-processes", "2", "--wall-time-ms", "5000", "--allow-concurrent-writes"],
    )
    started = time.monotonic()
    results = []
    try:
        runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
        scope = runtime.scope()
        # 两个真实后台命令先占满祖先名额，随后一次提交十六个文件操作。
        commands = [runtime.start(scope, "sleep 0.5") for _ in range(2)]
        requests = []
        for index in range(2):
            for command in [
                {"kind": "read", "path": "workspace://repo/source.txt", "maxBytes": 64},
                {"kind": "readForHistory", "path": "workspace://repo/source.txt", "maxBytes": 64},
                {"kind": "stat", "path": "workspace://repo/source.txt"},
                {"kind": "list", "path": "workspace://repo", "limit": 32},
                {
                    "kind": "search",
                    "path": "workspace://repo/source.txt",
                    "pattern": "fixture",
                    "context": 0,
                    "limit": 4,
                },
                {
                    "kind": "write",
                    "path": f"workspace://repo/write-{index}.txt",
                    "dataBase64": base64.b64encode(source).decode(),
                    "expected": {"kind": "absent"},
                },
                {
                    "kind": "applyPatch",
                    "path": f"workspace://repo/edit-{index}.txt",
                    "oldText": "fixture",
                    "newText": "verified",
                    "expectedSha256": hashlib.sha256(source).hexdigest(),
                },
                {"kind": "stat", "path": "workspace://repo"},
            ]:
                request = {"operationId": runtime.op(), "scopeId": scope, "command": command}
                requests.append((runtime.send("fs.execute", request), request))
        peak = runtime.call("scope.get", {"scopeId": runtime.info["rootScopeId"]})[
            "activeProcesses"
        ]
        for request_id, request in requests:
            try:
                result = runtime.receive(request_id)
                # 相同操作 ID 回放只返回原回执，写文件不能再次发生。
                assert runtime.call("fs.execute", request) == result
                results.append({"kind": request["command"]["kind"], "success": True})
            except runtime_smoke.RpcError as error:
                results.append(
                    {"kind": request["command"]["kind"], "success": False, "error": error.value}
                )
            peak = max(
                peak,
                runtime.call("scope.get", {"scopeId": runtime.info["rootScopeId"]})[
                    "activeProcesses"
                ],
            )
        for process in commands:
            assert runtime.call("process.wait", {"processId": process})["exitCode"] == 0
        assert peak <= 2, "并发名额不能因文件排队而扩大"
        for index in range(2):
            if all(result["success"] for result in results):
                assert (root / f"write-{index}.txt").read_bytes() == source
                assert (root / f"edit-{index}.txt").read_text() == "verified content\n"
        return {
            "concurrency": 16,
            "processLimit": 2,
            "observedPeak": peak,
            "durationMs": round((time.monotonic() - started) * 1000),
            "calls": results,
        }
    finally:
        runtime.close()


def node_initialization(binary, module):
    runtime = runtime_smoke.Runtime(binary, REPO / "clients/gui", ["--wall-time-ms", "5000"])
    try:
        runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
        scope = runtime.scope()
        program = (
            f"const {{subscriptionNetwork}} = await import({json.dumps(module.as_uri())});"
            "for (let i=0;i<16;i++) subscriptionNetwork({}).close();"
            "console.log('TRANSPORT_INITIALIZATION_OK');"
        )
        process = runtime.call(
            "process.start",
            {
                "operationId": runtime.op(),
                "scopeId": scope,
                "argv": ["node", "--input-type=module", "-e", program],
                "cwd": "workspace://repo",
            },
        )["processId"]
        result = runtime.call("process.wait", {"processId": process})
        return {"process": result, "output": runtime.output(process), "instances": 16}
    finally:
        runtime.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, default=REPO / "target/debug")
    parser.add_argument(
        "--network-module",
        type=Path,
        default=REPO / "clients/gui/packages/chatgpt-provider/network.js",
    )
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    binary = (args.bin_dir / "areal-runtime").resolve()
    started = time.monotonic()
    report = {"runtimeSha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "attempts": []}
    try:
        with tempfile.TemporaryDirectory(prefix="areal-tool-capacity-") as directory:
            report["files"] = parallel_files(binary, Path(directory).resolve())
        report["node"] = node_initialization(binary, args.network_module.resolve())
        report["success"] = (
            all(call["success"] for call in report["files"]["calls"])
            and report["node"]["process"]["exitCode"] == 0
        )
    except Exception as error:
        report["success"] = False
        report["attempts"].append({"error": str(error), "type": type(error).__name__})
    finally:
        report["durationMs"] = round((time.monotonic() - started) * 1000)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(
        json.dumps(
            {
                "success": report["success"],
                "durationMs": report["durationMs"],
                "report": str(args.report),
            }
        )
    )
    raise SystemExit(0 if report["success"] else 1)


if __name__ == "__main__":
    main()
