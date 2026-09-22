const $ = (id) => document.getElementById(id);
let socket,
  thread = null,
  nextId = 0,
  connected = false,
  refreshing = false,
  listCursor = null,
  listing = false;
const pending = new Map();
let goalsSupported = false,
  displayedGoal = null;
const labels = {
  inProgress: "执行中",
  completed: "已完成",
  interrupted: "已停止",
  failed: "执行失败",
};

const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const mobileLayout = matchMedia("(max-width: 700px)");
let theme = "system",
  sidebarCollapsed = false,
  submitting = false;
try {
  theme = localStorage.getItem("areal-web-theme") ?? "system";
} catch {
  // 禁用浏览器存储时仍允许本次页面切换外观。
}
if (!["system", "light", "dark"].includes(theme)) theme = "system";
function applyTheme() {
  document.documentElement.dataset.theme =
    theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme;
  $("theme").value = theme;
}
applyTheme();
systemTheme.addEventListener("change", applyTheme);
$("theme").onchange = () => {
  theme = $("theme").value;
  applyTheme();
  try {
    localStorage.setItem("areal-web-theme", theme);
  } catch {
    // 外观偏好保存失败不影响当前页面。
  }
};
function mobileSidebar(open, restoreFocus = false) {
  document.body.classList.toggle("sidebar-mobile-open", open);
  $("sidebar-backdrop").hidden = !open;
  $("main").inert = open;
  $("sidebar-open").setAttribute("aria-expanded", String(open));
  if (open) $("sidebar-toggle").focus();
  else if (restoreFocus) $("sidebar-open").focus();
}
function updateSidebar() {
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed && !mobileLayout.matches);
  const expanded = mobileLayout.matches || !sidebarCollapsed;
  $("sidebar-toggle").setAttribute("aria-expanded", String(expanded));
  $("sidebar-toggle").setAttribute("aria-label", expanded ? "收起侧栏" : "展开侧栏");
  $("sidebar-toggle").title = expanded ? "收起侧栏" : "展开侧栏";
}
$("sidebar-toggle").onclick = () => {
  if (mobileLayout.matches) mobileSidebar(false, true);
  else {
    sidebarCollapsed = !sidebarCollapsed;
    updateSidebar();
  }
};
$("sidebar-open").onclick = () => mobileSidebar(true);
$("sidebar-backdrop").onclick = () => mobileSidebar(false, true);
mobileLayout.addEventListener("change", () => {
  mobileSidebar(false);
  updateSidebar();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("sidebar-mobile-open"))
    mobileSidebar(false, true);
});
$("settings-open").onclick = () => $("settings-dialog").showModal();
$("settings-close").onclick = () => $("settings-dialog").close();
function showView(groups) {
  $("conversation").hidden = groups;
  $("workgroups").hidden = !groups;
  for (const id of ["history-tab", "groups-tab"]) {
    const selected = (id === "groups-tab") === groups;
    $(id).setAttribute("aria-selected", String(selected));
    $(id).tabIndex = selected ? 0 : -1;
  }
}
$("history-tab").onclick = () => showView(false);
$("groups-tab").onclick = () => showView(true);
for (const id of ["history-tab", "groups-tab"])
  $(id).onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const groups = event.key === "End" || (event.key !== "Home" && id === "history-tab");
    showView(groups);
    $(groups ? "groups-tab" : "history-tab").focus();
  };

function notice(error) {
  $("notice").textContent = error?.message ?? String(error ?? "");
}
function call(method, params) {
  if (!connected) return Promise.reject(Error("连接已断开，请重新加载页面。"));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("响应超时。操作结果可能未知，请刷新任务确认。"));
    }, 20000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function icon(name, className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}
