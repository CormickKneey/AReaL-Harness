#!/usr/bin/env python3
"""无模型验证累计输出、单进程额度与文件助手重复请求计量。"""

import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location(
    "runtime_smoke", Path(__file__).with_name("runtime-smoke.py")
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument(
        "--sandbox-profile",
        choices=("native", "full-access", "outer-container-perf"),
        default="native",
    )
    args = parser.parse_args()
    binary = args.bin_dir.resolve() / "areal-runtime"
    results = {}
    with tempfile.TemporaryDirectory(prefix="areal-output-") as directory:
        runtime = smoke.Runtime(
            binary,
            Path(directory),
            [
                "--sandbox-profile",
                args.sandbox_profile,
                "--output-bytes",
                "1024",
                "--cumulative-output-bytes",
                "4096",
                "--max-operations",
                "65536",
            ],
        )
        try:
            runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
            root = runtime.info["rootScopeId"]
            scope = runtime.scope()
            for _ in range(2):
                process = runtime.start(scope, "head -c 1024 /dev/zero")
                done = runtime.call("process.wait", {"processId": process})
                assert done["exitCode"] == 0 and done["stopReason"] is None, done
            before = runtime.call("scope.get", {"scopeId": root})["outputBytes"]
            assert before == 2048
            runtime.output(process)
            runtime.output(process)
            assert runtime.call("scope.get", {"scopeId": root})["outputBytes"] == before
            process = runtime.start(scope, "head -c 1536 /dev/zero")
            done = runtime.call("process.wait", {"processId": process})
            assert done["stopReason"] == "outputBytes exceeded", done
            assert runtime.call("scope.get", {"scopeId": root})["outputBytes"] == 3072
            process = runtime.start(scope, "head -c 1024 /dev/zero")
            runtime.call("process.wait", {"processId": process})
            assert runtime.call("scope.get", {"scopeId": root})["outputBytes"] == 4096
            runtime.expect_error(
                "RESOURCE_EXHAUSTED",
                "process.start",
                {
                    "operationId": runtime.op(),
                    "scopeId": scope,
                    "argv": ["/bin/true"],
                    "cwd": "workspace://repo",
                },
            )
            results["processes"] = {
                "singleCap": 1024,
                "cumulativeCap": 4096,
                "used": 4096,
                "repeatedOutputReadCharged": False,
            }
        finally:
            runtime.close()
        source = b"history evidence\n" * (8 * 1024 * 1024 // 17)
        source = source.ljust(8 * 1024 * 1024, b"x")
        (Path(directory) / "history.bin").write_bytes(source)
        runtime = smoke.Runtime(
            binary,
            Path(directory),
            [
                "--sandbox-profile",
                args.sandbox_profile,
                "--output-bytes",
                "1024",
                "--cumulative-output-bytes",
                "4096",
            ],
        )
        try:
            runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
            root = runtime.info["rootScopeId"]
            scope = runtime.scope()
            digest = hashlib.sha256(source).hexdigest()
            restored = bytearray()
            pages = 0
            while len(restored) < len(source):
                value = runtime.call(
                    "fs.execute",
                    {
                        "operationId": runtime.op(),
                        "scopeId": scope,
                        "command": {
                            "kind": "readForHistory",
                            "path": "workspace://repo/history.bin",
                            "offset": len(restored),
                            "maxBytes": 65536,
                        },
                    },
                )
                assert value["sha256"] == digest and value["size"] == len(source), value
                chunk = base64.b64decode(value["dataBase64"], validate=True)
                assert chunk and len(chunk) <= 65536
                restored.extend(chunk)
                assert value["nextOffset"] == len(restored)
                pages += 1
            assert bytes(restored) == source
            assert value["eof"] is True
            assert runtime.call("scope.get", {"scopeId": root})["outputBytes"] == 0
            assert runtime.call("scope.get", {"scopeId": scope})["outputBytes"] == 0
            runtime.expect_error(
                "INVALID_ARGUMENT",
                "fs.execute",
                {
                    "operationId": runtime.op(),
                    "scopeId": scope,
                    "command": {
                        "kind": "readForHistory",
                        "path": "workspace://repo/../outside",
                        "offset": 0,
                        "maxBytes": 16,
                    },
                },
            )
            direct = runtime.call(
                "process.start",
                {
                    "operationId": runtime.op(),
                    "scopeId": scope,
                    "argv": [
                        str(args.bin_dir.resolve() / "areal-runtime-fs"),
                        json.dumps(
                            {
                                "root": str(Path(directory).resolve()),
                                "command": {
                                    "kind": "readForHistory",
                                    "path": "history.bin",
                                    "offset": 0,
                                    "maxBytes": 65536,
                                },
                            }
                        ),
                    ],
                    "cwd": "workspace://repo",
                },
            )["processId"]
            done = runtime.call("process.wait", {"processId": direct})
            assert done["stopReason"] == "outputBytes exceeded", done
            assert runtime.call("scope.get", {"scopeId": root})["outputBytes"] == 1024
            process = runtime.start(scope, "head -c 1536 /dev/zero")
            done = runtime.call("process.wait", {"processId": process})
            assert done["stopReason"] == "outputBytes exceeded", done
            assert runtime.call("scope.get", {"scopeId": root})["outputBytes"] == 2048
            results["historyEvidence"] = {
                "sourceBytes": len(source),
                "pages": pages,
                "exactBytesRestored": True,
                "commandBudgetCharged": False,
                "ordinaryCommandLimitPreserved": True,
                "traversalRejected": True,
                "helperArgvCannotBypassQuota": True,
            }
        finally:
            runtime.close()
        (Path(directory) / "data.bin").write_bytes(b"x" * 6144)
        runtime = smoke.Runtime(
            binary,
            Path(directory),
            [
                "--sandbox-profile",
                args.sandbox_profile,
                "--output-bytes",
                "32768",
                "--cumulative-output-bytes",
                "262144",
            ],
        )
        try:
            runtime.info = runtime.call("connection.open", {"protocolVersion": "areal.runtime.v0"})
            root = runtime.info["rootScopeId"]
            scope = runtime.scope()
            request = {
                "operationId": runtime.op(),
                "scopeId": scope,
                "command": {
                    "kind": "read",
                    "path": "workspace://repo/data.bin",
                    "offset": 0,
                    "maxBytes": 6144,
                },
            }
            runtime.call("fs.execute", request)
            first = runtime.call("scope.get", {"scopeId": root})["outputBytes"]
            runtime.call("fs.execute", request)
            assert runtime.call("scope.get", {"scopeId": root})["outputBytes"] == first
            request["operationId"] = runtime.op()
            runtime.call("fs.execute", request)
            assert runtime.call("scope.get", {"scopeId": root})["outputBytes"] == 2 * first
            assert first > 8192, first
            results["fileHelpers"] = {
                "sourceBytes": 6144,
                "oneReadOutputBytes": first,
                "sameOperationReplayCharged": False,
                "secondNewReadOutputBytes": first,
            }
        finally:
            runtime.close()
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
