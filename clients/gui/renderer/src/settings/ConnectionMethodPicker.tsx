import { ArrowLeft } from "lucide-react";
import { Button } from "../components/ui/button.js";
import type { Data } from "../services.js";

const methods: Record<string, { label: string; description: string }> = {
    apiKey: {
        label: "使用 API Key",
        description: "API 计费 · 本机保存",
    },
    none: {
        label: "无需认证",
        description: "本地或兼容服务",
    },
    siwc: {
        label: "使用 ChatGPT 订阅",
        description: "订阅计费 · 浏览器授权",
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
