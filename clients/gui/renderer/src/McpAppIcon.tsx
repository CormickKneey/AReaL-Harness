import { useEffect, useState } from "react";
import type { McpMetadataImageLoader } from "./mcp-app-services.js";
export function McpAppIcon({ icon, size = 24, loadMetadataImage }: { icon?: { src: string }; size?: number; loadMetadataImage?: McpMetadataImageLoader }) {
    const [failed, setFailed] = useState(false);
    const [source, setSource] = useState<string>();
    useEffect(() => {
        let active = true;
        setFailed(false);
        setSource(undefined);
        if (!icon?.src) return;
        if (icon.src.startsWith("data:image/")) {
            setSource(icon.src);
            return;
        }
        if (icon.src.startsWith("https://") && loadMetadataImage)
            void loadMetadataImage(icon.src)
                .then((value) => {
                    if (active && typeof value === "string") setSource(value);
                })
                .catch(() => {
                    if (active) setFailed(true);
                });
        return () => {
            active = false;
        };
    }, [icon?.src, loadMetadataImage]);
    return !failed &&
        source &&
        /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(source) ? (
        <img src={source} alt="" width={size} height={size} onError={() => setFailed(true)} />
    ) : (
        <span
            aria-hidden="true"
            style={{
                display: "inline-flex",
                width: size,
                height: size,
                alignItems: "center",
                justifyContent: "center",
            }}
        >
            ▧
        </span>
    );
}
