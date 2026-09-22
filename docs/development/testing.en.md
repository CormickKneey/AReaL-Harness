[中文](testing.md) | **English**

# Testing

Install dependencies using the [development guide](README.en.md). Regular tests use temporary directories, dynamic loopback ports and deterministic models without real model credentials.

| Entry point | Coverage |
|---|---|
| `make verify` | Cordis pin, formatting, static checks, Rust workspace, both SDKs, Python, documentation and TUI smoke |
| `make script-test` | Launcher, Web reasoning/wait/cancel projections, benchmark statistics/evidence and documentation links/language pairs |
| `make test-core` / `make test-protocol` | Engine / app-server |
| `make test-concurrency` | Concurrency primitives |
| `make verify-runtime` | Runtime unit tests and real file, process, permission and shutdown smoke |
| `make verify-harness` | verify followed by Runtime, complete Harness, desktop API and Workgroup smoke |
| `make examples-desktop-api` | [Direct API, CLI, Skills and relocated packaged binaries](../examples/desktop-api.en.md) |
| `make workgroup-smoke` | Private Runtime writes, combined verification, command deadlines and failure settlement |

Snapshot format changes require `make verify-harness`: Harness and plugin smoke check the written version, and desktop relocation tests compare the release manifest, `areal/server/status.stateVersion`, and actual snapshot versions.

Native smoke tests require macOS Seatbelt; never substitute unsandboxed execution for a failure. Linux CI uses controlled containers. Default `cargo test` excludes explicitly ignored native Workgroup and capacity cases.

Linux host checks use `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`. Native backend tests require a container boundary; a separate CI job builds the Dockerfile's `runtime-tests` target and runs every backend test inside the controlled Bubblewrap container. Excluding the backend alone does not complete validation.

## Python and scratch

Independent macOS Python/scratch regression (local model, no provider credentials):

```sh
python3 scripts/native-python-smoke.py --bin-dir target/debug
```

`make harness-smoke` (called by `make verify-harness` in macOS CI) includes this regression. It checks automatic scratch and a custom `--scratch` under both default YOLO and the explicit native sandbox: both expose `verify_command` and save verification receipts with exit codes 0 and 7 in a private per-thread directory. Shared resolver tests cover installed CLT without a `developer_dir` link and reject interpreters outside supported frameworks.

`make workgroup-smoke` also verifies that Worker commands receive a writable `TMPDIR` at `.scratch/agent-<threadId>` inside their private workspace, with Python bytecode writes disabled.

## Recovery and research agents

```sh
cargo test --locked -p areal-engine --test truncated_usage --test tool_call_stream --test http_model --test context --test tools --test async_agents --test recovery
python3 -m unittest discover -s scripts/tests
python3 scripts/native-tools-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
python3 scripts/native-agents-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
```

Native tools/agent smoke tests use a local fixed-response HTTP model, the standard launcher and temporary workspaces without external model services. They cover file CAS, search, verification receipts, images, no delegation, a single Worker, synchronous waits, budget failures, parent cancellation and default asynchronous dispatch. The asynchronous case requires parent progress before three Worker requests finish and checks parent/child sampling parameters. Stream tests cover same-frame/tail length usage, EOF/cancellation, no UNKNOWN replay, post-compaction handles and cross-Turn boundaries.

Request-budget tests cover `MAX_MODEL_ROUNDS` classification when Chat Completions or Responses returns tools in the final round, with no tool execution or retries and the original budget audit preserved. Ordinary tool-call budget exhaustion and invalid indices must retain their own classifications. Desktop CLI acceptance also checks the corresponding `error_max_turns` result. Goal HTTP regressions verify that output-token caps and tool count/buffer budgets survive shared pools, while unknown usage from failed requests prevents retries and tool execution.

Linux requires Bubblewrap user/PID namespaces, seccomp, Python, Bash and rg. The public Dockerfile provides the toolchain:

```sh
docker build -f tests/e2e/docker/Dockerfile \
  --build-arg INSTALL_CODEX=0 --build-arg INSTALL_CLAUDE_CODE=0 \
  -t areal-native-smoke .
for smoke in native-tools-smoke native-agents-smoke; do
  docker run --rm --security-opt seccomp=unconfined \
    --security-opt systempaths=unconfined --security-opt apparmor=unconfined \
    --mount "type=bind,source=$PWD,target=/repo,readonly" -w /repo \
    --entrypoint python3 areal-native-smoke \
    "scripts/$smoke.py" --bin-dir /usr/local/bin --sandbox-profile outer-container-perf
done
```

