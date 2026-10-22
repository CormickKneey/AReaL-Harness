import { imageAnnotationBlocked, useImageAnnotationRevision, type ImageAnnotationTarget } from "./imageAnnotations.js";
import { resolveDraftProfile } from "./ProfileDetails.js";
import { resolveNewConversationModel, resolveModelEffort } from "@areal/workbench/model-selection";
import { setApplicationPreferences, useApplicationPreferences } from "./settings/applicationPreferences.js";
import { ComposerModelMenu, composerModelOption } from "./ComposerModelMenu.js";
import { ComposerPermissionMenu } from "./ComposerPermissionMenu.js";
import { permissionOptions, planModeOptions, type PermissionPreset } from "./permissions.js";
import { ComposerPlanMode } from "./ComposerPlanMode.js";
import { FileTree, AttachmentIcon, GoalIcon, PlanModeIcon as Lightbulb } from "./interfaceIcons.js";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
import { ComposerAttachment, composerInput, composerPaste, isComposerFile, type ComposerDraftAttachment } from "./ComposerAttachments.js";
import { useComposerSkills, transferComposerSkills, clearComposerSkills, readComposerSkills } from "./ComposerSkills.js";
import { ComposerMcpIcon } from "./ComposerIcons.js";
import { ComposerMcp } from "./ComposerMcp.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { Button } from "./components/ui/button.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import type { Action, Data } from "./services.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";
import { isTechnicalErrorMessage, recoveredOutcome, recoveryMessage, type RecoveryFailure } from "./recoveryPresentation.js";
import { attachedReviewComments, detachReviewComments, reviewCommentKey, transferNewReviewComments, useReviewComments } from "./reviewComments.js";
import { ReviewCommentAttachment } from "./ReviewCommentViews.js";
import {
  attachmentDrafts,
  attachmentErrors,
  sending,
  subscribeSending,
  markSending,
  stageThreadDraft,
  submitMessage,
} from "./Composer.js";

