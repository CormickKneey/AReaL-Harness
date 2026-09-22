[中文](configuration.md) | **English**

# Configuration

`core/config` resolves startup settings and server injects them into components. User configuration cannot expand Runtime grants. See the [complete example](../../core/config/examples/config.toml) and [configuration source](../../core/config/src/lib.rs).

## Files and precedence

`Explicit CLI > registered environment > selected TOML > defaults`. Default configuration is `~/.areal-harness/config.toml`, with data in its sibling `state/`. `AREAL_HARNESS_HOME` selects a nonempty absolute home. `--config` takes precedence over `AREAL_HARNESS_CONFIG` and replaces, rather than overlays, the default file. Project TOML and `.env` are not discovered automatically.

Shared TUI/Web entry points use a workspace-specific default data directory; explicit dataDir configuration retains the precedence above. See [local services](../api/local-service.en.md) for migration and compatibility.

A missing default file is allowed. A missing explicit file, unknown field, type/version error or explicitly empty value is rejected. Files must be regular UTF-8, at most 1 MiB, with `schema_version=1`. TOML paths resolve against its directory; CLI/env paths resolve against startup cwd. There is no tilde, variable or glob expansion. Malformed lower-priority inputs are rejected even when overridden.

## Models and limits

```toml
schema_version = 1
[server]
listen = "127.0.0.1:4500"
[model]
provider = "example"
name = "your-model-id"
max_retries = 2
[model.providers.example]
protocol = "responses"
endpoint = "https://model.example.com/v1/responses"
api_key_env = "AREAL_API_KEY"
[limits]
model_concurrency = 32
max_threads = 20000
max_active_turns = 256
max_children_per_turn = 64
max_agent_depth = 8
turn_timeout_seconds = 300
stream_idle_timeout_seconds = 30
max_history_bytes = 2097152
max_output_bytes = 262144
max_tool_calls = 128
max_tool_buffer_bytes = 4194304
context_window_bytes = 196608
context_recent_bytes = 65536
context_window_tokens = 0
context_output_reserve_tokens = 0
max_completion_retries = 0
watchdog_disable = false
[logging]
filter = "info"
```

The endpoint is a complete HTTP(S) request URL. Core supports only `chat-completions` / `responses` and appends no path. Configuration stores credential variable names; explicit references must resolve to nonempty HTTP-header-compatible values. Unselected providers need no key. Omitted references mean anonymous access; other applications' credentials are not read.

`reasoning_effort` accepts none/minimal/low/medium/high/xhigh when supported upstream. Optional `max_output_tokens` maps to the protocol-specific field. `max_retries` is 0–8 and controls bounded HTTP retries before stream acceptance for transport failures, HTTP 408/429 and all 5xx statuses. After that allowance is exhausted, the default Core watchdog continues network recovery.

Optional `model.reasoning_summary = "auto"` (also `concise` / `detailed`) is Responses-only and maps to `reasoning.summary`. Its environment variable is `AREAL_HARNESS_REASONING_SUMMARY`. It is omitted by default; no summary parameter is added to Chat Completions or models that have not opted in. The endpoint/model must support the selected summary mode; providers determine whether a summary is returned, so reasoning text is not guaranteed.

Optional sampling fields are omitted when unset and preserve explicit zero. `temperature` is finite [0,2], `top_p` / `min_p` are [0,1], `top_k` is a positive integer or -1, `presence_penalty` is [-2,2], and `repetition_penalty` is positive. Both protocols accept temperature/top_p; the other four are Chat-only and rejected for Responses. Sending a parameter does not prove provider support. Solve and summary requests share sampling/reasoning settings; summaries disable tools and cap output at `min(max_output_tokens,16384)`, or 16384 when unset.

`context_window_tokens=0` disables token estimation; its maximum is 2000000. When enabled, reserve must be below window. Estimated history, system and tool definitions trigger compaction at window minus reserve, or at the byte threshold. Estimates use roughly 3 ASCII bytes/token, 2 tokens/non-ASCII character and media proxies, and may be calibrated upward from prior input usage. Cache hits do not reduce estimates; these are not exact provider tokenizer counts.

The network watchdog is enabled by default with no retry count limit. Set `AREAL_HARNESS_WATCHDOG_DISABLE=1` to disable it; remove the variable or set it to `0` to restore the default. It also accepts `true`/`false`, mapping to TOML `limits.watchdog_disable`; the environment overrides TOML. It covers connection/transport failures, request and stream idle timeouts, premature EOF, HTTP 408/429/5xx and explicit SSE rate-limit/service-availability errors. Solve, child Agent and context-summary requests use the same policy, with exponential backoff from 250 ms capped at 30 seconds. Cancellation, Turn deadlines and explicit Workgroup physical-request budgets remain effective. Authentication, invalid requests, insufficient quota, output length limits and empty answers do not receive unlimited retries.

Goal shared-budget and unknown-usage constraints take precedence over retry settings. Goal requests disable internal HTTP retries; failures or timeouts with unknown usage retain their reservation and stop automatic progress. Neither the watchdog nor finite retry allowances bypass this constraint.

