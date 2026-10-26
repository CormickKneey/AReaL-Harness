# D5 文档入口开发集对照

状态为未执行。计划在任何文档搬迁前固定于 `experiment-plan.json`，当前版本化输入见 [plan.json](../../../clients/gui/scripts/fixtures/design-rules-experiment/plan.json)。本协议、driver 和空结果模板不代表 18 次实验已完成。

三项固定任务是设置项、审批卡、资源列表空态。每题三次，收敛前后各一组，共 18 次。题目和验收条件保持不变。每次使用全新 `codex exec --ephemeral` 进程和隔离 checkout，串行执行；启动前由协调者确认有空闲 agent slot。模型为 gpt-6.1-sol，推理强度为 high。

两组使用同一个最终实现提交。driver 在覆盖文档后校验其余受控文件的 SHA-256 相同。文档包包含 Markdown、D5 归档中的 JSON 迁移记录，以及记录各文件 SHA-256 的 `manifest.json`；新增迁移记录也不能出现在 before 组。两组取文档并集，先移除该集合再写入对应版本，因此收敛后的新增入口不会泄入收敛前组。

driver 为两组按各自原文位置重建 catalog 所需旧规则的 owner 映射，并单独保存文档元数据摘要。这一步让共同的最终 catalog 检查能找到旧文档中的 CONV 等定义，不改变可见规则原文。共同实现摘要明确排除 rule-registry 与 document-inventory 两份文档位置元数据。收敛前组只保留其已有的 catalog 规则索引，文档清单也按 before manifest 重建，避免泄露收敛后的新增规则位置。

D5 同时修正了过时的 wip 入口引用，并指向 D4 当前准入合同。实验因而比较整项文档维护结果，不能解释成纯目录结构的因果效果。当前实现与原始文档可能存在时间差，该差异必须随结果报告。

## 执行

先运行 `node clients/gui/scripts/design-rules-experiment.mjs --plan` 检查输入。使用 `--snapshot <新目录>` 冻结当前文档及其摘要。配置形状见 [config.example.json](../../../clients/gui/scripts/fixtures/design-rules-experiment/config.example.json)。配置文件包含精确 `sourceRevision`、`before`、`after`、全新 `output` 目录、`tokenizer` 可执行路径、`tokenizerLabel`、共同的 `setup` 与 `checks` 参数数组。`codex`、`model`、`reasoningEffort` 和 `timeoutMs` 可显式固定。根协调者在最终实现冻结后运行 `--run <config.json>`。

`setup` 在各试验的 `clients/gui` 工作目录执行相同的离线安装、UI 构建与 `design:sync`。后者只规范生成区块，人工文档布局保留组间差异。setup 结束后再次移除该组 manifest 未包含的文档，避免新生成 Token 入口泄入旧组。`checks` 同时包含 `pnpm verify:design` 和 `pnpm test:design`。每项任务先跑基线，再交给 agent，最后重跑相同检查。首次设置失败保留完整日志，不进入任务，也不从结果中消失。

Tokenizer 通过 stdin 接收完整文档，只向 stdout 输出非负整数。固定同一种 tokenizer 与版本。若使用 `o200k_base` 等近似编码，明确记录为 token 代理指标，不能冒充模型内部精确 token 占用。未取得计数时记录缺失，不用字节除以四填数。

编码 agent 通过 `design-rules-read.mjs` 读取设计 Markdown。该工具记录每次读取的路径、原文字节、摘要和 token 数。报告同时列出唯一文档数、读取次数与累计文档 token 数。重复读取会重复计入累计量，这不是任一时刻的上下文占用。

## 证据与评审

每次保留源码提交、共同代码摘要、文档组、题目、完整 argv、受控环境变量、运行版本、agent JSONL、stderr、检查前后退出状态、原始日志、已跟踪 diff、未跟踪新文件、文档读取账本和待评审结果。证据不导出凭据或整个进程环境。

最终实现中的 D5 校验会使原始文档组出现预先存在的编号或元数据失败。报告逐项保留该结果；任务新增失败与预先存在失败分开。失败、超时和读取协议偏离均保留，不选择性重跑或删样本。

独立评审按固定验收条件检查 diff 和实际预览，对每项违反记录规则 ID、文件位置、证据和严重程度。还需核对 JSONL 中是否存在绕过读取工具的设计文档访问。评审完成前 `violations` 保持 null，不填零。汇总保留所有有利和不利结果，归纳 H1 是否受到支持；三题开发集不能代表模型整体能力。结论由人判断。
