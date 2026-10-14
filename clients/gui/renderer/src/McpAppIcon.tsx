import { useEffect, useState } from "react";
/** HTTPS metadata is fetched only by the Main process after checking its server grant. */
export function McpAppIcon({ icon, size = 24 }: { icon?: { src: string }; size?: number }) {
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
        const desktop = (
            window as unknown as {
                arealDesktop?: { mcpApp: (request: Record<string, unknown>) => Promise<unknown> };
            }
        ).arealDesktop;
        if (icon.src.startsWith("https://") && desktop)
            void desktop
                .mcpApp({ operation: "metadataImage", source: icon.src })
                .then((value) => {
                    if (active && typeof value === "string") setSource(value);
                })
                .catch(() => {
                    if (active) setFailed(true);
                });
        return () => {
            active = false;
        };
    }, [icon?.src]);
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