Outer-container relaxations apply only to the explicitly selected controlled profile; commands still run inside Bubblewrap. Docker's default AppArmor policy denies Bubblewrap namespace mounts, so this profile also explicitly relaxes AppArmor; it does not use privileged mode or add capabilities. Ubuntu 24.04+ additionally requires an administrator-provided AppArmor rule allowing `userns` for `/usr/bin/bwrap`; disabling Docker's AppArmor profile alone does not remove this host restriction. CI loads a rule matching only Bubblewrap on its ephemeral runner, then checks namespace and mount support before compilation. macOS `/usr/bin/python3` may access unauthorized Xcode-selector configuration; do not widen the sandbox automatically for smoke tests. TUI reconnect smoke waits for a `live` subscription before submitting: an open connection and visible cached history do not establish an authoritative restored snapshot.

## Capacity

| Command | Load |
|---|---|
| `make capacity-primitives` | Progress and cancellation of 20,000 asynchronous tasks |
| `make capacity-core` | 10,000 child agents with real persistence and controlled model permits |
| `make capacity-workgroup` | 32 real Runtimes, isolated writes and combined checks; requires macOS |

`make capacity` runs these sequentially; regular verification excludes them. Report hardware, build mode, storage and model fixtures. These figures do not measure real LLM throughput.

## CI and contracts

[CI](../../.github/workflows/ci.yml) runs native Harness checks on macOS, portable regression and Docker sandbox/file-ownership checks on Linux, and separate Rust/npm advisory checks. Actions are pinned by commit, repository permissions are read-only, and failures retain logs. Consult the run for the relevant commit for actual results.

Pull requests, pushes to `main`, and manual dispatch run the full checks, avoiding duplicate push and PR runs for feature branches. Linux portable and container checks run in parallel. The existing `Linux checks and container Runtime` check remains as an aggregate gate that requires both jobs to succeed. macOS still runs all of `make verify-harness`.

Host jobs cache Cargo dependency artifacts and npm downloads; Docker uses BuildKit's GitHub Actions layer cache. Cache hits still execute tests. Rust caches are separated by platform, toolchain and dependency manifests. CI disables debug symbols and incremental compilation to reduce artifact size. Only the pinned `cargo-audit` binary is cached; every run still reads advisories and audits the lockfile.

Container behavior checks pass `--build-arg BUILD_PROFILE=ci`, selecting the Cargo `ci` profile inherited from `dev`: debug assertions remain enabled, with debug symbols and incremental compilation disabled. `runtime-tests` uses the same profile to reuse dependency artifacts. The Dockerfile still defaults to `release` with thin LTO; use that default for performance tests. The image label `io.areal.perf.build-profile` records the selected profile. CI images must not be used as release performance measurements.

`make schemas` updates the pinned Codex schema; `make desktop-schemas` updates desktop schemas. Update types, callers and contracts together. Local fixtures do not validate real models, GUIs, third-party daemons, signing/notarization or other platforms. See the [benchmark guide](../benchmarks/README.en.md) for performance runs.

## Goal regression

`cargo test --locked -p areal-engine --test watchdog` checks ordinary network retries alongside Goal unknown-usage constraints, including transport failures, rate limits, service unavailability, interrupted streams, request/stream timeouts and summary failures. Goals avoid retry backoff, retain reservations and the previous checkpoint, and release model permits.

`cargo test --locked -p areal-engine --test goals` covers ordinary Turns without continuation, completion across two Turns, CAS/idempotency, budget exhaustion/editing, unknown reservations, pause/resume, queue priority, child attribution, capacity waiting, active deadlines and restart without replay. `cargo test --locked -p areal-engine goals::budget` covers concurrent reservations, nested Workgroup pools, model replacement and single-charge summary accounting. Configuration tests cover default execution limits, TOML overrides and policy ranges; Goal behavior tests use default Limits.

`node examples/desktop-api/run.mjs goal-mode` uses real Core/Runtime and an HTTP/SSE fixture with generated schema validation, file creation/verification across two Turns, isolated Workgroup accounting, observation permissions, retries, multi-client recovery and headless waiting across Turns. It runs under `make examples-desktop-api`; fixtures do not measure real-model task success.

## Shared local services

`make local-service-smoke` uses temporary directories, real Core/Runtime, two PTYs and an HTTP model fixture. It verifies concurrent ensure, workspace/symlink identity, configuration conflicts, authentication, Web discovery, window exit, busy/cancel stop, persistent history, launcher/host SIGKILL cleanup and reattachment. It is included in `make harness-smoke`. `make desktop-schemas` also exports `schemas/local-service-v1.json`.

The PTY helper continuously drains terminal output while waiting for CLI commands, service shutdown and window exit, preventing terminal backpressure from blocking the TUI. `make script-test` includes a deterministic regression that writes more than the PTY capacity before exiting.

`cargo test --locked -p areal-engine --test model_reload` verifies that active children and queued requests retain their model while new submissions follow the updated default; busy `ifIdle` drain must leave admission open. Local service smoke also covers invalid edits, queue recovery across restart, workspace selectors and idle restart after limits change.