`limits.max_completion_retries` defaults to 0, accepts 0–8, and budgets bounded incomplete-response recovery per Turn separately from HTTP `max_retries` and the network watchdog. Disabling the watchdog preserves existing finite retry allowances. See [Core recovery](../api/core.en.md#recovery). HTTPS uses public roots and the host trust store; install private CAs there. Tools execute only from structured protocol fields, never from XML/JSON in response text.

`limits.max_tool_buffer_bytes` defaults to 4194304 (4 MiB) and must be positive. It bounds the UTF-8 bytes of all buffered tool IDs, names and arguments per response; it excludes reasoning and separate audio/video/image blobs, while media strings embedded in arguments still count as UTF-8 bytes. This is not a process memory limit. It is independent of Turn `max_output_bytes` and history budgets: raising it does not increase execution or persistence allowances. Chat Completions and Responses share this budget; repeated Responses terminal items are not charged twice. Each call still permits at most 64 KiB of arguments. Call count uses the remaining Turn `max_tool_calls` allowance, replacing the fixed 16-call response cap. The environment variable is `AREAL_HARNESS_MAX_TOOL_BUFFER_BYTES`.

Byte and capacity limits are positive integers; fan-out and depth may be 0 to disable delegation. Output must be smaller than history, recent context smaller than the context window, and deadlines 1–86400 seconds. Context bytes are estimates rather than tokenizer windows. Active tasks, model requests and Runtime resources are counted separately.

| Environment suffix (prefix `AREAL_HARNESS_`) | Configuration |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | Model name, provider, complete URL, protocol and credential reference |
| `REASONING_EFFORT`, `REASONING_SUMMARY`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | Model parameters |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | Sampling parameters |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS` | Optional context token budget |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | Server, extensions file and logging |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | Concurrency and task capacity |
| `TURN_TIMEOUT_SECONDS`, `STREAM_IDLE_TIMEOUT_SECONDS` | Deadlines |
| `WATCHDOG_DISABLE` | `limits.watchdog_disable`; `1` disables, default `0` |
| `MAX_HISTORY_BYTES`, `MAX_OUTPUT_BYTES`, `MAX_TOOL_CALLS`, `MAX_TOOL_BUFFER_BYTES`, `CONTEXT_WINDOW_BYTES`, `CONTEXT_RECENT_BYTES` | History, tools and context budgets |

Unknown `AREAL_HARNESS_*` names are errors. Legacy `AREAL_MODEL*` and `RUST_LOG` are lower-priority aliases. Legacy model entry points without a provider file record may use optional `AREAL_API_KEY`; explicit file providers do not inherit it implicitly.

## Diagnostics and runtime catalogs

```sh
target/debug/areal-server config validate --config /absolute/config.toml
target/debug/areal-server config show --sources --config /absolute/config.toml
```

Diagnostics do not listen, create data, start Runtime/MCP/plugins or probe models. They report redacted values and sources. Files are not hot-reloaded; startup credentials are not forwarded to Runtime. Server telemetry handles `OTEL_*` separately.

The desktop runtime provider catalog uses `areal/provider/*` and `AREAL_CREDENTIAL_<ref>`, supporting chatCompletions/responses only. `--desktop-config` installs versioned Profiles/Skills/Workflows. Session settings can change through CAS at idle boundaries and are frozen into new Turns/queue items; see the [desktop contract](../api/desktop.en.md). This is separate from startup TOML loading.

<a id="tui"></a>
## TUI preferences

Use `${XDG_CONFIG_HOME:-~/.config}/areal-harness/tui.toml`, overridden by `--tui-config` / `AREAL_TUI_CONFIG`. Fields are `theme=dark|light|terminal`, `color=auto|always|never`, `no_logo=false`, `ascii=false` and `mouse=true`. Precedence is CLI > `AREAL_TUI_*` > file > defaults. Nonempty `NO_COLOR` disables color. `--prompt` and `--goal` skip this file.

Set `--mouse=false`, `AREAL_TUI_MOUSE=false` or `mouse = false` in this file to disable mouse capture. Mouse capture defaults to enabled; history remains fully operable with the keyboard.

<a id="goals"></a>
## Goal execution policy

Create a Goal explicitly through `/goal <objective>`, the Web panel, `--goal` or the API; no additional toggle is required. The optional TOML below only adjusts execution limits. Omitting the entire `[goals]` table uses defaults.

```toml
[goals]
max_turns = 100
max_active_seconds = 3600
max_unreported_turns = 3
turn_model_rounds = 32
```

The numeric values shown are defaults. The first three numeric fields accept 1–86400; turn_model_rounds accepts 2–1024. Goal maxTurns/maxActiveSeconds can narrow deployment limits; tokenBudget applies only when explicitly set. Root Turns use min(session maxModelRounds, turn_model_rounds), require at least two rounds, and require goal_read/goal_update in any tool allowlist. The final round remains tool-free for handoff. Consecutive root Turns without goal_update pause as progressUnreported at the configured threshold.

Active time includes root-Turn model queuing, execution, tools, interactions and cleanup without adding child durations. Capacity waits between Turns, paused time and offline time are excluded. Existing Turn deadlines and Runtime hard limits still apply. Goal requests disable implicit HTTP retries to preserve per-request accounting; unknown usage stops automatic continuation. See [usage and recovery](clients.en.md#goals).

See [Skills](skills.en.md) for discovery, [tools](tools.en.md) for extensions and [Runtime](runtime.en.md) for deployment permissions.
