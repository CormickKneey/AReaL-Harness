import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useState } from "react";
import { SettingsPage } from "../settings/SettingsWorkspace.js";
import { SettingsSelect } from "../settings/SettingsPageParts.js";
import { Switch } from "../components/ui/switch.js";
import { Feedback } from "../components/ui/feedback.js";
import { ActionButton } from "../components/ui/action-button.js";

// 固定题目内容；控件、变体和布局全部来自 Base，未连接真实通知服务。
const content = {
  reference: [
    ["Turn completion notifications", "Set when ChatGPT alerts you that it's finished"],
    ["Enable permission notifications", "Show alerts when notification permissions are required"],
    ["Enable question notifications", "Show alerts when input is needed to continue"],
    ["Enable dot notifications", "Show alerts when your dot sends you a message"],
    ["Notification sound", "Sound for task completion, permission requests, and questions"],
  ],
  stress: [
    [
      "长任务完成后的桌面通知与工作区提醒",
      "当后台研究、代码检查或图片生成完成时通知我；保留当前工作区内容，不强制切换焦点。 Long-running tasks keep their original workspace.",
    ],
    [
      "需要批准权限时保留明确的通知入口",
      "当操作需要用户批准时显示提醒，说明应处理的事项；通知本身不代表已经批准，也不自动重复提交。",
    ],
    [
      "需要补充输入才能继续任务时提醒我",
      "问题说明和操作入口应在较大字号及较窄面板中保持可读；较长的英文说明也应自然换行。 Keep the full explanation readable.",
    ],
    [
      "接收来自桌面助手的消息提醒",
      "只改变这个模拟页中的开关状态；切换主题和宽度时保留当前值，避免重建页面导致偏好丢失。",
    ],
    [
      "任务完成、权限请求和问题提醒的提示音",
      "提示音是三个互斥选项，当前值应可读；打开后取消保持原值，明确选择后更新。",
    ],
  ],
} as const;

export function SettingsReflowExercise({
  stress,
  state,
}: {
  stress: boolean;
  state: "ready" | "busy" | "failed" | "unknown";
}) {
  const rows = content[stress ? "stress" : "reference"];
  const [completion, setCompletion] = useState("unfocused");
  const [sound, setSound] = useState("default");
  const [enabled, setEnabled] = useState([true, true, true]);
  const unavailable = state === "busy" || state === "unknown";
  return (
    <section
      className="design-preview-panel"
      aria-label="设置迁移题"
      data-case={stress ? "stress" : "reference"}
    >
      <SettingsPage>
        <SettingsSection title="Notifications">
          <SettingsGroupCard>
            <SettingsRow
              label={rows[0][0]}
              description={rows[0][1]}
              control={
                <SettingsSelect
                  aria-label="Turn completion notifications"
                  disabled={unavailable}
                  value={completion}
                  onValueChange={setCompletion}
                >
                  <option value="never">Never</option>
                  <option value="unfocused">Only when unfocused</option>
                  <option value="always">Always</option>
                </SettingsSelect>
              }
            />
            {rows.slice(1, 4).map(([label, description], index) => (
              <SettingsRow
                key={index}
                label={label}
                description={description}
                control={
                  <Switch
                    aria-label={content.reference[index + 1][0]}
                    checked={enabled[index]}
                    disabled={unavailable}
                    onCheckedChange={(checked) =>
                      setEnabled((values) =>
                        values.map((value, position) => (position === index ? checked : value)),
                      )
                    }
                  />
                }
              />
            ))}
            <SettingsRow
              label={rows[4][0]}
              description={rows[4][1]}
              control={
                <SettingsSelect
                  aria-label="Notification sound"
                  disabled={unavailable}
                  value={sound}
                  onValueChange={setSound}
                >
                  <option value="default">Default</option>
                  <option value="none">None</option>
                  <option value="soft">Soft</option>
                </SettingsSelect>
              }
            />
          </SettingsGroupCard>
          <Feedback
            error={state === "failed" ? "模拟操作未受理，当前值已保留。" : undefined}
            message={
              state === "unknown"
                ? "结果待核对，当前值已保留。"
                : state === "busy"
                  ? "正在处理，当前值已保留。"
                  : undefined
            }
          />
          <ActionButton disabled>Unavailable preview action</ActionButton>
        </SettingsSection>
      </SettingsPage>
    </section>
  );
}
