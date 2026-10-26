import { useState } from "react";
import { attachmentDrafts } from "../Composer.js";
import {
  imageAnnotation,
  setImageAnnotationEditing,
  useImageAnnotationPending,
  type ImageAnnotationTarget,
} from "../imageAnnotations.js";
import type { useWorkspacePanels } from "./useWorkspacePanels.js";

export function useWorkspaceAnnotation(
  panelOwner: string,
  workspacePanels: ReturnType<typeof useWorkspacePanels>,
) {
  const { panel, workspaceView } = workspacePanels.view;
  const [annotationTarget, setAnnotationTarget] = useState<
    | (ImageAnnotationTarget & {
        owner: string;
        previousView: "split" | "panel" | "conversation";
        previousPanel: string;
        sessionId: string;
      })
    | null
  >(null);
  const annotationPending = useImageAnnotationPending(annotationTarget?.file);
  const annotationVisible = annotationTarget?.owner === panelOwner;
  const openImageAnnotation = (target: ImageAnnotationTarget) => {
    setAnnotationTarget({
      ...target,
      owner: panelOwner,
      previousView: workspaceView,
      previousPanel: panel,
      sessionId: crypto.randomUUID(),
    });
    workspacePanels.selectLayout("split");
  };
  const finishImageAnnotation = () => {
    if (!annotationTarget) return;
    const pending = imageAnnotation(annotationTarget.file)?.pending;
    if (pending && pending.kind !== "idle") return;
    setAnnotationTarget(null);
    workspacePanels.selectLayout(annotationTarget.previousView);
    requestAnimationFrame(annotationTarget.returnFocus);
  };
  const reconcileTarget = () => {
    if (!annotationTarget) return;
    if (annotationTarget.owner !== panelOwner || annotationTarget.previousPanel !== panel) {
      setAnnotationTarget(null);
      return;
    }
    setImageAnnotationEditing(annotationTarget.draftKey, true);
    return () => setImageAnnotationEditing(annotationTarget.draftKey, false);
  };
  const subscribeDraft = () => {
    if (!annotationTarget) return;
    const refresh = () => {
      if (attachmentDrafts.get(annotationTarget.draftKey)?.includes(annotationTarget.file)) return;
      setAnnotationTarget(null);
      if (annotationTarget.owner === panelOwner)
        workspacePanels.selectLayout(annotationTarget.previousView);
    };
    window.addEventListener("areal-attachments-change", refresh);
    window.addEventListener("areal-draft-change", refresh);
    return () => {
      window.removeEventListener("areal-attachments-change", refresh);
      window.removeEventListener("areal-draft-change", refresh);
    };
  };
  return {
    annotationTarget,
    annotationPending,
    annotationVisible,
    openImageAnnotation,
    finishImageAnnotation,
    reconcileTarget,
    subscribeDraft,
  };
}
