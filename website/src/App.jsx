import { useEffect, useRef, useState } from "react";
import {
    IconArrowRight,
    IconBrandAppleFilled,
    IconBrandGithubFilled,
    IconBrandUbuntu,
    IconChevronDown,
    IconDownload,
    IconCopy,
    IconExternalLink,
} from "@tabler/icons-react";
import catalog from "./generated/releases.json";
import {
    platforms,
    officialRepository,
    translations,
    resolveSelection,
    changeClient,
    readSelection,
    readLocale,
    localeUrl,
    docsUrl,
} from "./site-model.mjs";

const assetPath = (name) => `${import.meta.env.BASE_URL}assets/${name}`;

function CopyableDownloadField({ label, value, copy }) {
    const [feedback, setFeedback] = useState(null);
    const latestRequest = useRef(0);
    const status = feedback?.value === value ? feedback.status : null;

    async function copyValue() {
        const request = ++latestRequest.current;
        setFeedback({ value, status: "pending" });
        try {
            await navigator.clipboard.writeText(value);
            if (request === latestRequest.current) setFeedback({ value, status: "copied" });
        } catch {
            if (request === latestRequest.current) setFeedback({ value, status: "failed" });
        }
    }

    return (
        <div className="copyable-download-field">
            <div className="download-field-heading">
                <span>{label}</span>
                <button
                    type="button"
                    onClick={copyValue}
                    disabled={status === "pending"}
                    aria-label={`${copy.copy} ${label}`}
                >
                    <IconCopy size={15} aria-hidden="true" />
                    {status === "copied" ? copy.copied : status === "pending" ? copy.copying : copy.copy}
                </button>
            </div>
            <code className="download-field-value" tabIndex={0} aria-label={label}>
                {value}
            </code>
            <p className={status === "failed" ? "copy-feedback" : "sr-only"} role="status">
                {status === "failed" ? copy.copyFailed : status === "copied" ? copy.copied : ""}
            </p>
        </div>
    );
}

