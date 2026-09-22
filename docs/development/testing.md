**中文** | [English](testing.en.md)

# 测试

依赖安装见[开发指南](README.md)。常规测试使用临时目录、动态 loopback 端口和确定性模型，无需真实模型凭据。

| 入口 | 范围 |
|---|---|
| `make verify` | Cordis pin、格式、静态检查、Rust workspace、两套 SDK、Python、文档和 TUI smoke |
| `make script-test` | 启动器、Web 思考/等待/取消投影、perf 统计/证据与文档链接/语言配对 |
| `make test-core` / `make test-protocol` | Engine / app-server |
| `make test-concurrency` | 并发原语 |
| `make verify-runtime` | Runtime 单元测试与真实文件、进程、权限和关闭 smoke |
| `make verify-harness` | verify 后顺序运行 Runtime、完整 Harness、桌面 API 和 Workgroup smoke |
| `make examples-desktop-api` | [直接 API、CLI、Skill 与搬迁打包产物](../examples/desktop-api.md) |
| `make workgroup-smoke` | 独立 Runtime 写入、组合验收、命令期限与失败后结算 |

快照格式变更须运行 `make verify-harness`：Harness 与插件 smoke 核对写入版本，桌面搬迁测试同时核对发行 manifest、`areal/server/status.stateVersion` 与实际快照版本一致。

原生 smoke 需要 macOS Seatbelt，不能用无沙箱执行代替失败。Linux CI 使用受控容器。默认 `cargo test` 不运行显式忽略的原生 Workgroup 和容量用例。

Linux 宿主常规检查使用 `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`。原生后端测试要求容器边界；CI 的独立任务构建 Dockerfile 的 `runtime-tests` 目标，在带 Bubblewrap 的受控容器中实际运行全部后端测试，不能仅排除后就视为完成验收。

## Python 与 scratch

macOS Python/scratch 的独立回归（本地模型，不需要供应商密钥）：

```sh
python3 scripts/native-python-smoke.py --bin-dir target/debug
```

`make harness-smoke`（由 macOS CI 的 `make verify-harness` 调用）包含此回归。共享解析器测试覆盖已安装 CLT 但无 `developer_dir` 链接的发现路径，并验证 framework 外的解释器被拒绝。

## 恢复与研究 Agent

```sh
cargo test --locked -p areal-engine --test truncated_usage --test tool_call_stream --test http_model --test context --test tools --test async_agents --test recovery
python3 -m unittest discover -s scripts/tests
python3 scripts/native-tools-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
python3 scripts/native-agents-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
```

原生工具/Agent smoke 使用本地固定响应 HTTP 模型、统一 launcher 与临时工作区，无需外部模型。覆盖文件 CAS、搜索、验证 receipt、图像，以及不委派、单 Worker、同步等待、预算失败、父取消和默认异步；异步用例要求三个 Worker 请求结束前父任务继续推进，并检查主/子采样参数。流测试覆盖 length 同帧/尾帧 usage、EOF/取消、不重放 UNKNOWN、压缩后句柄与跨 Turn 边界。

请求预算测试覆盖 Chat Completions 与 Responses 在最后一轮返回工具时的 `MAX_MODEL_ROUNDS` 分类，并检查零工具执行、无重试和原始预算审计；普通工具调用预算耗尽及非法 `index` 不应被误分类。桌面 CLI 验收同时检查对应的 `error_max_turns` 结果。Goal HTTP 回归同时验证输出 token 上限与工具数量/缓冲预算经过共享池后仍生效，失败请求的未知消费阻止后续重试和工具执行。

Linux 需要 Bubblewrap user/PID namespace、seccomp，以及 Python、Bash、rg。也可用公开 Dockerfile：

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

外层容器放宽项仅适用于显式选择的受控 profile，命令仍在 Bubblewrap 内执行。Docker 默认 AppArmor 会拒绝 Bubblewrap 的 namespace 挂载，因此此 profile 同时显式放宽 AppArmor；不使用 privileged 或增加 capability。Ubuntu 24.04+ 还需由管理员为 `/usr/bin/bwrap` 配置允许 `userns` 的 AppArmor 规则；仅取消 Docker 的 AppArmor profile 不会解除宿主的此项限制。CI 在临时 runner 上加载仅匹配 Bubblewrap 的规则，并在编译前预检 namespace 与挂载能力。macOS 的 `/usr/bin/python3` 可能经 Xcode 选择器读取未授权配置，不应为 smoke 自动扩大沙箱权限。TUI 重连 smoke 等待 `live` 订阅后再提交，连接和历史缓存可见不代表权威快照已恢复。

