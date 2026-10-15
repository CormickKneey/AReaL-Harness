"""对照现有 launcher 生命周期用例验证产品 Rust 入口。"""

import os
import json
import subprocess
import sys
import fcntl
import pty
import select
import termios
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
import test_launcher_lifecycle as legacy


class RustLauncherTests(legacy.LauncherTests):
    def setUp(self):
        super().setUp()
        executable = Path(
            os.environ.get(
                "AREAL_TEST_BIN", Path(__file__).resolve().parents[2] / "target/debug/areal"
            )
        )
        if not executable.is_file():
            self.fail(f"missing launcher binary: {executable}; run make build first")
        self.command = [str(executable), "launcher", *self.command[2:]]
        # Rust launcher 只给自己创建的最终 TUI 标记本地队列检查来源。
        self.fixture(
            "interactive",
            """
assert sys.argv[1] == '--local-trajectory-monitor'
assert sys.argv[2:4] == ['--endpoint', 'ws://127.0.0.1:12345']
assert sys.argv[4:6] == ['--auth-file', '/fixture/auth.json']
assert sys.argv[6:] == ['--resume=thread-id', '--prompt=-hello with spaces']
print('fixture reply')
""",
        )

    def test_owned_tui_preserves_native_parent_foreground_and_terminal_restore(self):
        for exit_code in [0, 3]:
            with self.subTest(exit_code=exit_code):
                self.check_owned_terminal(exit_code)

    def check_owned_terminal(self, exit_code):
        report = self.root / f"terminal-owner-{exit_code}.json"
        restored = self.root / f"terminal-restored-{exit_code}"
        self.fixture(
            "interactive",
            f"""
import subprocess
if sys.platform == 'darwin':
    parent = subprocess.check_output(['/bin/ps', '-p', str(os.getppid()), '-o', 'comm='], text=True).strip()
    assert 'python' in Path(parent).name.lower(), parent
assert os.getpgrp() == os.tcgetpgrp(0), 'TUI is outside the terminal foreground group'
print('terminal-ready', flush=True)
assert sys.stdin.readline() == 'terminal-fixture\\n'
Path({str(report)!r}).write_text(json.dumps({{'pid':os.getpid(),'parent':os.getppid(),'group':os.getpgrp()}}))
sys.exit({exit_code})
""",
        )
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)

        def own_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        wrapper = f"""
import os,subprocess,sys,termios
from pathlib import Path
foreground = os.tcgetpgrp(0)
result = subprocess.call(sys.argv[1:])
assert os.tcgetpgrp(0) == foreground, 'launcher did not restore terminal foreground ownership'
assert termios.tcgetattr(0)[3] & termios.ICANON, 'launcher left terminal in raw mode'
Path({str(restored)!r}).write_text(str(foreground))
sys.exit(result)
"""
        child = subprocess.Popen(
            [sys.executable, "-I", "-S", "-c", wrapper, *self.command],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            preexec_fn=own_terminal,
        )
        self.children.append(child)
        output = bytearray()
        sent = False
        deadline = time.monotonic() + 10
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                output.extend(os.read(master, 65536))
            if not sent and b"terminal-ready" in output:
                os.write(master, b"terminal-fixture\n")
                sent = True
        # launcher 对客户端失败统一返回 1；归还终端必须用独立回执验证。
        self.assertEqual(child.poll(), 0 if exit_code == 0 else 1, output.decode(errors="replace"))
        self.assertTrue(restored.exists(), output.decode(errors="replace"))
        self.assertTrue(sent)
        self.assertTrue(report.exists(), output.decode(errors="replace"))
        self.assert_reaped()

    def test_preflight_reports_exit_status_and_empty_stderr(self):
        dispatcher = self.bin / "areal"
        for body, expected in [
            ("sys.exit(7)", "exit status: 7"),
            ("os.kill(os.getpid(), signal.SIGKILL)", "signal: 9"),
        ]:
            with self.subTest(expected=expected):
                dispatcher.write_text(f"#!{sys.executable}\nimport os, signal, sys\n{body}\n")
                result = subprocess.run(self.command, text=True, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Core configuration failed (", result.stderr)
                self.assertIn(expected, result.stderr)
                self.assertIn("<no stderr>", result.stderr)

    def test_starts_without_python_on_path(self):
        # 测试子进程使用绝对 shebang；此处验证产品 launcher 不查找 Python。
        child = subprocess.Popen(
            self.command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "PATH": "/nonexistent"},
        )
        self.children.append(child)
        out, err = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, err)
        self.assertIn("fixture reply", out)
        self.assert_reaped()

    def test_real_shared_service_without_python_on_path(self):
        executable = Path(self.command[0])
        config = self.root / "empty.toml"
        config.write_text("schema_version = 1\n")
        env = {
            **os.environ,
            "AREAL_HARNESS_HOME": str(self.root / "home"),
            "HOME": str(self.root / "user"),
            "PATH": "/nonexistent",
            "OTEL_SDK_DISABLED": "true",
        }
        base = [str(executable), "service"]
        started = subprocess.run(
            [
                *base,
                "ensure",
                "--json",
                "--workspace",
                str(self.workspace),
                "--config",
                str(config),
            ],
            env=env,
            text=True,
            capture_output=True,
            timeout=90,
        )
        self.assertEqual(started.returncode, 0, started.stderr)
        service = json.loads(started.stdout)
        try:
            self.assertEqual(service["state"], "ready")
            self.assertEqual(service["workspace"], str(self.workspace.resolve()))
        finally:
            stopped = subprocess.run(
                [*base, "stop", "--instance", service["serviceId"], "--cancel", "--json"],
                env=env,
                text=True,
                capture_output=True,
                timeout=60,
            )
            self.assertEqual(stopped.returncode, 0, stopped.stderr)


if __name__ == "__main__":
    import unittest

    unittest.main()