export function App() {
    const [selection, setSelection] = useState(() => readSelection(window.location.search));
    const [locale, setLocale] = useState(() => {
        let stored = null;
        try {
            stored = localStorage.getItem("areal-language");
        } catch {
            /* Storage is optional in private or restricted browsers. */
        }
        return readLocale(window.location.search, stored);
    });
    const copy = translations[locale];
    const resolved = resolveSelection(catalog, selection);
    const release = resolved.release;
    const PlatformIcon =
        selection.platform === "macos-arm64" ? IconBrandAppleFilled : IconBrandUbuntu;
    const requirements =
        selection.client === "gui"
            ? copy.guiRequirements
            : selection.platform === "macos-arm64"
              ? copy.tuiMacRequirements
              : copy.tuiLinuxRequirements;

    useEffect(() => {
        document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
        document.title = copy.title;
        document
            .querySelector('meta[name="description"]')
            .setAttribute("content", copy.description);
        try {
            localStorage.setItem("areal-language", locale);
        } catch {
        }
        const url = new URL(localeUrl(window.location.href, locale), window.location.origin);
        for (const [key, value] of Object.entries(selection)) url.searchParams.set(key, value);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }, [locale, selection, copy]);

    return (
        <>
            <a className="skip-link" href="#main">
                {copy.skip}
            </a>
            <div className="site-shell">
                <header className="site-header">
                    <a className="wordmark" href="#overview" aria-label="AReaL-Harness">
                        AReaL-Harness
                    </a>
                    <nav className="main-nav" aria-label={copy.navigation}>
                        <a href="#overview">{copy.overview}</a>
                        <a href="#downloads">{copy.downloads}</a>
                        <a href={docsUrl(locale)}>{copy.docs}</a>
                    </nav>
                    <div className="header-tools">
                        <div className="language-switch" role="group" aria-label={copy.language}>
                            <button
                                type="button"
                                aria-pressed={locale === "en"}
                                aria-label={copy.enLabel}
                                onClick={() => setLocale("en")}
                            >
                                EN
                            </button>
                            <span aria-hidden="true">/</span>
                            <button
                                type="button"
                                aria-pressed={locale === "zh"}
                                aria-label={copy.zhLabel}
                                onClick={() => setLocale("zh")}
                            >
                                中文
                            </button>
                        </div>
                        <a
                            className="github-icon"
                            href={officialRepository}
                            aria-label={copy.githubLabel}
                            title={copy.githubLabel}
                        >
                            <IconBrandGithubFilled size={21} aria-hidden="true" />
                        </a>
                    </div>
                </header>
                <main id="main">
                    <section id="overview" className="hero" aria-labelledby="hero-title">
                        <p className="eyebrow">{copy.eyebrow}</p>
                        <h1 id="hero-title">
                            <span>{copy.headline}</span><em>{copy.headlineAccent}</em>
                        </h1>
                        <p className="hero-intro">
                            {copy.intro}
                            <br />
                            {copy.introSecond}
                        </p>
                        <div className="hero-actions">
                            <a className="button button-primary" href="#downloads">
                                {copy.downloadPrimary}
                                <IconArrowRight size={19} aria-hidden="true" />
                            </a>
                            <a className="button button-secondary" href={docsUrl(locale)}>
                                {copy.readDocs}
                            </a>
                        </div>
                    </section>

                    <section
                        id="downloads"
                        className="downloads-section"
                        aria-labelledby="download-title"
                    >
                        <h2 id="download-title" className="sr-only">
                            {copy.downloadHeading}
                        </h2>
                        <div className="download-console">
                            <div className="console-toolbar">
                                <div
                                    className="client-switch"
                                    role="group"
                                    aria-label={copy.clientGroup}
                                >
                                    {["gui", "tui"].map((client) => (
                                        <button
                                            type="button"
                                            key={client}
                                            aria-pressed={selection.client === client}
                                            onClick={() =>
                                                setSelection(changeClient(selection, client))
                                            }
                                        >
                                            {copy[client]}
                                        </button>
                                    ))}
                                </div>
                                <div
                                    className="channel-switch"
                                    role="group"
                                    aria-label={copy.channelGroup}
                                >
                                    {["stable", "preview"].map((channel) => (
                                        <button
                                            type="button"
                                            key={channel}
                                            aria-pressed={selection.channel === channel}
                                            onClick={() => setSelection({ ...selection, channel })}
                                        >
                                            {copy[channel]}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="download-details" aria-live="polite">
                                <div className="platform-icon">
                                    <PlatformIcon size={34} stroke={1.5} aria-hidden="true" />
                                </div>
                                <div className="platform-details">
                                    {platforms[selection.client].length > 1 ? (
                                        <div className="platform-select">
                                            <label className="sr-only" htmlFor="platform">
                                                {copy.platformLabel}
                                            </label>
                                            <select
                                                id="platform"
                                                value={selection.platform}
                                                onChange={(event) =>
                                                    setSelection({
                                                        ...selection,
                                                        platform: event.target.value,
                                                    })
                                                }
                                            >
                                                {platforms[selection.client].map((platform) => (
                                                    <option key={platform} value={platform}>
                                                        {copy.platformNames[platform]}
                                                    </option>
                                                ))}
                                            </select>
                                            <IconChevronDown size={15} aria-hidden="true" />
                                        </div>
                                    ) : (
                                        <p className="platform-name">
                                            {copy.platformNames[selection.platform]}
                                        </p>
                                    )}
                                    <p className="package-description">
                                        {selection.client === "gui"
                                            ? copy.guiDescription
                                            : copy.tuiDescription}
                                    </p>
                                    <p className="requirements">{requirements}</p>
                                </div>
                                <div className="release-version">
                                    {release ? (
                                        <>
                                            <span>v{release.version}</span>
                                            <span className="release-channel">
                                                {copy[selection.channel]}
                                            </span>
                                        </>
                                    ) : (
                                        <span>{copy.unavailable}</span>
                                    )}
                                </div>
                                {resolved.status === "ready" ? (
                                    <a
                                        className="button button-primary download-button"
                                        href={resolved.asset.url}
                                    >
                                        <span>
                                            {copy.download} .{resolved.asset.format.toUpperCase()}
                                        </span>
                                        <IconDownload size={17} aria-hidden="true" />
                                    </a>
                                ) : (
                                    <button
                                        type="button"
                                        className="button download-button"
                                        disabled
                                    >
                                        {copy.unavailable}
                                    </button>
                                )}
                            </div>
                            {resolved.status !== "ready" && (
                                <p className="availability-message" role="status">
                                    {resolved.status === "no-release"
                                        ? copy.noRelease
                                        : copy.noPlatform}
                                </p>
                            )}
                            {resolved.downloadCommand && (
                                <div className="terminal-downloads">
                                    <CopyableDownloadField
                                        label={copy.downloadCommand}
                                        value={resolved.downloadCommand}
                                        copy={copy}
                                    />
                                    <CopyableDownloadField
                                        label={copy.downloadUrl}
                                        value={resolved.asset.url}
                                        copy={copy}
                                    />
                                    <p className="download-only">{copy.downloadOnly}</p>
                                </div>
                            )}
                            <div className="download-links">
                                <a
                                    href={
                                        selection.client === "gui"
                                            ? docsUrl(locale, "clients/gui/README")
                                            : docsUrl(locale, "docs/guides/installation")
                                    }
                                >
                                    {copy.installation}
                                </a>
                                {release && <a href={release.notesUrl}>{copy.notes}</a>}
                                {release?.checksumUrl && (
                                    <a href={release.checksumUrl}>{copy.checksums}</a>
                                )}
                                {release?.installerUrl && (
                                    <a href={release.installerUrl}>{copy.installer}</a>
                                )}
                                <a href={`${officialRepository}/releases`}>
                                    {copy.allReleases}
                                    <IconExternalLink size={12} aria-hidden="true" />
                                </a>
                            </div>
                        </div>
                        {selection.channel === "preview" ? (
                            <p className="channel-notice preview-notice" role="note">
                                {copy.previewWarning}
                            </p>
                        ) : selection.client === "gui" ? (
                            <p className="channel-notice">{copy.notarized}</p>
                        ) : (
                            <p className="channel-notice">{copy.tuiPlatforms}</p>
                        )}
                        <p className="also-available">
                            {copy.alsoAvailable}
                            <button
                                type="button"
                                onClick={() =>
                                    setSelection(
                                        changeClient(
                                            selection,
                                            selection.client === "gui" ? "tui" : "gui",
                                        ),
                                    )
                                }
                            >
                                {selection.client === "gui"
                                    ? copy.tuiPlatforms
                                    : `${copy.gui} · macOS ARM64`}
                                <IconArrowRight size={13} aria-hidden="true" />
                            </button>
                        </p>
                    </section>

                    <section className="action-section" aria-labelledby="action-title">
                        <p className="section-eyebrow">
                            <span />
                            {copy.actionEyebrow}
                            <span />
                        </p>
                        <h2 id="action-title" className="action-title">
                            {copy.actionTitle}
                        </h2>
                        <figure className="terminal-figure">
                            <a
                                className="terminal-image-link"
                                href={assetPath("tui.png")}
                                aria-label={copy.fullScreenshot}
                            >
                                <img
                                    className="terminal-image"
                                    src={assetPath("tui.png")}
                                    alt={copy.imageAlt}
                                    width="3074"
                                    height="1986"
                                    loading="lazy"
                                />
                            </a>
                            <figcaption>
                                {copy.imageCaption}
                                <a href={assetPath("tui.png")}>
                                    {copy.fullScreenshot}
                                    <IconExternalLink size={12} aria-hidden="true" />
                                </a>
                            </figcaption>
                        </figure>
                    </section>

                    <section className="capabilities" aria-labelledby="capabilities-title">
                        <h2 id="capabilities-title" className="sr-only">
                            {copy.capabilities}
                        </h2>
                        {[1, 2, 3].map((number) => (
                            <article className="capability" key={number}>
                                <div className="capability-number">
                                    <span>0{number}</span>
                                    <span />
                                </div>
                                <h3>{copy[`feature${number}Title`]}</h3>
                                <p>{copy[`feature${number}Body`]}</p>
                            </article>
                        ))}
                    </section>
                </main>
                <footer className="site-footer">
                    <div className="footer-brand">
                        <img src={assetPath("milk-tea-logo.svg")} alt="" width="22" height="25" />
                        <span>AReaL-Harness</span>
                        <span>{copy.footerText}</span>
                    </div>
                    <div className="footer-links">
                        <a href={docsUrl(locale, "docs/features")}>{copy.limitations}</a>
                        <a href={officialRepository}>{copy.source}</a>
                    </div>
                    <p className="snapshot">
                        {copy.snapshot}{" "}
                        <time dateTime={catalog.generatedAt}>
                            {new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                                timeZone: "UTC",
                            }).format(new Date(catalog.generatedAt))}
                        </time>
                    </p>
                </footer>
            </div>
        </>
    );
}