export function DraftComposer({
  project,
  backendReady = false,
  action,
  readAction = action,
  onOpen,
  onPanel,
  appEntries = [],
  draftKey,
  prepareProject,
  preparationStatus,
  onAnnotate,
  surfaceLayout = "default",
}: {
  surfaceLayout?: "default" | "compact";
  project: Data;
  backendReady?: boolean;
  action: Action;
  readAction?: Action;
  onOpen: (pid: string, tid: string) => Promise<void>;
  onPanel: (panel: string) => void;
  appEntries?: readonly ComposerCatalogEntry[];
  draftKey?: string;
  prepareProject?: () => Promise<Data>;
  preparationStatus?: ReactNode;
  onAnnotate?: (target: ImageAnnotationTarget) => void;
}) {
  const { t } = useI18n();
  const prefs = useApplicationPreferences();
  const defaultPermissionPreset = useRef(prefs.defaultPermissionPreset);
  defaultPermissionPreset.current = prefs.defaultPermissionPreset;
  const key = draftKey ?? `areal-gui:draft:${project.id}:new`;
  const reviewKey = reviewCommentKey(project.id, "new");
  const reviewDraft = useReviewComments(reviewKey);
  const comments = attachedReviewComments(reviewDraft.draft);
  const api = useRef<LexicalChatInputHandle | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [text, setText] = useState(() => localStorage.getItem(key) ?? "");
  const [draftError, setDraftError] = useState("");
  useEffect(() => {
    const refreshDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key || sending.has(key)) return;
      const draft = localStorage.getItem(key) ?? "";
      setProfileSelection(localStorage.getItem(`${key}:profile`) ?? "");
      api.current?.setText(draft); setText(draft); setFiles(attachmentDrafts.get(key) ?? []); api.current?.focus();
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [key]);
  const [files, setFiles] = useState<ComposerDraftAttachment[]>(() => attachmentDrafts.get(key) ?? []);
  const input = composerInput(text, files);
  useImageAnnotationRevision();
  const annotationBlocked = imageAnnotationBlocked(key, input.files);
  const [permission, setPermission] = useState<PermissionPreset>(() => {
    const saved = localStorage.getItem(`${key}:permission`);
    return saved === "ask" || saved === "autoReview" || saved === "fullAccess" ? saved : prefs.defaultPermissionPreset;
  });
  const [plan, setPlan] = useState(() => localStorage.getItem(`${key}:plan`) === "true");
  const [profileSelection, setProfileSelection] = useState(() => localStorage.getItem(`${key}:profile`) ?? "");
  const chosenProfile = resolveDraftProfile(project, profileSelection);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [goalMode, setGoalMode] = useState(() => localStorage.getItem(`${key}:goal`) === "true");
  const changeGoalMode = (enabled: boolean) => { setGoalMode(enabled); localStorage.setItem(`${key}:goal`, String(enabled)); api.current?.focus(); };
  const [efforts, setEfforts] = useState<Record<string, string>>(() => localStorage.getItem(`${key}:model`) !== null ? JSON.parse(localStorage.getItem(`${key}:efforts`) ?? "{}") : {});
  const unavailableProfile = !!(profileSelection || project.defaultProfile) && !chosenProfile;
  const setPlanMode = (enabled: boolean) => { setPlan(enabled); localStorage.setItem(`${key}:plan`, String(enabled)); };
  const [model, setModel] = useState<string | null>(() => localStorage.getItem(`${key}:model`));
  const modelValue = (item: Data) => `${item.providerId ?? ""}/${item.modelId}`;
  const initialSelection = resolveNewConversationModel(project.models, project.lastAcceptedModel);
  const initialModel = chosenProfile?.model
    ? project.models.find((item: Data) => item.providerId === chosenProfile.model.providerId && item.modelId === chosenProfile.model.modelId)
    : initialSelection.candidate;
  const effectiveModel = model ?? (chosenProfile?.model
    ? `${chosenProfile.model.providerId}/${chosenProfile.model.modelId}` : initialModel ? modelValue(initialModel) : "");
  const currentModel = project.models.find((item: Data) => modelValue(item) === effectiveModel);
  const rememberedEffort = !chosenProfile?.model && model === null ? initialSelection.rememberedEffort : undefined;
  const effort = resolveModelEffort(currentModel, efforts[effectiveModel] ?? rememberedEffort);
  const preferenceNotice = model === null && !chosenProfile?.model
    ? initialSelection.notice === "model-unavailable" ? t("chat.composer.previousModelUnavailable")
      : initialSelection.notice === "effort-unsupported" ? t("chat.composer.previousEffortUnsupported") : ""
    : "";
  const [unknown, setUnknown] = useState(() => localStorage.getItem(`${key}:pending-create`));
  const busy = useSyncExternalStore(subscribeSending, () => sending.has(key));
  const editLocked = busy || !!project.pending.length || !!unknown || !!reviewDraft.error;
  const executionReady = backendReady && !!project.state?.connected;
  const modelSelectionDisabled = editLocked || !executionReady || unavailableProfile;
  const submitDisabled = modelSelectionDisabled || !currentModel || currentModel.available === false;
  const desktopUnsupported = project.desktopCapabilities?.currentCommands === false;
  const skills = useComposerSkills({
    project: executionReady ? project : { ...project, state: { ...project.state, connected: false } },
    profile: chosenProfile, draftKey: key, action: readAction, disabled: editLocked || !executionReady,
  });
  useEffect(() => {
    attachmentDrafts.set(key, files);
    window.dispatchEvent(new CustomEvent("areal-attachments-change", { detail: key }));
  }, [key, files]);
  const clear = () => {
    detachReviewComments(reviewKey);
    localStorage.removeItem(key);
    localStorage.removeItem(`${key}:permission`);
    localStorage.removeItem(`${key}:plan`);
    localStorage.removeItem(`${key}:model`);
    localStorage.removeItem(`${key}:efforts`);
    localStorage.removeItem(`${key}:profile`);
    setModel(null);
    setEfforts({});
    setPermission(defaultPermissionPreset.current);
    setPlan(false);
    setProfileSelection("");
    attachmentDrafts.delete(key);
    skills.clear();
    changeGoalMode(false);
    api.current?.clear();
    setText("");
    setFiles([]);
  };
  useEffect(() => {
    if (!unknown || project.pending.length) return;
    const outcome = recoveredOutcome(project, unknown, "");
    if (!outcome || outcome.operation && outcome.operation.method !== "areal/thread/start") return;
    if (outcome.status === "failed" || outcome.accepted === false) {
      localStorage.removeItem(`${key}:pending-create`);
      setUnknown(null);
      setDraftError(outcome.message || "创建对话未完成，草稿已保留，请检查后重试。");
      return;
    }
    if (!outcome.threadId || outcome.accepted !== true) return;
    try { transferNewReviewComments(project.id, outcome.threadId); }
    catch (cause) { setDraftError((cause as Error).message); return; }
    // A recovered creation opens the preserved draft; it never sends it automatically.
    stageThreadDraft(
      project.id,
      outcome.threadId,
      localStorage.getItem(key) ?? "",
      attachmentDrafts.get(key) ?? [],
    );
    transferComposerSkills(key, `areal-gui:draft:${project.id}:${outcome.threadId}`);
    if (goalMode) localStorage.setItem(`areal-gui:draft:${project.id}:${outcome.threadId}:goal`, "true");
    localStorage.removeItem(`${key}:pending-create`);
    setUnknown(null);
    clear();
    void onOpen(project.id, outcome.threadId);
  }, [unknown, project.pending.length, project.outcomes]);
  const submit = async (value: string) => {
    const submittedInput = composerInput(value, files);
    if ((desktopUnsupported && !goalMode) || submitDisabled || annotationBlocked || sending.has(key) || (!submittedInput.text.trim() && !submittedInput.files.length && !comments.length && !skills.selected.length) || (goalMode && !submittedInput.text.trim())) return;
    markSending(key, true);
    setDraftError("");
    let targetKey: string | undefined;
    let creationAttempted = false;
    const creationRequestId = crypto.randomUUID();
    try {
      const owner = prepareProject ? await prepareProject() : project;
      if (owner.desktopCapabilities?.currentCommands === false && !goalMode)
        throw new Error("更新后台后可发送消息，草稿已保留。");
      const profile = resolveDraftProfile(owner, profileSelection);
      if ((profileSelection || owner.defaultProfile) && !profile) throw new Error("当前任务配置不可用，输入已保留。");
      const chosenModel = owner.models.find((item: Data) => modelValue(item) === effectiveModel);
      if (!chosenModel || chosenModel.available === false || chosenModel.modelId !== currentModel?.modelId) {
        throw new Error("所选模型已不可用，输入已保留，请重新选择模型。");
      }
      const selectedSkills = readComposerSkills(key);
      if (selectedSkills.length) {
        if (!profile) throw new Error("当前任务配置不可用，技能草稿已保留。");
        const available = await readAction("manage", { projectId: owner.id, operation: "skills", agentProfile: { id: profile.id, revision: profile.revision } });
        if (selectedSkills.some(skill => !(available.data ?? []).some((item: Data) => item.available && item.id === skill.id && item.revision === skill.revision)))
          throw new Error("当前任务配置未提供所选 Skill 的确切版本，草稿已保留。");
      }
      const parameters = { ...currentModel.parameters };
      if (chosenModel.capabilities?.reasoning === false) {
        delete parameters.reasoningEffort;
        delete parameters.reasoningSummary;
      } else {
        delete parameters.reasoningEffort;
        if (effort) parameters.reasoningEffort = effort;
      }
      creationAttempted = true;
      const result = await action("create", {
        projectId: owner.id,
        requestId: creationRequestId,
        parameters,
        options: planModeOptions(plan, permissionOptions(permission)),
        ...(profileSelection && profile
          ? { profile: { id: profile.id, revision: profile.revision } }
          : {}),
        ...(chosenModel.providerId
          ? { model: { providerId: chosenModel.providerId, modelId: chosenModel.modelId } }
          : {}),
      });
      targetKey = stageThreadDraft(owner.id, result.threadId, value, files);
      transferNewReviewComments(owner.id, result.threadId);
      transferComposerSkills(key, targetKey);
      if (goalMode) localStorage.setItem(`${targetKey}:goal`, "true");
      markSending(targetKey, true);
      clear();
      // Show the accepted task immediately, including while the first model request waits.
      if (mounted.current) void onOpen(owner.id, result.threadId);
      if (goalMode) {
        const latest = await action("manage", { projectId: owner.id, threadId: result.threadId, operation: "goal" });
        await action("manage", { projectId: owner.id, threadId: result.threadId, operation: "goalCreate", objective: submittedInput.text, expectedRevision: latest.revision ?? 0, inferLimits: true });
        localStorage.removeItem(`${targetKey}:goal`);
        attachmentDrafts.set(targetKey, submittedInput.files);
      } else {
        await submitMessage(action, owner.id, result.threadId, value, files, { skillAction: readAction });
        attachmentDrafts.delete(targetKey);
        clearComposerSkills(targetKey);
      }
      localStorage.removeItem(targetKey);
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: targetKey }));
    } catch (e) {
      const failure = e as RecoveryFailure;
      if (!failure.submissionUnknown) {
        setDraftError(recoveryMessage(failure));
        if (targetKey) attachmentErrors.set(targetKey, recoveryMessage(failure));
      }
      const error = failure;
      if (creationAttempted && error.submissionUnknown && error.requestId) {
        if (targetKey) {
          localStorage.setItem(`${targetKey}:pending`, error.requestId);
          if (error.outcome && "operation" in error.outcome) localStorage.setItem(`${targetKey}:pending-operation`, JSON.stringify(error.outcome.operation));
          if (goalMode) localStorage.setItem(`${targetKey}:pending-goal`, error.requestId);
        }
        else {
          localStorage.setItem(`${key}:pending-create`, error.requestId);
          setUnknown(error.requestId);
        }
      }
      // action reports the error. Known-created tasks keep text and files for explicit retry.
    } finally {
      if (targetKey) markSending(targetKey, false);
      markSending(key, false);
    }
  };
  return (
    <div className="composer-dock" data-v4-composer-dock="true">
      <input
        ref={upload}
        type="file"
        multiple
        hidden
        disabled={editLocked}
        onChange={(e) => {
          const selectedFiles = Array.from(e.currentTarget.files ?? []);
          if (!editLocked) setFiles((f) => [...f, ...selectedFiles]);
          e.currentTarget.value = "";
        }}
      />
      {unknown && <FeedbackNotice tone="warning" message={t("recovery.createUnconfirmed")} requestId={unknown}
        detail={t("recovery.requestId", { id: unknown })} actions={<Button variant="ghost" size="sm"
          onClick={() => void action("reconcile", { projectId: project.id }).catch(() => {})}>{t("recovery.checkOriginal")}</Button>} /> }
      {backendReady && project.state?.connected && unavailableProfile && <FeedbackNotice tone="warning" message={t("recovery.profileUnavailable")}
        actions={<>
          {profileSelection && resolveDraftProfile(project) && <Button variant="ghost" size="sm" onClick={() => { setProfileSelection(""); localStorage.removeItem(`${key}:profile`); }}>{t("recovery.resetProfile")}</Button>}
          <Button variant="ghost" size="sm" onClick={() => onPanel("会话配置")}>{t("recovery.checkSessionSettings")}</Button>
        </>} />}
      {draftError && <FeedbackNotice tone="error" message={isTechnicalErrorMessage(draftError) ? t("recovery.operationFailed") : draftError}
        detail={isTechnicalErrorMessage(draftError) ? draftError : undefined} />}
      {reviewDraft.error && <p role="alert" className="px-3 py-2 text-ui-sm text-destructive">{reviewDraft.error}</p>}
      <div className="composer-input-stack">
      <div ref={setMenuAnchor} className="composer-menu-anchor" />
      <ChatPromptEditor
        surfaceLayout={surfaceLayout}
        triggerPanelContainer={menuAnchor}
        shellClassName="@container/composer"
        workspacePath={project.root}
        taskId={null}
        initialValue={text}
        inputApiRef={api}
        inputTestId="chat-input"
        submitTestId="chat-send-button"
        placeholder={goalMode ? "描述目标，明确可衡量的结果" : plan ? "描述任务，生成计划…" : "随心输入"}
        disabled={editLocked}
        submitDisabled={submitDisabled || annotationBlocked || (desktopUnsupported && !goalMode) || (goalMode ? !input.text.trim() : !input.text.trim() && !input.files.length && !comments.length && !skills.selected.length)}
        submitDisabledReason={desktopUnsupported && !goalMode ? t("backend.updateRequired") : undefined}
        submitting={busy}
        submitLabel={goalMode ? "开始目标" : "发送"}
        enterSubmits={prefs.sendShortcut === "enter"}
        enableMentionPanel={false}
        composerCatalog={{ ...skills.catalog, loading: executionReady && skills.catalog.loading,
          error: executionReady ? skills.catalog.error : undefined,
          refresh: () => { if (executionReady && !editLocked) skills.catalog.refresh(); }, entries: [
          { value: "upload", label: "上传文件", description: "添加图片、文档或其他文件", group: "功能", icon: <AttachmentIcon />, disabled: editLocked, run: () => { if (!editLocked) upload.current?.click(); } },
          ...(project.id !== "projectless" ? [{ value: "mcp", label: "MCP", description: "查看服务器与连接状态", group: "功能" as const, icon: <ComposerMcpIcon />, disabled: !executionReady, run: () => { if (executionReady) setMcpOpen(true); } }] : []),
          ...(project.root ? [{ value: "files", label: "工作区文件", description: "引用当前项目中的文件", group: "功能" as const, icon: <FileTree />, disabled: !executionReady, run: () => { if (executionReady) onPanel("文件"); } }] : []),
          { value: "plan", label: "计划模式", description: plan ? "关闭计划模式" : "先规划，再开始执行", group: "功能", icon: <Lightbulb />, disabled: editLocked || chosenProfile?.readOnly === true, run: () => { if (!editLocked) setPlanMode(!plan); } },
          { value: "goal", label: "设置目标", description: goalMode ? "关闭目标模式" : "设置持续目标与停止条件", group: "功能", icon: <GoalIcon />, disabled: editLocked, run: () => { if (!editLocked) changeGoalMode(!goalMode); } },
          ...appEntries.map(entry => ({ ...entry, disabled: entry.disabled || !executionReady })),
          ...skills.catalog.entries.map(entry => ({ ...entry, disabled: entry.disabled || !executionReady })),
        ] }}
        onChange={(value) => {
          setText(value);
          localStorage.setItem(key, value);
        }}
        onSubmit={(value) => {
          void submit(value);
          return false;
        }}
        onPaste={event => { if (!editLocked) composerPaste(event, pasted => setFiles(current => [...current, ...pasted])); }}
        topContent={
          <>{skills.tags}<div className="composer-attachment-row">
          {files.length ? (
            <div className="composer-attachments" data-testid="composer-attachments">
              {files.map((file, i) => <ComposerAttachment disabled={editLocked} key={isComposerFile(file) ? `${file.name}-${file.lastModified}-${i}` : `pasted-text-${i}`} file={file}
                onAnnotate={onAnnotate ? file => { if (!editLocked) onAnnotate({ draftKey: key, file, returnFocus: () => api.current?.focus() }); } : undefined}
                onRemove={() => { if (!editLocked) setFiles((current) => current.filter((_, at) => at !== i)); }}
                onExpand={content => { if (editLocked) return; api.current?.appendText(`${text.length ? "\n\n" : ""}${content}`); setFiles(current => current.filter(item => item !== file)); }} />)}
            </div>
          ) : null}
          <ReviewCommentAttachment comments={comments} disabled={editLocked} onRemove={() => detachReviewComments(reviewKey)} />
          </div></>
        }
        leadingActions={
          <>{!executionReady && preparationStatus}{executionReady && <ComposerPermissionMenu value={chosenProfile?.readOnly ? "readOnly" : permission} disabled={submitDisabled}
            permissionsSupported={project.core?.features?.permissionPresets === true}
            fullAccessAvailable={project.core?.features?.permissionFullAccess === true}
            lockedReadOnly={chosenProfile?.readOnly === true}
            onChange={value => { setPermission(value); localStorage.setItem(`${key}:permission`, value); setApplicationPreferences({ defaultPermissionPreset: value }); }} onClose={() => api.current?.focus()} />}
          {goalMode && <Button type="button" variant="ghost" disabled={editLocked} aria-label="退出目标模式" onClick={() => changeGoalMode(false)}><GoalIcon size={16} />目标</Button>}
          {plan && <ComposerPlanMode disabled={editLocked || chosenProfile?.readOnly === true} onExit={() => setPlanMode(false)} />}</>
        }
        betweenCancelAndSubmitAction={executionReady && <ComposerModelMenu
          value={effectiveModel} disabled={modelSelectionDisabled}
          effort={effort} onEffortChange={value => {
            setModel(effectiveModel); localStorage.setItem(`${key}:model`, effectiveModel);
            const next = { ...efforts, [effectiveModel]: value };
            setEfforts(next); localStorage.setItem(`${key}:efforts`, JSON.stringify(next));
          }}
          options={[
            ...project.models.filter((item: Data) => item.providerId || !project.models.some((candidate: Data) => candidate.providerId && candidate.isDefault)).map((item: Parameters<typeof composerModelOption>[0]) => ({ ...composerModelOption(item), value: modelValue(item) })),
            ...(!currentModel && effectiveModel ? [{ value: effectiveModel, label: effectiveModel.slice(effectiveModel.indexOf("/") + 1), unavailableReason: "模型不可用" }] : []),
          ]}
          onChange={value => { setModel(value); localStorage.setItem(`${key}:model`, value); }}
          onClose={() => api.current?.focus()}
        />}
      />
      </div>
      {executionReady && preferenceNotice && <p className="composer-preference-notice" role="status">{preferenceNotice}</p>}
      <ComposerMcp projectId={project.id} action={readAction} open={executionReady && mcpOpen} anchor={menuAnchor} onClose={() => { setMcpOpen(false); api.current?.focus(); }} />
    </div>
  );
}
