import { CodeViewer as View, type CodeViewerProps } from "@areal/ui/experimental";
import { useCodePreferences } from "../../settings/preferences.js";
export {
  CodeCommentAnnotation,
  resolveCodeViewerColorScheme,
  isCodeCommentSubmitShortcut,
  isCodeCommentCancelShortcut,
  formatCodeCommentSubmitShortcutLabel,
  formatCodeCommentCancelShortcutLabel,
} from "@areal/ui/experimental";
export type { CodeViewerProps, CodeCommentLabels } from "@areal/ui/experimental";
export function CodeViewer(props: CodeViewerProps) {
  const prefs = useCodePreferences();
  const mode = document.documentElement.classList.contains("dark") ? "dark" : "light";
  return <View {...prefs} theme={prefs[`${mode}Theme`]} {...props} />;
}
