"""故障收敛只接受连接拒绝，不能放宽真实终态或隐藏普通状态查询错误。"""

import subprocess
import unittest
from pathlib import Path


HELPER = (Path(__file__).resolve().parents[1] / "local-service-wait.mjs").as_uri()


class LocalServiceWaitTests(unittest.TestCase):
    def run_node(self, body):
        result = subprocess.run(
            [
                "node",
                "--input-type=module",
                "-e",
                f"""import assert from 'node:assert/strict';
import {{ waitForFaultStatus }} from {HELPER!r};
function refused(errno = 61) {{
  return Object.assign(new Error('controlled refusal'), {{
    code: 1, killed: false, signal: null, stdout: '',
    stderr: JSON.stringify({{error: {{code: 'localServiceError',
      message: `Connection refused (os error ${{errno}})`}}}}),
  }});
}}
{body}
""",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_refused_during_cleanup_must_reach_expected_state(self):
        self.run_node("""
const remaining = [];
let calls = 0, refusals = 0;
const result = await waitForFaultStatus(async (budget) => {
  remaining.push(budget);
  calls++;
  if (calls < 3) throw refused(calls === 1 ? 61 : 111);
  return { state: calls === 3 ? 'stopping' : 'stopped', generation: 'same' };
}, 'stopped', { timeoutMs: 2000, onRefused: () => refusals++ });
assert.deepEqual(result, {state: 'stopped', generation: 'same'});
assert.equal(calls, 4);
assert.equal(refusals, 2);
assert(remaining.every((value) => value > 0 && value <= 2000));
assert(remaining[3] < remaining[0]);
""")

    def test_unrecognized_errors_fail_immediately_without_retry(self):
        self.run_node("""
const cases = [
  {stderr: 'Connection refused (os error 61)'},
  {stderr: JSON.stringify({error: {code: 'other', message: 'Connection refused (os error 61)'}})},
  {stderr: JSON.stringify({error: {code: 'localServiceError', message: 'Permission denied (os error 13)'}})},
  {stderr: JSON.stringify({error: {code: 'localServiceError', message: 'invalid service record'}})},
  {code: 2}, {killed: true}, {signal: 'SIGTERM'}, {stdout: 'unexpected output'},
];
for (const fields of cases) {
  const error = Object.assign(refused(), fields);
  let calls = 0, refusals = 0;
  await assert.rejects(waitForFaultStatus(async () => {
    calls++; throw error;
  }, 'stopped', {onRefused: () => refusals++}), (actual) => actual === error);
  assert.equal(calls, 1);
  assert.equal(refusals, 0);
}
""")

    def test_permanent_refusal_wrong_state_and_late_success_fail(self):
        self.run_node("""
for (const query of [
  async () => { throw refused(); },
  async () => ({state: 'unavailable'}),
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {state: 'stopped'};
  },
]) {
  await assert.rejects(
    waitForFaultStatus(query, 'stopped', {timeoutMs: 10}),
    /service did not reach stopped within 10 ms/,
  );
}
""")
