import { ArrowLeft } from "lucide-react";
import { Button } from "../components/ui/button.js";
import type { Data } from "../services.js";

const methods: Record<string, { label: string; description: string }> = {
    apiKey: {
        label: "使用 API Key",
        description: "凭据保存在本机安全存储；请求按服务商的 API 方式计费。",
    },
    none: {
        label: "无需认证",
        description: "用于本地服务或无需凭据的兼容连接，计费由服务商决定。",
    },
    siwc: {
        label: "使用 ChatGPT 订阅",
        description: "在浏览器授权，模型和应用用量来自所选 ChatGPT 账号。",
    },
};
export function ConnectionMethodPicker({
    definition,
    onBack,
    onSelect,
    disabled,
}: {
    definition: Data;
    onBack: () => void;
    onSelect: (method: string) => void;
    disabled: boolean;
}) {
    return (
        <section className="space-y-5" aria-label="选择连接方式">
            <div className="resource-title">
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="返回服务商选择"
                    disabled={disabled}
                    onClick={onBack}
                >
                    <ArrowLeft />
                </Button>
                <h2>{definition.name} · 连接方式</h2>
            </div>
            <p className="settings-muted">选择认证方式，再连接服务并配置模型。</p>
            <div className="grid gap-3">
                {(definition.authMethods ?? ["apiKey", "none"]).map((method: string) => (
                    <Button
                        key={method}
                        variant="outline"
                        disabled={disabled}
                        className="h-auto justify-start whitespace-normal px-4 py-4 text-left"
                        onClick={() => onSelect(method)}
                    >
                        <span>
                            <strong className="block">{methods[method]?.label ?? method}</strong>
                            <small className="block pt-1 font-normal text-foreground-subtle">
                                {methods[method]?.description}
                            </small>
                        </span>
                    </Button>
                ))}
            </div>
        </section>
    );
}
