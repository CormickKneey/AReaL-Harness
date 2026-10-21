import { ContextMeter } from "./ContextMeter.js";
import { isOrdinaryConversation, interruptedConversationTurn } from "./ordinaryConversation.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { McpComposerAttachments, useMcpDraft } from "./McpComposerAttachments.js";
import { readMcpDraft, consumeMcpDraft, clearMcpDraft } from "./mcp-app-draft.js";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";
import { shouldSteer } from "./settings/applicationSettings.js";

import { ComposerPermissionMenu } from "./ComposerPermissionMenu.js";
import { canExecutePlan, permissionMode, permissionOptions, planModeOptions } from "./permissions.js";
import { ComposerPlanMode } from "./ComposerPlanMode.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { Button } from "./components/ui/button.js";
import { BACKEND_STATUS_ID } from "./BackendStatusNotice.js";
import { ComposerQueue } from "./ComposerQueue.js";
import { useComposerQueueEdit } from "./useComposerQueueEdit.js";
import { ComposerQueueAttachment } from "./ComposerQueueAttachment.js";
import { AskUserQuestion } from "./AskUserQuestion.js";
import { ApprovalRequest } from "./ApprovalRequest.js";
import { GoalCard, goalControlError } from "./Goal.js";
import { goalContinuationLabel } from "./conversationPresentation.js";
import { GoalIcon as Target, PlanModeIcon as Lightbulb } from "./interfaceIcons.js";
import { FileTree, ArchiveChatIcon, SendMessageIcon, StopIcon, ContinueExecutionIcon, SideChatIcon } from "./interfaceIcons.js";
import { ConversationComposer } from "./ConversationComposer.js";
import { ComposerAttachment, composerInput, composerPaste, isComposerFile, type ComposerDraftAttachment } from "./ComposerAttachments.js";
import { useComposerSkills, composerSkillContent, readComposerSkills } from "./ComposerSkills.js";
import { ComposerMcpIcon } from "./ComposerIcons.js";
import { ComposerMcp } from "./ComposerMcp.js";
import { AttachmentIcon } from "./interfaceIcons.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import { imageAnnotationBlocked, snapshotImageAnnotations, serializeImageAnnotations, useImageAnnotationRevision, type ImageAnnotationTarget } from "./imageAnnotations.js";
import { BrowserAnnotationAttachments } from "./BrowserAnnotationAttachments.js";
import { browserAnnotation, browserAnnotationText, useBrowserAnnotationEditing } from "./browserAnnotations.js";
import { ReviewCommentAttachment } from "./ReviewCommentViews.js";
import { attachedReviewComments, consumeReviewComments, detachReviewComments, recordUnknownReviewSubmission, reconcileReviewSubmission, readReviewComments, reviewCommentKey, reviewCommentText, useReviewComments } from "./reviewComments.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import type { Data, Action } from "./services.js";
// Draft attachments and in-flight UI admission survive task navigation. These are
// unsent client inputs only; Core remains authoritative for acceptance/outcomes.
export const attachmentDrafts = new Map<string, ComposerDraftAttachment[]>();
export const attachmentErrors = new Map<string, string>();
export const sending = new Set<string>();
const sendListeners = new Set<() => void>();
export const subscribeSending = (listener: () => void) => {
  sendListeners.add(listener);
  return () => {
    sendListeners.delete(listener);
  };
};
export const markSending = (key: string, active: boolean) => {
  if (active) sending.add(key);
  else sending.delete(key);
  sendListeners.forEach((listener) => listener());
};
export function Composer({
  project,
  thread,
  action,
  readAction = action,
  onPanel,
  onNew,
  onOpenTask,
  onSide,
  onMcpMention,
  onAnnotate,
  surfaceLayout = "default",
}: {
  surfaceLayout?: "default" | "compact";
  project: Data;
  thread: Data;
  action: Action;
  readAction?: Action;
  onPanel: (name: string) => void;
  onNew: () => void;
  onOpenTask?: (target: { projectId: string; taskId: string; runId: string }) => void;
  onSide?: (draft: string) => void;
  onMcpMention?: () => void;
  onAnnotate?: (target: ImageAnnotationTarget) => void;
}) {
  const prefs = useApplicationPreferences();
  const key = `areal-gui:draft:${project.id}:${thread.id}`;
  const mcpDraft = useMcpDraft(key);
  const reviewKey = reviewCommentKey(project.id, thread.id);
  const reviewDraft = useReviewComments(reviewKey);
  const comments = attachedReviewComments(reviewDraft.draft);
  const api = useRef<LexicalChatInputHandle | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [text, setText] = useState(() => localStorage.getItem(key) ?? "");
  const [goalMode, setGoalMode] = useState(() => localStorage.getItem(`${key}:goal`) === "true");
  const [goalError, setGoalError] = useState("");
  const creatingGoal = goalMode && !thread.goals?.goal;
  const changeGoalMode = (enabled: boolean) => {
    setGoalMode(enabled); setGoalError("");
    if (enabled) localStorage.setItem(`${key}:goal`, "true");
    else localStorage.removeItem(`${key}:goal`);
    api.current?.focus();
  };
  const busy = useSyncExternalStore(subscribeSending, () => sending.has(key));
  const [files, setFiles] = useState<ComposerDraftAttachment[]>(() => attachmentDrafts.get(key) ?? []);
  const input = composerInput(text, files);
  useImageAnnotationRevision();
  const imageEditing = imageAnnotationBlocked(key, input.files);
  const annotationEditing = useBrowserAnnotationEditing(key) || imageEditing;
  const invalidAnnotation = input.files.some(file => browserAnnotation(file)?.comment.trim() === "");
  const [admissionError, setAdmissionError] = useState(() => attachmentErrors.get(key) ?? "");
  useEffect(() => {
    attachmentDrafts.set(key, files);
    window.dispatchEvent(new CustomEvent("areal-attachments-change", { detail: key }));
  }, [key, files]);
  useEffect(() => {
    if (admissionError) attachmentErrors.set(key, admissionError);
    else attachmentErrors.delete(key);
  }, [key, admissionError]);
  const [unknown, setUnknown] = useState<string | null>(() =>
    localStorage.getItem(`${key}:pending`),
  );
  const [deliveryError, setDeliveryError] = useState("");
  const [returnError, setReturnError] = useState("");
  const [returning, setReturning] = useState(false);
  const running = thread.turns?.find((t: Data) => t.status === "inProgress");
  const pending = project.pending.some((p: Data) => p.params?.threadId === thread.id);
  const archived = thread.desktop?.archived;
  const questions = (project.state?.interactions?.[thread.id]?.data ?? [])
    .filter((item: Data) => item.status === "pending" && item.kind !== "approval" && !archived);
  const approvals = (project.state?.interactions?.[thread.id]?.data ?? [])
    .filter((item: Data) => item.status === "pending" && item.kind === "approval" && !archived);
  const hadQuestion = useRef(false);
  useEffect(() => {
    if (hadQuestion.current && !questions.length) api.current?.focus();
    hadQuestion.current = questions.length > 0;
  }, [questions.length]);
  const baseDisabled = !project.state?.connected || archived || busy || pending || !!unknown || !!reviewDraft.error;
  const queueEditor = useComposerQueueEdit({ project, threadId: thread.id, draftKey: key, action, readAction, api, draftFiles: attachmentDrafts,
    setText, setFiles, setGoalMode, annotationBlocked: annotationEditing || invalidAnnotation, inFlight: busy, setInFlight: active => markSending(key, active), uploadFiles: selected => uploadComposerFiles(action, project.id, thread.id, selected) });
  const disabled = baseDisabled || queueEditor.busy || queueEditor.locked;
  const desktopUnsupported = project.desktopCapabilities?.currentCommands === false;
  const stop = () => {
    if (running) void action("stop", { projectId: project.id, threadId: thread.id, turnId: running.id, requestId: crypto.randomUUID() })
      .catch((cause: Error) => setDeliveryError(cause.message));
  };
  const config = project.configurations?.[thread.id];
  const [mcpOpen, setMcpOpen] = useState(false);

  const skills = useComposerSkills({ project, threadId: thread.id, draftKey: key, action: readAction, disabled });
  const taskManagement = config?.options?.appendInstructions?.startsWith("AREAL_TASK_DRAFT_V1\n") === true;
  const ordinary = isOrdinaryConversation(thread, config);
  const interrupted = ordinary && project.core?.features?.ordinaryTurnSubmit === true ? interruptedConversationTurn(thread) : undefined;
  const emptyDraft = !input.text.trim() && !input.files.length && !comments.length && !skills.selected.length && !mcpDraft.length;
  const canContinue = !!interrupted && emptyDraft && !creatingGoal && !queueEditor.edit;
  const planActive = permissionMode(config ?? {}) === "plan";
  const executionPermission = planActive ? permissionMode({ ...config, readOnly: false, options: planModeOptions(false, config?.options) }) : permissionMode(config ?? {});
  const planReady = canExecutePlan(config ?? {}, thread, project.state?.queues?.[thread.id]);
  const clearText = () => {
    api.current?.clear();
    setText("");
    const remaining = files.filter(isComposerFile);
    setFiles(remaining);
    attachmentDrafts.set(key, remaining);
    localStorage.removeItem(key);
  };
  const clear = () => {
    api.current?.clear();
    setText("");
    setFiles([]);
    skills.clear();
    clearMcpDraft(key);
    attachmentDrafts.delete(key);
    setAdmissionError("");
    localStorage.removeItem(key);
  };
  useEffect(() => { setGoalError(""); }, [key]);
  useEffect(() => {
    setUnknown(localStorage.getItem(`${key}:pending`));
    setGoalMode(localStorage.getItem(`${key}:goal`) === "true");
    if (!busy) {
      const draft = localStorage.getItem(key) ?? "";
      if (api.current && api.current.getMarkdown() !== draft) api.current.setText(draft);
      setText(draft);
      setFiles(attachmentDrafts.get(key) ?? []);
      setAdmissionError(attachmentErrors.get(key) ?? "");
    }
  }, [key, busy]);
  useEffect(() => {
    const refreshDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key || sending.has(key)) return;
      const draft = localStorage.getItem(key) ?? "";
      api.current?.setText(draft); setText(draft); setFiles(attachmentDrafts.get(key) ?? []); api.current?.focus();
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [key]);
  useEffect(() => {
    if (!unknown || pending) return;
    const outcome = project.outcomes?.[unknown];
    if (!outcome) return;
    localStorage.removeItem(`${key}:pending`);
    setUnknown(null);
    reconcileReviewSubmission(reviewKey, unknown, outcome.accepted !== false);
    const wasGoal = localStorage.getItem(`${key}:pending-goal`) === unknown;
    localStorage.removeItem(`${key}:pending-goal`);
    const wasContinue = localStorage.getItem(`${key}:pending-continue`) === unknown;
    localStorage.removeItem(`${key}:pending-continue`);
    if (outcome.accepted === false) setDeliveryError(outcome.message || "原轮次已结束，内容已保留，请检查后发送。");
    else if (wasContinue) setDeliveryError("");
    else if (wasGoal) {
      clearText(); changeGoalMode(false);
    } else clear();
  }, [unknown, pending, project.outcomes]);
  useEffect(() => {
    if (thread.goals?.goal && goalMode) changeGoalMode(false);
  }, [thread.goals?.goal?.id]);
  const submit = async (value: string, invert = false, approvePlan = false) => {
    if (desktopUnsupported && !creatingGoal && !queueEditor.edit) return;
    const submittedInput = composerInput(value, files);
    const sideCommand = /^\/side(?:\s|$)/i.exec(submittedInput.text);
    if (sideCommand && (!onSide || submittedInput.files.length)) {
      setDeliveryError(submittedInput.files.length ? "旁路首问仅接受文本；附件仍保留在主草稿。" : "当前会话不支持旁路讨论。");
      return;
    }
    if (sideCommand && onSide) {
      const question = submittedInput.text.slice(sideCommand[0].length);
      onSide(question);
      clearText();
      return;
    }
    if (annotationEditing || invalidAnnotation) return;
    if (queueEditor.edit) { await queueEditor.save(); return; }
    if (disabled || annotationEditing || invalidAnnotation || sending.has(key) || (!submittedInput.text.trim() && !submittedInput.files.length && !comments.length && !skills.selected.length && !mcpDraft.length)) return;
    if (approvePlan && (!planReady || input.text.trim() || input.files.length || comments.length)) return;
    if (creatingGoal && (running || thread.parentThreadId || !submittedInput.text.trim())) return;
    setAdmissionError("");
    markSending(key, true);
    setGoalError("");
    setDeliveryError("");
    try {
      if (creatingGoal) {
        await action("manage", { projectId: project.id, threadId: thread.id, operation: "goalCreate",
          expectedRevision: thread.goals?.revision ?? 0, objective: submittedInput.text, inferLimits: true });
        clearText();
        changeGoalMode(false);
        return;
      }
      if (approvePlan) await action("configure", { projectId: project.id, threadId: thread.id, expectedRevision: config?.revision, options: permissionOptions("auto", config?.options) });
      await submitMessage(action, project.id, thread.id, value, files, {
        steer: !taskManagement && !!running && shouldSteer(prefs.followUp, invert),
        expectedTurnId: running?.id,
        enqueue: !taskManagement && !!running,
        skillAction: readAction,
      });
      clear();
    } catch (e) {
      const error = e as Error & {
        submissionUnknown?: boolean;
        requestId?: string;
      };
      if (creatingGoal) setGoalError(goalControlError(error));
      else if (!(error.submissionUnknown && error.requestId)) {
        // 附件失败留在所属 Composer，切换任务后仍能看到；没有附件的未受理发送/steer 单独显示投递原因。
        if (files.length > 0) setAdmissionError(error.message);
        else if (!error.submissionUnknown) setDeliveryError(error.message || "发送未受理，输入已保留。");
        else setAdmissionError(error.message);
      }
      if (error.submissionUnknown && error.requestId) {
        if (creatingGoal) localStorage.setItem(`${key}:pending-goal`, error.requestId);
        setUnknown(error.requestId);
        localStorage.setItem(`${key}:pending`, error.requestId);
      }
    } finally {
      markSending(key, false);
    }
  };
  const continueExecution = async () => {
    if (desktopUnsupported || !canContinue || disabled || sending.has(key)) return;
    markSending(key, true); setDeliveryError("");
    try {
      await action("continue", { projectId: project.id, threadId: thread.id, expectedTurnId: interrupted.id, expectedConfigRevision: config?.revision });
    } catch (cause) {
      const error = cause as Error & { submissionUnknown?: boolean; requestId?: string };
      setDeliveryError(error.message);
      if (error.submissionUnknown && error.requestId) {
        localStorage.setItem(`${key}:pending`, error.requestId);
        localStorage.setItem(`${key}:pending-continue`, error.requestId);
        setUnknown(error.requestId);
      }
    } finally { markSending(key, false); }
  };
  const configure = async (values: Data) => {
    if (queueEditor.edit) return;
    if (disabled || running || sending.has(key)) return;
    markSending(key, true);
    try {
      await action("configure", { projectId: project.id, threadId: thread.id, expectedRevision: config?.revision, ...values });
    } catch (cause) { setAdmissionError((cause as Error).message); } finally { markSending(key, false); }
  };
  const catalogActions: ComposerCatalogEntry[] = [
    ...(onMcpMention ? [{value:"app-mention",label:"@ 应用引用",description:"搜索应用中的文件、工单或其他资源",icon:<ComposerMcpIcon/>,group:"功能" as const,run:onMcpMention}] : []),
    ...(onSide ? [{ value: "side", label: "侧边聊天", description: "在右侧讨论，不打断当前聊天", icon: <SideChatIcon />, group: "功能" as const, run: () => onSide("") }] : []),
    { value: "upload", label: "上传文件", description: "添加图片、文档或其他文件", icon: <AttachmentIcon />, group: "功能", run: () => upload.current?.click() },
    { value: "mcp", label: "MCP", description: "查看服务器与连接状态", icon: <ComposerMcpIcon />, group: "功能", run: () => setMcpOpen(true) },
    { value: "files", label: "工作区文件", description: "引用当前项目中的文件", icon: <FileTree />, group: "功能", run: () => onPanel("文件") },
    { value: "plan", label: "计划模式", description: planActive ? "关闭计划模式" : "先规划，再开始执行", icon: <Lightbulb />, group: "功能", disabled: disabled || taskManagement || !!running || !config || config.profile?.readOnly === true, run: () => { void configure({ options: planModeOptions(!planActive, config?.options) }); } },
    ...(!thread.goals?.goal ? [{ value: "goal", label: "设置目标", description: creatingGoal ? "关闭目标模式" : "设置持续目标与停止条件", icon: <Target />, group: "功能" as const, disabled: disabled || taskManagement || !!running || !!thread.parentThreadId, run: () => changeGoalMode(!goalMode) }] : []),
    { value: "compact", label: "压缩", description: "压缩当前上下文", icon: <ArchiveChatIcon />, group: "功能", disabled: !!running, run: () => { void action("manage", { projectId: project.id, threadId: thread.id, operation: "contextCompact" }).catch(() => {}); } },
  ];
  // TaskRun owns this worker's lifetime; its history is readable, but it is
  // not an independent conversation that can accept another user turn.
  const returnToRun = async () => {
    if (returning) return;
    setReturning(true); setReturnError("");
    try {
      const listed = await action("tasks", { operation: "list", limit: 1024 });
      const task = (listed.data ?? []).find((row: Data) => row.projectId === project.id && row.runs?.some((run: Data) => run.workers?.some((worker: Data) => worker.threadId === thread.id)));
      const run = task?.runs?.find((item: Data) => item.workers?.some((worker: Data) => worker.threadId === thread.id));
      if (!task || !run || !onOpenTask) throw new Error("找不到此 worker 所属的原运行。");
      onOpenTask({ projectId: project.id, taskId: task.id, runId: run.id });
    } catch (cause) { setReturnError((cause as Error).message); }
    finally { setReturning(false); }
  };
  if (thread.source === "nativeTaskAgent" && thread.goalOwner) return <div className="composer-dock" data-v4-composer-dock="true"><p role="status" className="px-3 pt-3 text-ui-sm text-foreground-subtle">此 worker 由原 TaskRun 管理。打开历史不会重新执行已结束的工作。</p>{returnError && <p role="alert" className="px-3 text-ui-sm">{returnError}</p>}<div className="px-3 py-3"><Button size="sm" variant="outline" disabled={returning} onClick={() => void returnToRun()}>{returning ? "正在返回…" : "返回原运行"}</Button></div></div>;
  return (
    <div className="composer-dock" data-v4-composer-dock="true">
      <GoalCard project={project} thread={thread} action={action} onEdit={() => onPanel("编辑目标")} />
      <input
        ref={upload}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const selectedFiles = Array.from(e.currentTarget.files ?? []);
          setFiles((f) => [...f, ...selectedFiles]);
          e.currentTarget.value = "";
        }}
      />
      {deliveryError && <p role="alert" className="notice">{deliveryError}</p>}
      {unknown && (
        <div role="status" className="notice">
          提交结果尚未确认。草稿已保留，等待 Core 对账；不会自动重发。
          <button
            onClick={() => void action("reconcile", { projectId: project.id }).catch(() => {})}
          >
            刷新受理状态
          </button>
        </div>
      )}
      {planReady && !queueEditor.edit && <section className="flex items-center justify-between gap-3 px-3 py-2 text-ui-sm" aria-label="计划确认">
        <span className="text-foreground-subtle">计划已完成。批准后将以自动编辑模式执行。</span>
        <Button size="sm" disabled={disabled || desktopUnsupported || !!input.text.trim() || !!input.files.length || !!comments.length} aria-describedby={desktopUnsupported ? BACKEND_STATUS_ID : undefined} onClick={() => void submit("按上方已确认的计划执行。", false, true)}>批准并执行</Button>
      </section>}
      <div className="composer-input-stack">
      <div ref={setMenuAnchor} className="composer-menu-anchor" />
      <ComposerQueue
        key={key}
        project={project}
        thread={thread}
        action={action}
        disabled={baseDisabled || queueEditor.busy}
        editingId={queueEditor.edit?.id}
        onEdit={item => void queueEditor.begin(item)}
      />
      {/* Pending decisions stay reachable outside the scrolling transcript. */}
      {approvals.map((item: Data) => <ApprovalRequest key={item.requestId} item={item} projectId={project.id} action={action} />)}
      {questions.map((item: Data) => <AskUserQuestion key={item.requestId} item={item} projectId={project.id} action={action} />)}
      {goalError && <p role="alert" className="notice text-destructive">{goalError}</p>}
      {admissionError && <p role="alert" className="notice text-destructive">{admissionError}</p>}
      {reviewDraft.error && <p role="alert" className="notice">{reviewDraft.error}</p>}
      {thread.desktop?.workflowRun && <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-ui-sm text-foreground-subtle">
        <Button type="button" size="sm" variant="ghost" onClick={() => {
          const storageKey = `areal-gui:workgroup:${project.id}`;
          localStorage.setItem(storageKey, thread.desktop.workflowRun.workgroupId);
          document.dispatchEvent(new CustomEvent("areal:workgroup-operation", { detail: storageKey }));
          onPanel("工作组");
        }}>查看关联工作流结果</Button>
      </div>}
      <ConversationComposer
        surfaceLayout={surfaceLayout}
        project={project}
        contextControl={<ContextMeter key={`${project.id}:${thread.id}`} project={project} thread={thread} action={readAction} anchor={menuAnchor} />}
        modelConfig={config}
        modelDisabled={disabled || !!queueEditor.edit || !!running || !config}
        onConfigureModel={values => { void configure(values); }}
        onModelSettings={() => onPanel("设置")}
        triggerPanelContainer={menuAnchor}
        className={!queueEditor.edit ? approvals.length ? "hidden" : questions.length ? "interaction-composer-compact" : undefined : undefined}
        shellClassName="@container/composer"
        workspacePath={project.root}
        taskId={thread.id}
        initialValue={text}
        inputApiRef={api}
        inputTestId="chat-input"
        submitTestId="chat-send-button"
        placeholder={archived ? "已归档任务只读" : creatingGoal ? "描述目标，明确可衡量的结果" : planActive ? "描述任务，生成计划…" : "随心输入"}
        disabled={disabled}
        submitDisabled={disabled || (desktopUnsupported && !queueEditor.edit && !creatingGoal) || (taskManagement && !!running) || annotationEditing || invalidAnnotation || (queueEditor.edit ? queueEditor.saveDisabled || (!input.text.trim() && !input.files.length && !queueEditor.edit.attachments.length) : creatingGoal ? !input.text.trim() || !!running : !canContinue && emptyDraft)}
        submitting={busy}
        submitLabel={queueEditor.edit ? "保存排队消息" : creatingGoal ? "开始目标" : canContinue ? "继续执行" : "发送"}
        enterSubmits={prefs.sendShortcut === "enter"}
        enableMentionPanel={false}
        composerCatalog={{ ...skills.catalog, entries: [...catalogActions, ...skills.catalog.entries].map(entry => ({ ...entry, disabled: entry.disabled || (!!queueEditor.edit && !["upload", "files", "mcp"].includes(entry.value)) })) }}
        onChange={(value) => {
          setText(value);
          if(onMcpMention&&/(^|\s)@$/.test(value)&&!/(^|\s)@$/.test(text))onMcpMention();
          localStorage.setItem(key, value);
          localStorage.setItem(`${key}:version`, String(Number(localStorage.getItem(`${key}:version`) ?? 0) + 1));
        }}
        allowSubmitWhenEmpty={canContinue}
        onSubmit={(value) => {
          if (canContinue) void continueExecution();
          else void submit(value);
          return false;
        }}
        onModifiedSubmit={prefs.sendShortcut === "enter" ? (value) => {
          if (canContinue) void continueExecution();
          else void submit(value, !!running);
          return false;
        } : undefined}
        onPaste={event => composerPaste(event, pasted => setFiles(current => [...current, ...pasted]))}
        topContent={
          <>{queueEditor.edit && <div className="composer-queue-edit-banner" aria-label="编辑排队消息">
            <span>{queueEditor.edit.phase === "opening" ? "等待确认暂停队列" : "编辑排队消息"}</span>
            <Button type="button" size="sm" variant="ghost" disabled={queueEditor.busy || !!queueEditor.edit.unknown || pending} onClick={() => void queueEditor.cancel()}>取消</Button>
            <Button type="button" size="sm" disabled={queueEditor.saveDisabled || (!input.text.trim() && !input.files.length && !queueEditor.edit.attachments.length)} onClick={() => void queueEditor.save()}>保存</Button>
          </div>}
          {queueEditor.feedback && <p role="alert" className="composer-queue-feedback">{queueEditor.feedback}</p>}
          {queueEditor.edit?.unknown && <Button type="button" size="sm" disabled={queueEditor.busy || !project.state?.connected} onClick={() => void queueEditor.reconcile()}>核对编辑操作</Button>}
          {!queueEditor.edit && skills.tags}
          <BrowserAnnotationAttachments files={files} disabled={disabled} onChange={setFiles} />
          <div className="composer-attachment-row">
          {!!queueEditor.edit?.attachments.length && <div className="composer-attachments">
            {queueEditor.edit.attachments.map((part, index) => <ComposerQueueAttachment key={`${index}:${part.url}`} part={part} projectId={project.id} threadId={thread.id} action={readAction} disabled={disabled}
              onRemove={() => queueEditor.removeAttachment(index)} />)}
          </div>}
          {files.some(file => !isComposerFile(file) || !browserAnnotation(file)) ? (
            <div className="composer-attachments" data-testid="composer-attachments">
              {files.filter(file => !isComposerFile(file) || !browserAnnotation(file)).map((file, i) => <ComposerAttachment disabled={disabled} key={isComposerFile(file) ? `${file.name}-${file.lastModified}-${i}` : `pasted-text-${i}`} file={file}
                onAnnotate={onAnnotate ? file => onAnnotate({ draftKey: key, file, returnFocus: () => api.current?.focus() }) : undefined}
                onRemove={() => setFiles((current) => current.filter(item => item !== file))}
                onExpand={content => { api.current?.appendText(`${text.length ? "\n\n" : ""}${content}`); setFiles(current => current.filter(item => item !== file)); }} />)}
            </div>
          ) : null}
          {!queueEditor.edit && <ReviewCommentAttachment comments={comments} disabled={disabled} onRemove={() => detachReviewComments(reviewKey)} />}
          {!queueEditor.edit && <McpComposerAttachments draftKey={key} entries={mcpDraft} disabled={disabled} />}
          </div></>
        }
        promptHistory={(thread.turns ?? []).flatMap((t: Data) =>
          (t.items ?? [])
            .filter((i: Data) => i.type === "userMessage" && !t.continuedFromTurnId && !(goalContinuationLabel(t) && i.id === t.items.find((entry: Data) => entry.type === "userMessage")?.id))
            .map((i: Data) =>
              (i.content ?? [])
                .filter((p: Data) => p.type === "text")
                .map((p: Data) => p.text)
                .join("\n"),
            ),
        )}
        leadingActions={
          <><ComposerPermissionMenu value={executionPermission}
            disabled={disabled || !!queueEditor.edit || !!running || !config} lockedReadOnly={taskManagement || config?.profile?.readOnly === true}
            onClose={() => api.current?.focus()}
            onChange={mode => configure({ options: planModeOptions(planActive, permissionOptions(mode, config?.options)) })} />
          {planActive && <ComposerPlanMode disabled={disabled || !!queueEditor.edit || !!running || config?.profile?.readOnly === true}
            onExit={() => { void configure({ options: planModeOptions(false, config?.options) }); }} />}
          {creatingGoal && <div className="flex shrink-0 items-center gap-1">
            <span className="h-4 border-l border-border" aria-hidden="true" />
            <ControlHintTooltip title="退出目标模式">
              <Button type="button" variant="ghost" className="gap-1 rounded-full px-2 text-ui-caption text-foreground-subtle"
                aria-label="退出目标模式" disabled={disabled || !!queueEditor.edit} onClick={() => changeGoalMode(false)}>
                <Target className="size-4" /><span>目标</span>
              </Button>
            </ControlHintTooltip>
          </div>}</>
        }
        onCancel={queueEditor.edit ? () => void queueEditor.cancel() : running ? stop : undefined}
        submitControl={queueEditor.edit ? <Button type="button" size="icon-md" aria-label="保存排队消息" data-testid="chat-send-button" disabled={disabled || queueEditor.saveDisabled || (!input.text.trim() && !input.files.length && !queueEditor.edit.attachments.length)}
          className="composer-primary-action" onClick={() => void queueEditor.save()}><SendMessageIcon className="size-5" /></Button> : running && !input.text.trim() && !input.files.length && !comments.length && !skills.selected.length && !mcpDraft.length ? (
          <ControlHintTooltip title={ordinary ? "暂停执行" : "停止"} shortcut="Esc">
            <Button type="button" variant="secondary" size="icon-md" className="composer-primary-action composer-stop-action" aria-label={ordinary ? "暂停执行" : "停止"}
              onClick={() => { stop(); api.current?.focus(); }}>
              <StopIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
        ) : running ? (
          <ControlHintTooltip title="发送" shortcut={prefs.sendShortcut === "enter" ? "Enter" : "⌘/Ctrl+Enter"}>
            <Button type="button" variant="composer" size="icon-md" aria-label="发送" data-testid="chat-send-button"
              aria-describedby={desktopUnsupported ? BACKEND_STATUS_ID : undefined}
              disabled={disabled || desktopUnsupported || taskManagement || (!input.text.trim() && !input.files.length && !comments.length && !skills.selected.length && !mcpDraft.length)}
              onClick={event => void submit(api.current?.getMarkdown() ?? text, event.metaKey || event.ctrlKey)}>
              <SendMessageIcon className="size-5" />
            </Button>
          </ControlHintTooltip>
        ) : canContinue ? (
          <ControlHintTooltip title="继续执行">
            <Button type="button" variant="composer" size="icon-md" aria-label="继续执行" data-testid="chat-continue-button"
              aria-describedby={desktopUnsupported ? BACKEND_STATUS_ID : undefined}
              disabled={disabled || desktopUnsupported} className="composer-primary-action" onClick={() => void continueExecution()}>
              <ContinueExecutionIcon className="size-5" />
            </Button>
          </ControlHintTooltip>
        ) : undefined}

      />
      </div>
      <ComposerMcp projectId={project.id} action={readAction} open={mcpOpen} anchor={menuAnchor} onClose={() => { setMcpOpen(false); api.current?.focus(); }} />
      <div className="composer-caption sr-only">
        {prefs.sendShortcut === "enter" ? "Enter" : "⌘/Ctrl+Enter"} 发送 · Shift+Enter 换行 · / 命令
      </div>
    </div>
  );
}