## 容量

| 命令 | 负载 |
|---|---|
| `make capacity-primitives` | 20,000 个异步任务的推进与取消 |
| `make capacity-core` | 10,000 个子 Agent、实际持久化与受控模型许可 |
| `make capacity-workgroup` | 32 个真实 Runtime、独立写入与组合检查，需 macOS |

`make capacity` 顺序执行，默认 verify 不包含容量测试。结果须注明硬件、构建模式、存储和模型替身，不能当作真实 LLM 吞吐。

## CI 与契约

[CI](../../.github/workflows/ci.yml) 在 macOS 执行原生 Harness，在 Linux 执行常规回归和 Docker sandbox/文件所有权检查，独立检查 Rust/npm 依赖公告。工作流固定 action commit、使用只读权限并保留失败日志；是否通过以对应提交的运行结果为准。

PR、`main` 推送和手动触发运行完整检查，避免同一功能分支的 push 与 PR 重复运行。Linux 常规回归与容器检查并行；原 `Linux checks and container Runtime` 检查名保留为汇总门禁，两项均成功才通过。macOS 仍完整运行 `make verify-harness`。

宿主缓存 Cargo 依赖产物和 npm 下载，Docker 使用 BuildKit 的 GitHub Actions 层缓存；缓存命中仍执行测试。Rust 缓存按平台、工具链与依赖清单区分，CI 关闭调试符号和增量编译以缩小构建产物。`cargo-audit` 只缓存固定版本工具，每次仍读取公告并审计锁文件。

容器行为检查传入 `--build-arg BUILD_PROFILE=ci`，使用继承 `dev` 的 Cargo `ci` profile，保留调试断言，关闭调试符号和增量编译。`runtime-tests` 同样使用该 profile，复用依赖产物。Dockerfile 默认仍为 `release`（含 thin LTO），性能测试应使用默认构建；镜像标签 `io.areal.perf.build-profile` 标明实际 profile。CI 镜像不能用作 release 性能数据。

`make schemas` 更新固定 Codex schema，`make desktop-schemas` 更新桌面 schema；同时维护类型、调用方与契约。真实模型、GUI、第三方 daemon、签名/公证和其他平台不由本地 fixture 代替验收。性能测试见[基准指南](../benchmarks/README.md)。

## Goal 回归

`cargo test --locked -p areal-engine --test watchdog` 同时验证普通请求的网络重试与 Goal 的未知用量约束，覆盖传输失败、限流、服务不可用、断流、请求/流超时和摘要失败；Goal 不进入重试退避，保留预算预留及旧 checkpoint，并释放模型许可。

`cargo test --locked -p areal-engine --test goals` 验证普通 Turn 不续轮、两轮完成、CAS/幂等、预算耗尽与编辑、未知用量预留、暂停恢复、用户队列优先、子任务归因、容量等待、活动期限以及重启不重放。`cargo test --locked -p areal-engine goals::budget` 验证并发预留、嵌套 Workgroup 模型池、模型替换和 Summary 的单次计量。配置回归覆盖默认执行限制、TOML 覆盖与策略范围；Goal 行为测试使用默认 Limits。

`node examples/desktop-api/run.mjs goal-mode` 使用真实 Core/Runtime 与 HTTP/SSE fixture，通过生成 schema 验证 Goal API、两次 Turn 的文件创建/验证、隔离 Workgroup 共享计量、观察权限、重复请求、多客户端恢复和 headless 跨 Turn 等待；已纳入 `make examples-desktop-api`。它不替代真实模型的任务成功率评估。

## 共享本地服务

`make local-service-smoke` 使用临时目录、真实 Core/Runtime、两个 PTY 和 HTTP 模型 fixture，验证并发 ensure、工作区/符号链接身份、配置冲突、认证、Web 发现、窗口退出、忙碌拒绝停止/显式取消、历史保留、launcher/host 强杀清理与重新连接。已纳入 `make harness-smoke`。`make desktop-schemas` 同时导出 `schemas/local-service-v1.json`。

PTY helper 在等待 CLI、服务停止和窗口退出时持续消费终端输出，避免缓冲区背压阻塞 TUI。`make script-test` 包含退出前输出超过 PTY 容量的确定性回归。