function active() {
  return thread?.turns?.at(-1)?.status === "inProgress";
}
function renderComposer() {
  const hasText = Boolean($("prompt").value.trim());
  $("send").disabled = !connected || !thread || !hasText || submitting;
  const running = active() || thread?.goals?.goal?.status === "active";
  $("send").hidden = running && !hasText;
  const label = active() ? "补充说明" : "发送";
  $("send").setAttribute("aria-label", label);
  $("send").title = label;
  $("interrupt").disabled = !connected || !running;
  $("interrupt").hidden = !running;
}
$("prompt").oninput = renderComposer;
$("prompt").onkeydown = (event) => {
  // 输入法确认候选字不提交任务，Shift + Enter 保留多行输入。
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!$("send").disabled) $("composer").requestSubmit();
  }
};
function render() {
  const cwd = thread?.cwd;
  $("workspace").textContent = cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "工作区";
  $("workspace").title = cwd ?? "工作区";
  const firstMessage = thread?.turns
    ?.flatMap((turn) => turn.items)
    .find((item) => item.type === "userMessage");
  const title =
    thread?.preview || firstMessage?.content.map((part) => part.text ?? "").join(" ") || "新建任务";
  $("task-title").textContent = title;
  $("task-title").title = title;
  const selectedThread = [...$("threads").children].find(
    (button) => button.dataset.id === thread?.id,
  );
  if (selectedThread && firstMessage) {
    selectedThread.querySelector(".thread-title").textContent = title;
    selectedThread.title = title;
  }
  $("status").textContent = labels[thread?.turns?.at(-1)?.status] ?? "就绪";
  $("status").dataset.status = thread?.turns?.at(-1)?.status ?? "idle";
  const empty = !thread?.turns?.length;
  $("main").classList.toggle("is-empty", empty);
  $("welcome").hidden = !empty;
  $("welcome-description").textContent = thread
    ? "描述任务，让想法变成结果。"
    : "新建任务，开始你的工作。";
  $("composer-context").querySelector("span").textContent = cwd ?? "从侧栏新建任务以使用当前工作区";
  $("composer-context").title = cwd ?? "";
  $("new").disabled = !connected;
  $("refresh").disabled = !connected;
  $("groups-refresh").disabled = !connected;
  $("group-start").querySelector("button").disabled = !connected;
  renderComposer();
  renderGoal();
  const history = $("history"),
    atBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 100;
  const opened = new Set(
    [...history.querySelectorAll("details[open]")].map((item) => item.dataset.id),
  );
  history.replaceChildren();
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items) {
      if (item.type === "dynamicToolCall") {
        const unknown =
            item.execution?.outcome === "unknown" ||
            item.execution?.hooks?.some((hook) => hook.outcome === "unknown"),
          card = node("details", undefined, `item tool${unknown ? " unknown" : ""}`);
        card.dataset.id = item.id;
        card.open = opened.has(item.id) || unknown;
        const summary = node("summary");
        summary.append(
          icon("terminal"),
          node(
            "span",
            `${item.tool} · ${unknown ? "结果未知" : (labels[item.status] ?? item.status)}`,
          ),
          icon("chevron", "disclosure-chevron"),
        );
        card.append(summary);
        card.append(node("pre", JSON.stringify(item.arguments, null, 2)));
        for (const content of item.contentItems ?? [])
          if (content.type === "inputText") card.append(node("pre", content.text));
        if (item.execution?.hooks?.length) {
          card.append(node("pre", JSON.stringify(item.execution.hooks, null, 2)));
        }
        if (unknown && !item.execution.inspection) {
          const inspection = node("div", undefined, "inspection"),
            label = node("label", "检查工作区和执行结果后，记录你已确认的情况，再允许继续任务。"),
            input = node("textarea");
          input.maxLength = 1024;
          input.placeholder = "例如：文件已修改一次，测试进程已退出，无需重复执行。";
          input.setAttribute("aria-label", "结果检查说明");
          const acknowledge = node("button", "记录检查结果");
          acknowledge.disabled = active();
          acknowledge.onclick = async () => {
            try {
              await call("areal/tool/acknowledge", {
                threadId: thread.id,
                itemId: item.id,
                inspection: input.value,
              });
              await reload();
              notice("检查结果已记录。可以发送新的任务说明。");
            } catch (error) {
              notice(error);
            }
          };
          inspection.append(label, input, acknowledge);
          card.append(inspection);
        } else if (unknown) {
          card.append(node("pre", `检查记录：${item.execution.inspection}`));
        }
        history.append(card);
      } else if (item.type !== "modelContext") {
        const user = item.type === "userMessage",
          card = node("article", undefined, `item${user ? " user" : ""}`);
        if (user && turn.goal?.origin === "continuation" && item === turn.items[0])
          card.classList.add("continuation");
        card.append(
          node(
            "h3",
            user
              ? turn.goal?.origin === "continuation" && item === turn.items[0]
                ? "自动续轮"
                : "你"
              : "Agent",
          ),
        );
        card.append(
          node(
            "pre",
            user
              ? item.content.map((part) => part.text ?? `[${part.type}]`).join("\n")
              : item.type === "agentMedia"
                ? `[${item.modality}] ${item.media.uri}`
                : (item.text ?? ""),
            "message-text",
          ),
        );
        history.append(card);
      }
    }
    if (turn.status !== "inProgress") {
      const end = node(
        "p",
        `${labels[turn.status]}${turn.error ? ` · ${turn.error.message}` : ""}`,
        "turn-end",
      );
      end.dataset.status = turn.status;
      history.append(end);
    }
  }
  if (atBottom) history.scrollTop = history.scrollHeight;
}
async function list(more = false) {
  if (listing) return;
  listing = true;
  $("more").disabled = true;
  try {
    const result = await call("thread/list", {
      limit: 100,
      ...(more ? { cursor: listCursor } : {}),
    });
    if (!more) $("threads").replaceChildren();
    const existing = new Set([...$("threads").children].map((button) => button.dataset.id));
    for (const item of result.data) {
      if (existing.has(item.id)) continue;
      const button = node("button", undefined, item.id === thread?.id ? "selected" : "");
      button.append(node("span", item.preview || "未命名任务", "thread-title"));
      button.title = item.preview || "未命名任务";
      if (item.id === thread?.id) button.setAttribute("aria-current", "true");
      button.dataset.id = item.id;
      button.onclick = () => select(item.id).catch(notice);
      $("threads").append(button);
    }
    listCursor = result.nextCursor;
    $("more").hidden = !listCursor;
    $("threads-empty").hidden = $("threads").children.length > 0;
    $("threads-empty").textContent = "还没有任务，点击上方新建。";
  } finally {
    listing = false;
    $("more").disabled = false;
  }
}
async function select(id) {
  const result = await call("thread/resume", { threadId: id });
  thread = result.thread;
  $("permission").textContent =
    result.sandbox.type === "workspaceWrite" ? "工作区可写 · 网络关闭" : "只读工作区";
  render();
  showView(false);
  if (mobileLayout.matches) mobileSidebar(false, true);
  for (const button of $("threads").children) {
    button.classList.toggle("selected", button.dataset.id === id);
    if (button.dataset.id === id) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}
async function reload() {
  if (refreshing || !thread) return;
  refreshing = true;
  try {
    const result = await call("thread/resume", { threadId: thread.id });
    thread = result.thread;
    render();
  } finally {
    refreshing = false;
  }
}
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}
function event(message) {
  const p = message.params ?? {};
  if (!thread || p.threadId !== thread.id) return;
  if (message.method.includes("resync") || message.method.includes("lagged")) {
    reload().catch(notice);
    return;
  }
  if (message.method === "areal/goal/updated" || message.method === "areal/goal/cleared") {
    applyGoal(p);
  } else if (message.method === "turn/started" || message.method === "turn/completed") {
    const index = thread.turns.findIndex((turn) => turn.id === p.turn.id);
    if (index === -1) thread.turns.push(p.turn);
    else thread.turns[index] = p.turn;
  } else {
    const turn = thread.turns.find((turn) => turn.id === p.turnId);
    if (!turn) return;
    if (
      message.method === "item/started" ||
      message.method === "item/completed" ||
      message.method === "areal/item/agentMedia/available"
    ) {
      const index = turn.items.findIndex((item) => item.id === p.item.id);
      if (index === -1) turn.items.push(p.item);
      else turn.items[index] = p.item;
    }
    if (message.method === "item/agentMessage/delta") {
      const item = turn.items.find((item) => item.id === p.itemId);
      if (item) item.text += p.delta;
    }
  }
  scheduleRender();
}
$("new").onclick = async () => {
  try {
    const result = await call("thread/start", {});
    thread = result.thread;
    $("permission").textContent =
      result.sandbox.type === "workspaceWrite" ? "工作区可写 · 网络关闭" : "只读工作区";
    notice("");
    render();
    showView(false);
    if (mobileLayout.matches) mobileSidebar(false);
    await list();
    $("prompt").focus();
  } catch (error) {
    notice(error);
  }
};
$("refresh").onclick = async () => {
  try {
    await reload();
    await list();
  } catch (error) {
    notice(error);
  }
};
$("more").onclick = () => list(true).catch(notice);
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  if (!thread || submitting || !connected) return;
  const text = $("prompt").value.trim();
  if (!text) return;
  submitting = true;
  renderComposer();
  try {
    const input = [{ type: "text", text }];
    if (active())
      await call("turn/steer", {
        threadId: thread.id,
        expectedTurnId: thread.turns.at(-1).id,
        input,
      });
    else await call("turn/start", { threadId: thread.id, input });
    $("prompt").value = "";
    notice("");
  } catch (error) {
    notice(error);
  } finally {
    submitting = false;
    renderComposer();
  }
};
$("interrupt").onclick = () => {
  if (thread?.goals?.goal?.status === "active") goalControl("pause").catch(notice);
  else
    call("turn/interrupt", { threadId: thread.id, turnId: thread.turns.at(-1).id }).catch(notice);
};
function applyGoal(view) {
  if (!thread || view.threadId !== thread.id) return;
  if ((view.eventSequence ?? 0) >= (thread.goals?.eventSequence ?? 0))
    thread.goals = { revision: view.revision, eventSequence: view.eventSequence, goal: view.goal };
}
function renderGoal() {
  $("goal-panel").hidden = !goalsSupported || !thread;
  const goal = thread?.goals?.goal;
  const busy = active() || goal?.status === "active";
  const status = {
    active: "执行中",
    paused: "已暂停",
    blocked: "等待处理",
    completed: "已完成",
    budgetLimited: "达到预算",
    failed: "执行失败",
  };
  $("goal-status").textContent = goal
    ? `持续目标 · ${status[goal.status] ?? goal.status}`
    : "持续目标";
  $("goal-progress").textContent = goal
    ? `${goal.objective} · ${goal.usage.tokensUsed} tokens${goal.tokenBudget ? ` / ${goal.tokenBudget}` : ""} · ${Math.round(goal.usage.timeUsedSeconds)} 秒 · ${goal.usage.turnsStarted}/${goal.maxTurns} 轮${goal.reason ? ` · ${goal.reason}` : ""}${goal.usage.accountingComplete ? "" : " · 用量不完整，预留额度保留"}`
    : "设置目标后，Agent 会在轮次结束后继续推进。";
  const key = `${thread?.id}:${goal?.id ?? ""}`;
  if (displayedGoal !== key) {
    displayedGoal = key;
    $("goal-objective").value = goal?.objective ?? "";
    $("goal-budget").value = goal?.tokenBudget ?? "";
  }
  $("goal-save").textContent = goal ? "保存修改" : "开始目标";
  $("goal-save").disabled = !connected || busy || goal?.status === "completed";
  $("goal-pause").disabled = !connected || goal?.status !== "active";
  $("goal-resume").disabled = !connected || !goal || busy || goal.status === "completed";
  $("goal-clear").disabled = !connected || !goal || busy;
}
async function goalControl(action, patch = {}) {
  if (!thread) return;
  const params = {
    threadId: thread.id,
    requestId: crypto.randomUUID(),
    expectedRevision: thread.goals?.revision ?? 0,
    ...patch,
  };
  if (action !== "create") params.goalId = thread.goals.goal.id;
  try {
    applyGoal(await call(`areal/goal/${action}`, params));
    render();
  } catch (error) {
    await reload();
    throw error;
  }
}
$("goal-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await goalControl(thread.goals?.goal ? "update" : "create", {
      objective: $("goal-objective").value,
      tokenBudget: $("goal-budget").value ? Number($("goal-budget").value) : null,
    });
  } catch (error) {
    notice(error);
  }
};
for (const action of ["pause", "resume", "clear"])
  $("goal-" + action).onclick = () => goalControl(action).catch(notice);
