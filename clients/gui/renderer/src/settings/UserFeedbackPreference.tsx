import { useState } from "react";
import type { Action } from "../services.js";
import { refreshFeedbackAvailability, useFeedbackAvailability } from "../user-feedback-status.js";
import { Switch } from "../components/ui/switch.js";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "./SettingsPageParts.js";

export function UserFeedbackPreference({
    action,
    connected,
}: {
    action: Action;
    connected: boolean;
}) {
    const value = useFeedbackAvailability(action, connected);
    const [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const change = async (enabled: boolean) => {
        if (!connected || busy || !value.supported) return;
        setBusy(true);
        setError("");
        try {
            await action("feedback", { operation: "preference", enabled });
            await refreshFeedbackAvailability(action);
        } catch (cause) {
            setError((cause as Error).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <SettingsSection title="回答评价" description="自愿提交点赞或点踩，帮助改进回答质量。">
            <SettingsGroupCard>
                <SettingsRow
                    label="显示点赞和点踩"
                    description="启用数据飞轮并连接支持评价的接收端后，在回复下方显示。点击图标不会自动提交。"
                    control={
                        <Switch
                            aria-label="显示点赞和点踩"
                            checked={value.opted_in}
                            disabled={!connected || busy || !value.supported}
                            onCheckedChange={(enabled) => void change(enabled)}
                        />
                    }
                />
            </SettingsGroupCard>
            {connected && !value.supported && (
                <p role="status" className="settings-section-desc">
                    当前后台未提供可用的评价状态，暂时无法更改。
                </p>
            )}
            {error && (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            )}
        </SettingsSection>
    );
}
