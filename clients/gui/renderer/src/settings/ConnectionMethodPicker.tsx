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
        <section className="provider-picker" aria-label="选择连接方式">
            <div className="provider-picker-heading">
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
            <div className="provider-method-list">
                {(definition.authMethods ?? ["apiKey", "none"]).map((method: string) => (
                    <Button
                        key={method}
                        variant="outline"
                        disabled={disabled}
                        className="provider-method-card"
                        onClick={() => onSelect(method)}
                    >
                        <span className="provider-method-copy">
                            <strong>{methods[method]?.label ?? method}</strong>
                            <small>
                                {methods[method]?.description}
                            </small>
                        </span>
                    </Button>
                ))}
            </div>
        </section>
    );
}