async function connect() {
  connected = false;
  for (const request of pending.values()) request.reject(Error("正在重新连接，请重试。"));
  pending.clear();
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  $("connection").textContent = "正在连接…";
  $("connection").dataset.state = "connecting";
  render();
  const url = new URL("/", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(Error("无法连接 Core，请检查服务或在设置中输入访问令牌。"));
    });
  } catch (error) {
    $("connection").textContent = "未连接";
    $("connection").dataset.state = "disconnected";
    throw error;
  }
  connected = true;
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined && data.method) {
      socket.send(
        JSON.stringify({
          id: data.id,
          error: { code: -32601, message: "This client does not implement dynamic tool callbacks" },
        }),
      );
    } else if (data.id !== undefined) {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.error) waiter.reject(Error(data.error.message));
      else waiter.resolve(data.result);
    } else event(data);
  };
  socket.onclose = () => {
    connected = false;
    for (const request of pending.values())
      request.reject(Error("连接已断开。任务可能仍在执行，请重新加载页面。"));
    pending.clear();
    $("connection").textContent = "连接已断开";
    $("connection").dataset.state = "disconnected";
    render();
  };
  await call("initialize", {
    clientInfo: { name: "areal-web", version: "0.1.0" },
  });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  goalsSupported = (await call("areal/capabilities", {})).features?.goals === true;
  $("connection").textContent = "已连接本地 Core";
  $("connection").dataset.state = "connected";
  await list();
  await reload();
  render();
}
$("login").onsubmit = async (event) => {
  event.preventDefault();
  if ($("connect-button").disabled) return;
  $("connect-button").disabled = true;
  $("login-error").textContent = "";
  try {
    const response = await fetch("/areal/auth/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${$("access-token").value}` },
    });
    $("access-token").value = "";
    if (!response.ok) throw Error("认证失败，请使用可信启动器提供的访问令牌。");
    await connect();
    notice("");
    $("settings-dialog").close();
    if (mobileLayout.matches) mobileSidebar(false, true);
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    $("access-token").value = "";
    $("connect-button").disabled = false;
  }
};
connect().catch((error) => {
  notice(error);
  $("settings-dialog").showModal();
});

