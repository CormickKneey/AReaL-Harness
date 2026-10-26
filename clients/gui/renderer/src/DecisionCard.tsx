import type { ComponentProps } from "react";
import { DecisionCard as View } from "@areal/ui/compositions";
import { Feedback } from "./components/ui/feedback.js";
import "@areal/ui/conversation.css";
export function DecisionCard({
  error,
  message,
  ...props
}: Omit<ComponentProps<typeof View>, "feedback" | "regionLabel"> & {
  error?: string;
  message?: string;
}) {
  return (
    <View
      {...props}
      regionLabel={props.kind === "approval" ? "工具审批" : "需要你的回答"}
      feedback={<Feedback error={error} message={message} />}
    />
  );
}
