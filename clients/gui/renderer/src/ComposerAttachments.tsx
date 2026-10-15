import { useEffect, useState } from "react";
import type { ChatComposerPasteEvent } from "./LexicalChatInput.js";
import { ScanText } from "lucide-react";
import { CloseIcon } from "./interfaceIcons.js";

export type ComposerDraftAttachment = File | {
    readonly kind: "pasted-text";
    readonly text: string;
};

export function isComposerFile(attachment: ComposerDraftAttachment): attachment is File {
    return !("kind" in attachment && attachment.kind === "pasted-text");
}

export function composerInput(body: string, parts: readonly ComposerDraftAttachment[]): { text: string; files: File[] } {
    const text = body.length ? [body] : [];
    const files: File[] = [];
    for (const part of parts) {
        if (isComposerFile(part)) files.push(part);
        else if (part.text.length) text.push(part.text);
    }
    return { text: text.join("\n\n"), files };
}

export function composerPaste(event: ChatComposerPasteEvent, add: (files: ComposerDraftAttachment[]) => void) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) {
        event.preventDefault();
        add(files);
        return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.length > 200 || text.split("\n").length >= 5) {
        event.preventDefault();
        add([{ kind: "pasted-text", text }]);
    }
}
const isText = (file: File) =>
    file.type.startsWith("text/") ||
    /\.(txt|md|json|ya?ml|csv|log|tsx?|jsx?|css|html|py|rs|toml)$/i.test(file.name);
export function ComposerAttachment({
    file,
    disabled,
    onRemove,
    onExpand,
}: {
    file: ComposerDraftAttachment;
    disabled?: boolean;
    onRemove: () => void;
    onExpand: (text: string) => void;
}) {
    const [url, setUrl] = useState("");
    const [error, setError] = useState("");
    const [reading, setReading] = useState(false);
    const actualFile = isComposerFile(file) ? file : null;
    const name = actualFile ? actualFile.name : "粘贴的文本.txt";
    const image = actualFile?.type.startsWith("image/") === true;
    useEffect(() => {
        if (!image || !actualFile) return;
        const value = URL.createObjectURL(actualFile);
        setUrl(value);
        return () => URL.revokeObjectURL(value);
    }, [actualFile, image]);
    return (
        <div
            className={image ? "composer-image-card" : "composer-text-card"}
            data-testid="composer-attachment"
        >
            {image ? (
                <img src={url} alt={name} />
            ) : (
                <>
                    <span className="composer-text-icon">
                        <ScanText size={22} />
                    </span>
                    <div className="composer-text-copy">
                        <span title={name}>{name}</span>
                        {!actualFile || isText(actualFile) ? (
                            <button
                                type="button"
                                disabled={disabled || reading}
                                onClick={async () => {
                                    setReading(true);
                                    setError("");
                                    try {
                                        const size = isComposerFile(file) ? file.size : new TextEncoder().encode(file.text).byteLength;
                                        if (size > 1024 * 1024)
                                            throw new Error(
                                                "文本超过展开上限 1 MiB，请作为附件发送",
                                            );
                                        const text = isComposerFile(file) ? new TextDecoder("utf-8", {
                                            fatal: true,
                                        }).decode(await file.arrayBuffer()) : file.text;
                                        onExpand(text);
                                    } catch (cause) {
                                        setError(
                                            `无法展开 ${name}：${(cause as Error).message}`,
                                        );
                                    } finally {
                                        setReading(false);
                                    }
                                }}
                            >
                                {reading ? "正在读取…" : "在文本框中显示"} ›
                            </button>
                        ) : (
                            <small>{Math.ceil(actualFile.size / 1024)} KB</small>
                        )}
                    </div>
                </>
            )}
            <button
                type="button"
                className="composer-remove-attachment"
                disabled={disabled || reading}
                aria-label={`移除附件 ${name}`}
                onClick={onRemove}
            >
                <CloseIcon size={12} />
            </button>
            {error && (
                <p role="alert" className="composer-attachment-error">
                    {error}
                </p>
            )}
        </div>
    );
}
