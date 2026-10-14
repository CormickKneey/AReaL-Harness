[中文](permissions.md) | **English**

# Permission architecture proposal

Status: proposed, awaiting review, not implemented. Code baseline: `a78bce5`, inspected on 2026-10-13. Current behavior remains defined by [permission configuration](../guides/configuration.en.md#permission-modes) and the [Runtime contract](../api/runtime.en.md); see [architecture](architecture.en.md) for ownership.

**Let the agent complete ordinary work autonomously inside a restricted environment, requesting confirmation when it needs additional capabilities or an explicit approval rule applies.** Preserve approvals, remembered grants and Runtime Scopes. Add a safe automatic execution preset and a Core permission broker that turns approval into enforceable execution permissions.

Users should understand three things: **what is accessible now, why confirmation is needed, and exactly what approval adds.** They should not need to understand Scope trees, and the model should not need to predict every side effect of arbitrary scripts.

## Existing foundations and actual gaps

The supplied research points in the right direction, but parts of the current implementation are more complete than it describes.

| Verified behavior | Design implication |
|---|---|
| Core defaults to `YOLO` for approval. The product launcher separately defaults to `full-access`; the standalone Runtime daemon defaults to `native`. | Separate prompting from execution isolation. Changing only one default is insufficient. |
| Core has tool rules, exact-argument approval memory, expiration and cancellation checks. ASK also distinguishes workspace and host paths for built-in reads. | Retain this system. The gaps are general command rules and capability grants, rather than a complete absence of resource checks. |
| Plan/readOnly narrows Runtime reads to the workspace and task scratch, permits writes at most to task scratch, denies networking and restricts external Host calls. | Planning already has execution constraints. Preserve a read-only user workspace with controlled temporary output. |
| Runtime enforces configured `read_only_paths` in its file helper and OS sandbox. There is no general default policy protecting `.git/.agents/.codex`. | Extend existing protection, distinguishing write protection from denying reads. |
| Ordinary tools reuse an active Turn Scope. Plugin operations through the Broker already have per-call child Scopes; Browser already prepares, approves and revalidates operations. | Generalize existing binding and lifecycle mechanisms. Approval-backed capability expansion is the new part. |
| Plan is already a separate GUI state. The approval menu says “请求审批 / 帮我审批” (“request approval / approve for me”). Ask/Auto change additional approval requirements; there is no corresponding automatic reviewer. | Keep the interaction structure, correct the labels and show effective permissions. |

Sources: [Core permissions](../../core/engine/src/permissions.rs), [approval lifecycle](../../core/engine/src/desktop/interactions.rs), [Turn permissions](../../core/engine/src/desktop/state.rs), [tool dispatch](../../core/engine/src/tools/extensions.rs), [Plugin Scopes](../../core/engine/src/tools/plugin_execution.rs), [Runtime deployment](../guides/runtime.en.md), and the [GUI menu](../../clients/gui/renderer/src/ComposerPermissionMenu.tsx).

The useful Codex principle is the separation of sandboxing and approvals: the sandbox limits technical access, while approval policy determines when confirmation is required. Official documentation treats them as independent controls. This proposal adopts that principle within AReaL's existing Core/Runtime ownership. [Official OpenAI documentation](https://learn.chatgpt.com/docs/agent-approvals-security)

## One decision model, two questions

Every operation must answer two questions:

1. **May this operation start?** Tool rules, command rules and user approval answer this.
2. **What may it access while running?** File, network and external-service permissions answer this, enforced by the actual executor.

For example, an allow rule for `npm run build` can remove a confirmation without widening its Scope. A later change to the build script cannot thereby gain writes outside the workspace or networking. Ordinary workspace files can still be changed incorrectly; sandboxing does not replace code review or acceptance of results.

Three concepts must remain distinct:

| Concept | Meaning | Example |
|---|---|---|
| Hard ceiling | Constraints ordinary approval and remembered grants cannot override | Deployment networking denial, a read-only Profile, a parent's tool prohibition, protection of trusted control data |
| Base permissions | Capabilities available without an additional request | Ordinary workspace files, task scratch, networking off by default |
| Additional grant | Explicitly approved capabilities within the hard ceiling | Writing to a specified export directory for one operation, or temporary networking |

**Effective permissions = (base permissions ∪ operation grants) ∩ deployment ceiling ∩ mandatory Profile and parent-task restrictions.** Explicit denials retain priority. Permission to start cannot override a disabled tool.

“Networking off by default” may permit a request; “networking forbidden by deployment” must reject it and explain that this session cannot override it. The same distinction applies to paths, read-only tasks and child agents. Additional grants do not automatically pass to child agents: delegation must explicitly carry capabilities within the parent's constraints.

## Ownership

| Owner | Target responsibility |
|---|---|
| Trusted launcher / deployment | Establish the hard ceiling, trusted program and control-data locations, and available isolation mechanisms. |
| Core permission decision | Combine rules, task restrictions and valid grants; return allow, prompt or deny with a reason. Remain inside Core, without a separate permission service. |
| Core Permission Broker | Bind approved capabilities to an operation, create a restricted execution Scope, and own expiry, cancellation and cleanup. Agents and tool Hosts never receive arbitrary minting authority under a broad root. |
| Existing Interaction / Store | Present and record approvals, validate responses, and retain grant memory and operation outcomes. Reuse existing history. |
| Runtime / tool Host | Runtime enforces local file and process boundaries; external Hosts enforce the capabilities they promise. Unsupported constraints must be reported explicitly. |
| GUI / CLI / Remote | Submit intent and display Core's effective permissions and approval requests. UI labels and remote project access cannot enlarge execution permissions. |

Decision semantics and authorization evidence are shared. Remote MCP deletion, Browser actions and local file access still have distinct enforcement boundaries. There is no need to build a capability framework covering every hypothetical future tool first.

## How an escalation should work

Consider generating a report and exporting it to a specified directory outside the workspace, using a file tool whose destination can be determined:

1. The agent reads the project and generates the report inside its base Scope without interrupting the user.
2. Export requires additional permission. Core checks the final tool arguments and destination against hard prohibitions, then requests permission to write that directory for this operation. If a Hook changed the arguments, approval binds the resulting operation.
3. The user sees the operation, destination, additional capability and lifetime. Approval does not disable sandboxing or upgrade the whole session.
4. Core revalidates task activity, arguments and policy, then issues an Operation Scope containing necessary base capabilities and the approved addition. Runtime checks and executes it. Other paths remain unwritable and networking remains disabled.
5. Once the operation and its managed resources finish, the Scope closes. History records the actual boundary, outcome and cleanup state. Subsequent operations use base permissions.

Preserve the rule that child Scopes can only narrow their parent. For escalation, trusted Core creates another restricted operation Scope under the deployment ceiling and reapplies the original task restrictions. **Even if this Scope is a sibling of the base Scope, it must remain subject to the original Turn's cancellation, aggregate budget, concurrency limits and cleanup.** Changing the parent must not bypass task constraints.

The current native root Scope grants resource access only to the workspace and scratch; creating a child cannot add other directories. Authorizing additional paths requires separating the deployment's grantable paths from unsandboxed execution; adding a prompt alone is insufficient.

Authorization must bind the actual operation, destination scope, executor and lifetime, with revalidation before execution. The capabilities needed by an arbitrary script cannot always be inferred in advance; escalation must follow an explicit request or a trusted denial diagnosis. A model's claim that an operation is read-only or safe is insufficient.

### Approval, retry and revocation

Existing exact-call memory answers whether an identical call needs another prompt. A capability grant answers what execution may access. Neither substitutes for the other, and old command approvals must not become directory-wide or networking grants automatically.

Initially, additional grants cover one operation, including its managed process lifetime rather than only the tool response. Later session/project reuse should retain scoped authorization rules, revalidate each use and issue a fresh Scope, rather than persist a broad live Scope. Explicit ask rules and forced approval remain non-bypassable by memory. MCP without a verifiable connection generation continues to support only one-time approval.

Cancellation, expiry or identity changes prevent unsubmitted work from starting. Submitted work follows cancellation and cleanup, preserving UNKNOWN if the outcome or cleanup is uncertain rather than claiming side effects were reversed. A permission error does not prove nothing ran: a compound command may have partially succeeded. Approval must not automatically replay the whole command. Recovery neither replays unknown operations nor restores one-time capabilities.

Clearing remembered grants keeps its current meaning: stop future reuse, currently requiring an idle Thread. Stopping an operation already using a grant requires cancellation and cleanup; effects accepted by a remote service cannot be guaranteed reversible. When no approver is available, return the required permission explicitly rather than allowing execution.

## The automatic execution preset

Safe Auto is the design name for restricted automatic execution. The product should display working style separately from actual access. Keep Plan as a separate control; prefer “ask before execution / execute automatically” over a label suggesting an automatic reviewer.

| Working style | Target behavior |
|---|---|
| Plan | Preserve workspace read-only access, writable task scratch, disabled Runtime networking and external Host restrictions. Approving a plan cannot remove a mandatory read-only Profile. |
| Ask before execution | Use restricted base permissions. Known reads need no prompt; edits, commands and external actions retain existing Ask semantics. Approval preserves the same resource boundary. |
| Execute automatically | Use the same restricted base permissions. Ordinary edits and local commands run automatically; explicit prompt rules and capability expansion request approval. |

Full Access is a separate, advanced deployment choice. Its wider effective access must be displayed clearly; explicit denials, Profiles and task restrictions still apply.

Base permissions cover ordinary workspace files, task-specific scratch and the read-only system/toolchain paths required to run tools. Command networking is off by default. Do not expose all of HOME or inject model credentials into commands. Sensitive content already in the workspace is not automatically identified; finer file-read denial rules are a later capability.

Protection has two categories. Trusted Core/Runtime programs, authorization records and permission configuration form a control plane that ordinary tools cannot modify. Repository metadata such as `.git`, `.agents` and `.codex` is write-restricted by default. Normal Git work must remain possible through explicit necessary metadata permissions, preserving protections for control configuration and hooks rather than opening all repository administration data because `git commit` was allowed. Existing read-only directory protection lacks the full exception semantics needed here and must be extended.

Protection must cover file tools and arbitrary scripts, account for actual paths, links and renames, and go beyond string-prefix checks. Project files cannot approve themselves, change hard ceilings or write grant storage. Project declarations take effect only within a scope confirmed by a trusted user.

Core should report the actual executor boundary, permission sources, additional grants and rejection reasons. Reuse `permission_read` and Runtime capability projections, but the existing deployment-level `sandbox` field cannot describe every Turn or tool. GUI should be able to show “workspace writable · network off · external tools authorized separately,” with an explanation in details.

## Command, network and external-tool choices

**Command rules reduce unnecessary prompts without granting resources.** Initially support argument-prefix allow, prompt and deny rules, with denial taking priority. Evaluate each part of `git status && git push`. Command substitution, redirection and interpreter wrappers that cannot be reliably analyzed must not inherit exemption from a harmless prefix. In Auto, ordinary unmatched commands may execute within the sandbox; uncertain compound expressions conservatively prompt. Command rules cannot override existing forced approvals.

These rules do not claim to detect deletion or publication inside arbitrary scripts. Allowing Python cannot establish that a Python program is safe. A promise that all publication requires approval also needs enforcement at the destination service or network boundary.

**Initially, network permissions remain explicitly coarse.** Where deployment permits it, an operation may receive temporary networking, but the UI must say that this grants network access to that process and its descendants, is not limited to the domain in the request's justification, and may include private networks. File restrictions remain intact. A promise such as “package registry only” requires real egress enforcement against direct connections, name-resolution bypass and private destinations. A domain list alone is insufficient.

**External Hosts require separate trust.** Core, Plugin Node Hosts and stdio MCP are outside Runtime's sandbox; ordinary Browser loading also has its own network boundary. Safe Auto promises apply to controlled execution paths, not automatically to model requests, MCP or Browser. Reuse existing Browser operation binding and approval. Hosts without established trust or the required enforcement cannot run automatically merely because they claim to be read-only. Trusted-user-enabled Hosts follow tool-risk approval with their host privileges made clear. Actual Host sandboxing is needed before supporting untrusted plugins as isolated execution.

## Delivery order

| Stage | Outcome | Gate |
|---|---|---|
| First: optional Safe Auto workflow | Restricted base permissions, protected paths, command rules, one-operation directory/network grants and Core explanations, reusing approval and Scope lifecycles. | Ordinary development succeeds, out-of-scope effects are blocked, cancellation and uncertainty do not cause replay, and external Host coverage is explicit. |
| Second: broader default adoption | Enable for new installations first; improve destination-based networking, file-read denial, reusable capability grants and external-tool risk policy. | Every UI promise has enforcement. Existing deployments migrate explicitly without weakening mandatory restrictions. |
| Later, as needed | Automatic approval review, organizational policy management, rule suggestions and further platform isolation. | Stabilize deterministic boundaries before optimizing approval cost. |

The first complete acceptance journey is: edit workspace files, run local tests, request one additional export directory, verify other directories remain blocked, then finish and clean up. Network grants use the same binding and lifecycle with separate validation. This verifies authorization against real execution before adding destination proxies or automated reviewers.

Before changing defaults, verify Git, Node, Python, Cargo, common test tools and their cache/temporary paths. Missing sandbox support or unauthorized toolchain paths must produce clear diagnostics, retaining the existing no-silent-fallback behavior. Trusted programs, control data and grant storage must remain outside agent-writable paths. Deployment changes affect shared-service compatibility and restart; a GUI label cannot change an active task's sandbox. Existing Full Access deployments retain an accurate label and migrate explicitly.

Reuse the [permission smoke suite](../../scripts/permission-modes-smoke.mjs) and Runtime checks, adding real side-effect assertions: ordinary source writes succeed; outside and protected writes fail; one safe segment cannot exempt the remainder of a command; one-time grants cannot be reused or widened; approval after cancellation cannot start execution; child agents cannot exceed mandatory parent restrictions; trusted external Hosts are not presented as sandboxed. Also verify no silent Full Access fallback and no automatic retry of submitted operations with unknown outcomes.

Safety acceptance checks actual file, network and process results. Usability acceptance measures representative task completion, approval counts and added time. Documentation inspection is not evidence that these runtime scenarios have passed.

The proposal prioritizes three product choices: restricted automatic execution as the target default for new installations, sandbox preservation for command allow rules, and one-operation escalation by default. This requires toolchain compatibility, trusted control-plane protection and grant lifecycle work first; the benefit is fewer interruptions during ordinary development and understandable, enforceable escalation.