// Both the first message and later turns use the same attachment and admission path.
export async function submitMessage(
  action: Action,
  projectId: string,
  threadId: string,
  text: string,
  files: ComposerDraftAttachment[],
  options: Data = {},
) {
  const reviewKey = reviewCommentKey(projectId, threadId);
  const comments = options.appMessage ? [] : attachedReviewComments(readReviewComments(reviewKey));
  const key = `areal-gui:draft:${projectId}:${threadId}`;
  const capturedMcp = options.appMessage ? [] : readMcpDraft(key);
  const blocks = options.appMessage ? options.mcpContent ?? [] : capturedMcp.map((entry: Data) => entry.block);
  const imageBlocks = blocks.filter((block: Data) => block.type === "image");
  const imageFiles = imageBlocks.map((block: Data) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) || typeof block.data !== "string" || block.data.length > 12 * 1024 * 1024) throw new Error("应用图片类型或大小不受支持。");
    const bytes = Uint8Array.from(atob(block.data), character => character.charCodeAt(0));
    return new File([bytes], typeof block._meta?.["openai/title"] === "string" ? block._meta["openai/title"] : "应用图片", {type:block.mimeType});
  });
  const imageSnapshot = snapshotImageAnnotations(composerInput(text, files).files);
  const skillContent = options.appMessage ? "" : await composerSkillContent(options.skillAction ?? action, projectId, threadId, readComposerSkills(`areal-gui:draft:${projectId}:${threadId}`));
  const input = composerInput(text, files);
  const attachments: Data[] = await uploadComposerFiles(action, projectId, threadId, [...input.files, ...imageFiles]);
  imageBlocks.forEach((block: Data, index: number) => { if (block._meta) attachments[input.files.length + index]._meta = block._meta; });
  const annotationFeedback = input.files.flatMap((file, index) => {
    const note = browserAnnotation(file);
    return note ? [browserAnnotationText(note, attachments[index].url)] : [];
  }).join("\n\n");
  const feedback = [annotationFeedback, serializeImageAnnotations(imageSnapshot, attachments), comments.map(reviewCommentText).join("\n\n"), skillContent].filter(Boolean).join("\n\n");
  try {
    await action(options.steer ? "steer" : "send", {
        projectId,
        threadId,
        text: feedback ? (input.text ? `${input.text}\n\n${feedback}` : feedback) : input.text,
        attachments,
        ...(blocks.some((block: Data) => block.type !== "image") ? {mcpContent: blocks.filter((block: Data) => block.type !== "image")} : {}),
        expectedTurnId: options.expectedTurnId,
        enqueue: options.enqueue === true,
      });
  } catch (cause) {
    const error = cause as Error & { submissionUnknown?: boolean; requestId?: string };
    if (error.submissionUnknown && error.requestId && comments.length) {
      try { recordUnknownReviewSubmission(reviewKey, error.requestId, comments); }
      catch { error.message += " 评论提交记录无法保存，原评论已保留。"; }
    }
    throw cause;
  }
  // Only explicit acceptance consumes the captured records. Unknown submissions
  // retain their exact IDs until the existing Core receipt is reconciled.
  consumeReviewComments(reviewKey, comments);
  if (!options.appMessage) consumeMcpDraft(key, capturedMcp);
}
export function stageThreadDraft(projectId: string, threadId: string, text: string, files: ComposerDraftAttachment[]) {
  const key = `areal-gui:draft:${projectId}:${threadId}`;
  localStorage.setItem(key, text);
  attachmentDrafts.set(key, files);
  return key;
}

// 发送和队列更新共用上传边界，编辑中现存 Core 引用不经过此函数。
export async function uploadComposerFiles(action: Action, projectId: string, threadId: string, files: File[]) {
  const attachments = [];
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`无法读取附件 ${file.name}：${reason}`);
    }
    const media = await action("media", {
      projectId,
      threadId,
      operation: "upload",
      mime: file.type || "application/octet-stream",
      bytes,
    });
    attachments.push({
      type: file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("audio/")
          ? "audio"
          : "file",
      url: media.uri,
      name: file.name,
      mimeType: media.mimeType,
    });
  }
  return attachments;
}