// Core owns execution across disconnects. Cursor waits avoid busy polling;
// a stopped observer never cancels the actual workgroup.
let groupObservation = 0;
async function showGroup(id, observation) {
  let view = await call("areal/workgroup/read", { id });
  while (observation === groupObservation && connected) {
    const card = node("article", undefined, "item");
    card.append(node("h3", `${view.record.objective} · ${view.record.status}`));
    card.append(
      node(
        "p",
        `并发上限 ${view.record.admission.maxWorkers} · 当前目标 ${view.record.admission.targetWorkers} · 派发峰值 ${view.record.peakWorkers}`,
      ),
    );
    for (const task of view.record.tasks)
      card.append(
        node(
          "p",
          `${task.spec.id}: ${task.status} · 第 ${task.generation} 次执行${task.feedback ? ` · ${task.feedback}` : ""}`,
        ),
      );
    card.append(node("p", `验收结果目录：${view.candidatePath}`));
    if (view.record.error) card.append(node("pre", view.record.error));
    if (view.record.finalCheck) card.append(node("pre", view.record.finalCheck.output));
    if (view.record.status === "running") {
      const cancel = node("button", "停止协同任务");
      cancel.onclick = () => call("areal/workgroup/cancel", { id }).catch(notice);
      card.append(cancel);
      const edit = node("details");
      edit.append(node("summary", "调整尚未开始的任务"));
      const plan = node("textarea");
      plan.rows = 8;
      plan.value = JSON.stringify(
        { objective: view.record.objective, tasks: view.record.tasks.map((t) => t.spec) },
        null,
        2,
      );
      const revise = node("button", "提交计划调整");
      const expectedRevision = view.record.planRevision;
      const requestId = crypto.randomUUID();
      revise.onclick = async () => {
        try {
          await call("areal/workgroup/revise", {
            id,
            requestId,
            expectedRevision,
            plan: JSON.parse(plan.value),
          });
          edit.open = false;
          await showGroup(id, ++groupObservation);
        } catch (error) {
          notice(error);
        }
      };
      edit.append(plan, revise);
      card.append(edit);
    }
    // Keep an expanded edit form stable while its author is typing.
    if (view.record.status !== "running" || !$("groups").querySelector("details[open]"))
      $("groups").replaceChildren(card);
    if (view.record.status !== "running") break;
    view = await call("areal/workgroup/wait", {
      id,
      afterRevision: view.record.revision,
      timeoutMs: 10000,
    });
  }
}
async function listGroups() {
  ++groupObservation;
  const { data } = await call("areal/workgroup/list", {});
  $("groups").replaceChildren();
  if (!data.length)
    $("groups").append(node("p", "暂无协同任务。提交执行计划后可在这里查看进度。", "muted"));
  for (const group of data) {
    const button = node("button", `${group.objective} · ${group.status}`, "secondary");
    button.onclick = () => showGroup(group.id, ++groupObservation).catch(notice);
    $("groups").append(button);
  }
}
$("groups-refresh").onclick = () => listGroups().catch(notice);
$("group-start").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const value = await call("areal/workgroup/start", JSON.parse($("group-plan").value));
    await showGroup(value.id, ++groupObservation);
  } catch (error) {
    notice(error);
  }
};
