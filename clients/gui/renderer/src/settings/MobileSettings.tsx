import { useI18n, formatUiMessage, type MessageId, type Translate, type UiMessage } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useEffect, useRef, useState } from "react";
import { Check, Monitor, ShieldCheck, Smartphone } from "lucide-react";
import "./MobileSettings.css";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { SettingsSection, SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";
import type { Action, Data } from "../services.js";

const networkDiagnostics: Record<string, MessageId> = {
    "funnel-capability-unknown": "settings.mobileSettings.networkDiagnostic.funnelCapabilityUnknown",
    "funnel-port-denied": "settings.mobileSettings.networkDiagnostic.funnelPortDenied",
    "unsupported-funnel-port": "settings.mobileSettings.networkDiagnostic.unsupportedFunnelPort",
    "public-confirmation-required": "settings.mobileSettings.networkDiagnostic.publicConfirmationRequired",
    "unavailable": "settings.mobileSettings.networkDiagnostic.unavailable",
    "unsupported-version": "settings.mobileSettings.networkDiagnostic.unsupportedVersion",
    "not-logged-in": "settings.mobileSettings.networkDiagnostic.notLoggedIn",
    "https-disabled": "settings.mobileSettings.networkDiagnostic.httpsDisabled",
    "https-unknown": "settings.mobileSettings.networkDiagnostic.httpsUnknown",
    "mapping-collision": "settings.mobileSettings.networkDiagnostic.mappingCollision",
    "mapping-exists": "settings.mobileSettings.networkDiagnostic.mappingExists",
    "mapping-changed": "settings.mobileSettings.networkDiagnostic.mappingChanged",
    "mapping-absent": "settings.mobileSettings.networkDiagnostic.mappingAbsent",
    "listener-drift": "settings.mobileSettings.networkDiagnostic.listenerDrift",
    "unverified-listener": "settings.mobileSettings.networkDiagnostic.unverifiedListener",
    "network-changed": "settings.mobileSettings.networkDiagnostic.networkChanged",
    "cleanup-pending": "settings.mobileSettings.networkDiagnostic.cleanupPending",
    "reconciliation-required": "settings.mobileSettings.networkDiagnostic.reconciliationRequired",
    "persistence-failed": "settings.mobileSettings.networkDiagnostic.persistenceFailed",
    "cli-failed": "settings.mobileSettings.networkDiagnostic.cliFailed",
    "timeout": "settings.mobileSettings.networkDiagnostic.timeout",
    "stale-proposal": "settings.mobileSettings.networkDiagnostic.staleProposal",
    "invalid-origin": "settings.mobileSettings.networkDiagnostic.invalidOrigin",
    "invalid-port": "settings.mobileSettings.networkDiagnostic.invalidPort",
};
const networkLoginDiagnostics: Record<string, MessageId> = {
    "logged-in": "settings.mobileSettings.networkLogin.loggedIn",
    "not-logged-in": "settings.mobileSettings.networkLogin.notLoggedIn",
    "approval-required": "settings.mobileSettings.networkLogin.approvalRequired",
    "stopped": "settings.mobileSettings.networkLogin.stopped",
    "starting": "settings.mobileSettings.networkLogin.starting",
    "unknown": "settings.mobileSettings.networkLogin.unknown",
};
const networkDiagnostic = (t: Translate, code: string) =>
    t(networkDiagnostics[code] ?? "settings.mobileSettings.networkStatusUnknown", { code });

function GrantReview({
    device,
    projects,
    pending,
    busy,
    run,
}: {
    device: Data;
    projects: Data[];
    pending?: boolean;
    busy: boolean;
    run: (request: Data) => Promise<void>;
}) {
    const { t } = useI18n();
    const id = device.devicePeerId ?? device.id;
    const [selected, setSelected] = useState<string[]>(device.projectIds ?? []);
    const [preset, setPreset] = useState(
        device.capabilities?.includes("submit") ? "Operator" : "Observer",
    );
    return (
        <fieldset
            aria-label={t(pending ? "settings.mobileSettings.confirmDeviceLabel" : "settings.mobileSettings.authorizeDeviceLabel", { device: id })}
            className="remote-grant"
        >
            <legend>
                <Monitor size={20} />
                {pending ? t("settings.mobileSettings.allowThisBrowserToConnect") : (device.displayName ?? device.name)}
            </legend>
            {pending && (
                <p className="remote-muted">
                    {t("settings.mobileSettings.onceConfirmedItCanAccessTheProjects")}</p>
            )}
            <div className="remote-fingerprint">
                <strong>
                    <ShieldCheck size={18} />
                    {t("settings.mobileSettings.checkTheFullDeviceFingerprint")}</strong>
                <code>{id}</code>
                <p>{t("settings.mobileSettings.compareEveryCharacterWithTheFingerprintShown")}</p>
            </div>
            {!pending && (
                <p>
                    {device.status === "reviewRequired"
                        ? t("settings.mobileSettings.thisOlderDeviceNeedsReviewAndIs")
                        : device.status === "revoked"
                          ? t("settings.mobileSettings.revoked")
                          : t("settings.mobileSettings.authorizedRevisionValue", { value0: device.revision })}
                </p>
            )}
            {device.status !== "revoked" && (
                <>
                    <div className="remote-project-scope">
                        <h3>{t("settings.mobileSettings.chooseAccessibleProjects")}</h3>
                        <p className="remote-muted">
                            {t("settings.mobileSettings.authorizeOnlyTheProjectsNeededTheDevice")}</p>
                        {projects.map((project) => (
                            <label className="remote-project-choice" key={project.id}>
                                <input
                                    type="checkbox"
                                    checked={selected.includes(project.id)}
                                    onChange={(event) =>
                                        setSelected((old) =>
                                            event.target.checked
                                                ? [...old, project.id]
                                                : old.filter((value) => value !== project.id),
                                        )
                                    }
                                />
                                {project.name ?? project.root.split("/").at(-1)}
                            </label>
                        ))}
                        {!projects.length && <p>{t("settings.mobileSettings.addAProjectInTheDesktopApp")}</p>}
                    </div>
                    <fieldset className="remote-permissions" aria-label={t("settings.mobileSettings.permissionPreset")}>
                        <legend>{t("settings.mobileSettings.accessPermissions")}</legend>
                        <div className="remote-permission-options">
                            {[
                                {
                                    value: "Observer",
                                    title: t("settings.mobileSettings.viewOnly"),
                                    description: t("settings.mobileSettings.viewConversationsReviewResultsAndChanges"),
                                },
                                {
                                    value: "Operator",
                                    title: t("settings.mobileSettings.canOperate"),
                                    description: t("settings.mobileSettings.alsoSendStopAnswerAndPauseTasks"),
                                },
                            ].map((option) => (
                                <label key={option.value} data-selected={preset === option.value}>
                                    <input
                                        type="radio"
                                        name={`remote-preset-${id}`}
                                        value={option.value}
                                        checked={preset === option.value}
                                        aria-label={option.title}
                                        onChange={() => setPreset(option.value)}
                                    />
                                    <span>
                                        <strong>{option.title}</strong>
                                        <small>{option.description}</small>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <p className="remote-muted">{t("settings.mobileSettings.eachOperationStillRequiresPermissionAndSession")}</p>
                    <div className="remote-grant-actions">
                        <Button
                            disabled={busy || !selected.length}
                            onClick={() =>
                                void run({
                                    operation: pending ? "approve" : "updateGrant",
                                    id,
                                    projects: selected,
                                    preset,
                                })
                            }
                        >
                            {pending ? t("settings.mobileSettings.confirmPairing") : t("settings.mobileSettings.saveAccess")}
                        </Button>
                        <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                                void run({ operation: pending ? "reject" : "revoke", id })
                            }
                        >
                            {pending ? t("settings.mobileSettings.rejectPairing") : t("settings.mobileSettings.revokeAccess")}
                        </Button>
                    </div>
                </>
            )}
        </fieldset>
    );
}

export function MobileSettings({ action, projects }: { action: Action; projects: Data[] }) {
    const { t, intl } = useI18n();
    const [state, setState] = useState<Data>({ deviceGrants: [], pending: [] });
    const [error, setError] = useState<string | UiMessage>(""),
        [busy, setBusy] = useState(false);
    const [invite, setInvite] = useState<Data | null>(null);
    const [inviteExpired, setInviteExpired] = useState(false);
    const [proposal, setProposal] = useState<Data | null>(null);
    const [serveConfirmed, setServeConfirmed] = useState(false);
    const [scopeConfirmed, setScopeConfirmed] = useState(false);
    const [funnelConfirmed, setFunnelConfirmed] = useState(false);
    const [accessMethod, setAccessMethod] = useState<"private" | "public" | "organization">("private");
    const [httpsPort, setHttpsPort] = useState("443");
    const [organizationOrigin, setOrganizationOrigin] = useState("");
    const [visibility, setVisibility] = useState("private");
    const [organizationConfirmed, setOrganizationConfirmed] = useState(false);
    const [publicConfirmed, setPublicConfirmed] = useState(false);
    const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
    const [relayOrigin, setRelayOrigin] = useState("");
    const [enrollmentCode, setEnrollmentCode] = useState("");
    const [relayConfirmed, setRelayConfirmed] = useState(false);
    const [pairTransport, setPairTransport] = useState("direct");
    const networkDetails = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        setRelayOrigin(state.relay ?? "");
    }, [state.relay]);
    const run = async (request: Data) => {
        setBusy(true);
        setError("");
        if (["networkPropose", "networkProposeScope"].includes(request.operation)) {
            setProposal(null);
            setServeConfirmed(false);
            setScopeConfirmed(false);
            setFunnelConfirmed(false);
        }
        try {
            const result = await action("remoteControl", request);
            if (request.operation === "pair") {
                setInvite(result);
                setInviteExpired(false);
            } else if (["networkPropose", "networkProposeScope"].includes(request.operation))
                setProposal(result);
            else {
                setState(result);
                if (result.directUrl !== state.directUrl) setInvite(null);
                if (request.operation !== "networkInspect") {
                    setProposal(null);
                    setServeConfirmed(false);
                    setScopeConfirmed(false);
                    setFunnelConfirmed(false);
                    setOrganizationConfirmed(false);
                    setPublicConfirmed(false);
                    setRecoveryConfirmed(false);
                    setInvite(null);
                }
            }
        } catch (error) {
            const failure = error as Error & { code?: string };
            setError(
                request.operation.startsWith("network") && typeof failure.code === "string"
                    ? { id: networkDiagnostics[failure.code] ?? "settings.mobileSettings.networkStatusUnknown", values: { code: failure.code } }
                    : failure.message,
            );
        } finally {
            if (request.operation === "enable") {
                setEnrollmentCode("");
                setRelayConfirmed(false);
            }
            if (["networkApply", "networkChangeScope"].includes(request.operation)) {
                setProposal(null);
                setServeConfirmed(false);
                setScopeConfirmed(false);
                setFunnelConfirmed(false);
                setInvite(null);
            }
            setBusy(false);
        }
    };
    useEffect(() => {
        let live = true;
        const read = () =>
            action("remoteControl", { operation: "status" })
                .then((value) => {
                    if (live) setState(value);
                })
                .catch((error) => {
                    if (live) setError({ id: "settings.mobileSettings.theHostIsOfflineOrTheBackground", values: { value0: error.message } });
                });
        void read();
        const timer = setInterval(() => {
            void read();
            setInvite((old) => {
                if (old && old.expiresAt <= Date.now()) {
                    setInviteExpired(true);
                    return null;
                }
                return old;
            });
        }, 2000);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [action]);
    const reconnectUrl =
        pairTransport === "relay"
            ? state.relayUrl
            : state.directUrl && state.directHostId
              ? `${state.directUrl}/#host=${encodeURIComponent(state.directHostId)}`
              : "";
    const entryReady = pairTransport === "relay" ? state.connected : state.directEnabled;
    const httpsEntry = reconnectUrl?.startsWith("https://");
    const hasPending = !!state.pending?.length;
    const step = hasPending
        ? 2
        : invite
          ? 1
          : !entryReady
            ? 0
            : state.deviceGrants?.some((device: Data) => device.status === "active")
              ? 3
              : 1;
    return (
        <div className="settings-sections remote-settings" aria-label={t("settings.mobileSettings.phoneConnectionSettings")}>
            <p className="remote-intro">{t("settings.mobileSettings.continueYourWorkFromAPhoneOr")}</p>
            <ol className="remote-steps" aria-label={t("settings.mobileSettings.connectionSteps")}>
                {[{ key: "选择连接方式", title: t("settings.mobileSettings.chooseAConnectionMethod") }, { key: "打开配对链接", title: t("settings.mobileSettings.openThePairingLink") }, { key: "确认设备", title: t("settings.mobileSettings.confirmDevice") }].map(({ key, title }, index) => (
                    <li
                        key={key}
                        data-current={step === index}
                        data-complete={step > index}
                        aria-current={step === index ? "step" : undefined}
                    >
                        <span className="remote-step-number">
                            {step > index ? <Check size={16} /> : intl.formatNumber(index + 1)}
                        </span>
                        <strong>{title}</strong>
                        <small>
                            {[t("settings.mobileSettings.enableAConnectionEntryFirst"), t("settings.mobileSettings.theInvitationExpiresInTwoMinutes"), t("settings.mobileSettings.checkTheFingerprintAndAccessScope")][index]}
                        </small>
                    </li>
                ))}
            </ol>
            <div className="remote-reachability">
                <Monitor size={22} />
                <div>
                    <strong>
                        {!entryReady
                            ? t("settings.mobileSettings.remoteAccessIsOff")
                            : httpsEntry
                              ? t("settings.mobileSettings.httpsConnectionEntryConfigured")
                              : t("settings.mobileSettings.onlyABrowserOnThisComputerCan")}
                    </strong>
                    <p>
                        {httpsEntry
                            ? t("settings.mobileSettings.phoneAccessStillDependsOnTheNetwork")
                            : t("settings.mobileSettings.thisLocalLinkCannotBeOpenedOn")}
                    </p>
                </div>
                <Button
                    variant="ghost"
                    onClick={() => {
                        if (networkDetails.current) {
                            networkDetails.current.open = true;
                            networkDetails.current.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                            });
                        }
                    }}
                >
                    {t("settings.mobileSettings.setUpPhoneAccess")}</Button>
            </div>
            {(error || state.directError || state.migrationError) && (
                <p className="remote-error" role="alert">
                    {formatUiMessage(t, error) || state.directError || state.migrationError}
                </p>
            )}
            {hasPending ? (
                <section className="remote-pending" aria-label={t("settings.mobileSettings.confirmConnectionRequests")}>
                    {state.pending.map((device: Data) => (
                        <GrantReview
                            key={device.id}
                            device={device}
                            projects={projects}
                            pending
                            busy={busy}
                            run={run}
                        />
                    ))}
                </section>
            ) : (
                <section className="remote-pairing" aria-label={t("settings.mobileSettings.connectANewDevice")}>
                    <h2>{invite ? t("settings.mobileSettings.openTheLinkThenReturnHereTo") : t("settings.mobileSettings.connectANewDevice2")}</h2>
                    <p className="remote-muted">
                        {invite
                            ? invite.payload.startsWith("https://")
                                ? t("settings.mobileSettings.scanTheQRCodeWithYourPhone")
                                : t("settings.mobileSettings.copyTheLinkIntoABrowserOn")
                            : t("settings.mobileSettings.accessIsAllowedOnlyAfterYouConfirm")}
                    </p>
                    <div className="remote-entry-controls">
                        <div>
                            <div className="mb-1">{t("settings.mobileSettings.connectionMethod")}</div>
                            <SettingsSelect aria-label={t("settings.mobileSettings.pairingEntry")} value={pairTransport} onValueChange={selectedValue => {
                                    setPairTransport(selectedValue);
                                    setInvite(null);
                                }}>
                                <option value="direct">{t("settings.mobileSettings.directConnection")}</option>
                                <option value="relay">{t("settings.mobileSettings.relayService")}</option>
                            </SettingsSelect>
                        </div>
                        {pairTransport === "direct" && !state.directEnabled && (
                            <Button
                                disabled={busy}
                                onClick={() => void run({ operation: "enableDirect" })}
                            >
                                {t("settings.mobileSettings.enableLocalEntry")}</Button>
                        )}
                        {!invite && (
                            <Button
                                    disabled={busy || !entryReady}
                                onClick={() =>
                                    void run({ operation: "pair", transport: pairTransport })
                                }
                            >
                                {t("settings.mobileSettings.generatePairingLink")}</Button>
                        )}
                    </div>
                    {invite && (
                        <div className="remote-invitation">
                            {invite.payload.startsWith("https://") && (
                                <img
                                    width="180"
                                    height="180"
                                    src={invite.qr}
                                    alt={t("settings.mobileSettings.phonePairingQRCode")}
                                />
                            )}
                            <div>
                                <label>
                                    {t("settings.mobileSettings.pairingLink")}<textarea
                                        aria-label={t("settings.mobileSettings.pairingLink")}
                                        readOnly
                                        value={invite.payload}
                                        onFocus={(event) => event.target.select()}
                                    />
                                </label>
                                <p className="remote-muted">
                                    {t("settings.mobileSettings.validForTwoMinutesAndOneDevice")}</p>
                                <div className="remote-actions">
                                    <Button
                                        onClick={() => {
                                            void navigator.clipboard
                                                .writeText(invite.payload)
                                                .catch(() =>
                                                    setError({ id: "settings.mobileSettings.copyFailedSelectTheLinkAndCopy" }),
                                                );
                                        }}
                                    >
                                        {t("settings.mobileSettings.copyLink")}</Button>
                                    <Button
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void run({ operation: "cancelPair" })}
                                    >
                                        {t("settings.mobileSettings.cancelInvitation")}</Button>
                                </div>
                            </div>
                        </div>
                    )}
                    {inviteExpired && <p role="status">{t("settings.mobileSettings.thePairingInvitationHasExpiredGenerateA")}</p>}
                    {reconnectUrl && (
                        <SettingsDisclosure className="remote-reconnect" title={<> {t("settings.mobileSettings.howDoExistingDevicesReconnect")}</>}>
                            <p>{t("settings.mobileSettings.openThisLinkInAnAuthorizedBrowser")}</p>
                            <Input
                                aria-label={t("settings.mobileSettings.currentConnectionLink")}
                                readOnly
                                value={reconnectUrl}
                                onFocus={(event) => event.target.select()}
                            />
                        </SettingsDisclosure>
                    )}
                </section>
            )}
            <SettingsSection
                title={t("settings.mobileSettings.authorizedDevices")}
                description={t("settings.mobileSettings.savingAccessScopeOrRevokingAccessCloses")}
            >
                <SettingsGroupCard>
                    {(state.deviceGrants ?? []).map((device: Data) => (
                        <SettingsDisclosure
                            className="remote-device-management"
                            key={`${device.devicePeerId}:${device.revision}`}
                         title={<> <Monitor size={18} />
                                <span>
                                    {device.displayName ?? device.name ?? t("settings.mobileSettings.browserDevice")}
                                    <small>
                                        {device.status === "revoked"
                                            ? t("settings.mobileSettings.revoked")
                                            : device.status === "reviewRequired"
                                              ? t("settings.mobileSettings.needsReview")
                                              : device.capabilities?.includes("submit")
                                                ? t("settings.mobileSettings.canOperate")
                                                : t("settings.mobileSettings.viewOnly")}
                                    </small>
                                </span>
                                <span>{t("settings.mobileSettings.managePermissions")}</span> </>}>
                            <GrantReview
                                device={device}
                                projects={projects}
                                busy={busy}
                                run={run}
                            />
                        </SettingsDisclosure>
                    ))}
                    {!state.deviceGrants?.length && (
                        <p className="settings-card-empty">{t("settings.mobileSettings.noPairedDevicesYet")}</p>
                    )}
                </SettingsGroupCard>
            </SettingsSection>
            <SettingsDisclosure className="remote-network-settings" ref={networkDetails} title={<> <Smartphone size={20} />
                    <span>
                        {t("settings.mobileSettings.phoneAccessAndNetworkSettings")}<small>{t("settings.mobileSettings.configureHTTPSTailscaleOrARelayService")}</small>
                    </span>
                     </>}>
                <div className="remote-network-content">
                    <SettingsSection
                        title={t("settings.mobileSettings.configurePhoneAccess")}
                        description={t("settings.mobileSettings.chooseHowYourPhoneConnects")}
                    >
                        <SettingsGroupCard><SettingsRow label={t("settings.mobileSettings.accessMethod")} control={
                            <SettingsSelect aria-label={t("settings.mobileSettings.phoneAccessMethod")} value={accessMethod} disabled={busy} onValueChange={value => {
                                if (busy) return;
                                setAccessMethod(value as "private" | "public" | "organization");
                                setProposal(null);
                                setServeConfirmed(false);
                                setScopeConfirmed(false);
                                setFunnelConfirmed(false);
                                setOrganizationConfirmed(false);
                                setPublicConfirmed(false);
                                setRecoveryConfirmed(false);
                            }}><option value="private">{t("settings.mobileSettings.privateNetwork")}</option><option value="public">{t("settings.mobileSettings.publicInternet")}</option><option value="organization">{t("settings.mobileSettings.organizationNetwork")}</option></SettingsSelect>} /></SettingsGroupCard>
                        <SettingsGroupCard className="remote-access-panel">
                            <SettingsDisclosure className="remote-connection-details" title={<> {t("settings.mobileSettings.connectionDetailsAndDiagnostics")}</>}>
                            <p>
                                {t("settings.mobileSettings.phonesUsingServeMustJoinTheSame")}</p>
                            <p>{t("settings.mobileSettings.ifTheHostIsOfflineCheckThe")}</p>
                            <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => void run({ operation: "networkInspect" })}
                            >
                                {t("settings.mobileSettings.checkNetworkTools")}</Button>
                            {state.network?.inspection && (
                                <div role="status">
                                    <p>
                                        {t("settings.mobileSettings.tailscaleVersionValue", { version: state.network.inspection.version ?? t("settings.mobileSettings.unknown") })}
                                    </p>
                                    {state.network.inspection.diagnostic && (
                                        <p>
                                            {networkDiagnostic(t, state.network.inspection.diagnostic)}
                                        </p>
                                    )}
                                    {state.network.inspection.login && (
                                        <p>
                                            {t(networkLoginDiagnostics[
                                                state.network.inspection.login
                                            ] ?? networkLoginDiagnostics.unknown)}
                                        </p>
                                    )}
                                    {state.network.inspection.https && (
                                        <p>
                                            {state.network.inspection.https === "enabled"
                                                ? t("settings.mobileSettings.hostHTTPSSupportIsEnabledThePhone")
                                                : networkDiagnostic(
                                                      t,
                                                      state.network.inspection.https === "disabled"
                                                          ? "https-disabled"
                                                          : "https-unknown",
                                                  )}
                                        </p>
                                    )}
                                </div>
                            )}
                            </SettingsDisclosure>
                            {state.network?.diagnostic && <p className="remote-error" role="alert">{networkDiagnostic(t, state.network.diagnostic)}</p>}
                            <fieldset disabled={busy} hidden={accessMethod !== "private"} className="remote-access-fields">
                                <legend>{t("settings.mobileSettings.tailscaleServePrivateNetwork")}</legend>
                                <p className="remote-muted">{t("settings.mobileSettings.yourPhoneAndComputerMustJoinThe")}</p>
                                <label>
                                    {t("settings.mobileSettings.httpsPort")}<Input
                                        aria-label={t("settings.mobileSettings.serveHTTPSPort")}
                                        type="number"
                                        min={1}
                                        max={65535}
                                        value={httpsPort}
                                        onChange={(event) => {
                                            setHttpsPort(event.target.value);
                                            setProposal(null);
                                            setServeConfirmed(false);
                                        }}
                                    />
                                </label>
                                <Button
                                    disabled={busy || !state.directEnabled}
                                    onClick={() =>
                                        void run({
                                            operation: "networkPropose",
                                            httpsPort: Number(httpsPort),
                                        })
                                    }
                                >
                                    {t("settings.mobileSettings.generateServePlan")}</Button>
                                {proposal && !proposal.scope && (
                                    <div>
                                        <p>{proposal.confirmation}</p>
                                        <p>{t("settings.mobileSettings.entryAddress", { origin: proposal.publicOrigin })}</p>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={serveConfirmed}
                                                onChange={(event) =>
                                                    setServeConfirmed(event.target.checked)
                                                }
                                            />
                                            {t("settings.mobileSettings.iConfirmThisPlanMayChangeThe")}</label>
                                        <Button
                                            disabled={busy || !serveConfirmed}
                                            onClick={() =>
                                                void run({
                                                    operation: "networkApply",
                                                    proposalId: proposal.proposalId,
                                                    confirmed: true,
                                                })
                                            }
                                        >
                                            {t("settings.mobileSettings.confirmAndApplyServe")}</Button>
                                    </div>
                                )}
                                {!proposal && (
                                    <p>{t("settings.mobileSettings.generateAPlanThenConfirmItBefore")}</p>
                                )}
                            </fieldset>
                            <fieldset disabled={busy} hidden={accessMethod !== "public"} className="remote-access-fields">
                                <legend>{t("settings.mobileSettings.tailscaleFunnelPublicInternet")}</legend>
                                <p className="remote-muted">{t("settings.mobileSettings.publishTheRemoteEntryPairingAndOperations")}</p>
                                {state.network?.scope !== "private" && state.network?.scope !== "public" && <p className="remote-muted">{t("settings.mobileSettings.configureServeOnThePrivateNetworkBefore")}</p>}
                                <SettingsDisclosure title={<> {t("settings.mobileSettings.aboutPublicAccess")}</>}>
                                <p>
                                    {t("settings.mobileSettings.theEntryStaysPrivateByDefaultFunnel")}</p>
                                <p>
                                    {t("settings.mobileSettings.savedScopeValue", { scope: state.network?.scope === "public"
                                        ? t("settings.mobileSettings.publicInternet")
                                        : state.network?.scope === "private"
                                          ? t("settings.mobileSettings.private")
                                          : t("settings.mobileSettings.needsVerification") })}
                                </p>
                                {state.network?.inspection && (
                                    <p>
                                        {t("settings.mobileSettings.funnelPorts", { ports: state.network.inspection.funnelPorts == null
                                            ? t("settings.mobileSettings.unknown")
                                            : state.network.inspection.funnelPorts.length
                                              ? intl.formatList(state.network.inspection.funnelPorts.map(String), { type: "conjunction" })
                                              : t("settings.mobileSettings.none") })}</p>
                                )}
                                {state.network?.reconciliation && (
                                    <p>
                                        {t("settings.mobileSettings.reconciliationReview", { status: {
                                            destination: t("settings.mobileSettings.theTargetScopeIsStillPresent"),
                                            source: t("settings.mobileSettings.theOriginalScopeIsStillPresent"),
                                            absent: t("settings.mobileSettings.theMappingNoLongerExists"),
                                            changed: t("settings.mobileSettings.theMappingWasChangedExternally"),
                                        }[state.network.reconciliation as string] ?? t("settings.mobileSettings.unknown") })}</p>
                                )}
                                </SettingsDisclosure>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        disabled={
                                            busy ||
                                            !state.directEnabled ||
                                            state.network?.kind !== "tailscale" ||
                                            state.network?.scope !== "private"
                                        }
                                        onClick={() =>
                                            void run({
                                                operation: "networkProposeScope",
                                                scope: "public",
                                            })
                                        }
                                    >
                                        {t("settings.mobileSettings.generatePublicFunnelPlan")}</Button>
                                    <Button
                                        variant="outline"
                                        disabled={
                                            busy ||
                                            !state.directEnabled ||
                                            state.network?.kind !== "tailscale" ||
                                            state.network?.scope !== "public"
                                        }
                                        onClick={() =>
                                            void run({
                                                operation: "networkProposeScope",
                                                scope: "private",
                                            })
                                        }
                                    >
                                        {t("settings.mobileSettings.generatePlanToRestorePrivateEntry")}</Button>
                                </div>
                                {proposal?.scope && (
                                    <div>
                                        <p>{proposal.confirmation}</p>
                                        <p>{t("settings.mobileSettings.changingScopeInvalidatesCurrentInvitationsAndConnections")}</p>
                                        <p>
                                            {t("settings.mobileSettings.scopeEntryPlan", { origin: proposal.publicOrigin, source: proposal.sourceScope === "private" ? t("settings.mobileSettings.private") : t("settings.mobileSettings.publicInternet"), destination: proposal.scope === "public" ? t("settings.mobileSettings.publicInternet") : t("settings.mobileSettings.private") })}
                                        </p>
                                        <label className="block">
                                            <input
                                                type="checkbox"
                                                checked={scopeConfirmed}
                                                onChange={(event) =>
                                                    setScopeConfirmed(event.target.checked)
                                                }
                                            />
                                            {t("settings.mobileSettings.iConfirmThisPlanMayChangeThe2")}</label>
                                        {proposal.scope === "public" && (
                                            <label className="block">
                                                <input
                                                    type="checkbox"
                                                    checked={funnelConfirmed}
                                                    onChange={(event) =>
                                                        setFunnelConfirmed(event.target.checked)
                                                    }
                                                />
                                                {t("settings.mobileSettings.iConfirmAgainThatThisRemoteEntry")}</label>
                                        )}
                                        <Button
                                            disabled={
                                                busy ||
                                                !scopeConfirmed ||
                                                (proposal.scope === "public" && !funnelConfirmed)
                                            }
                                            onClick={() =>
                                                void run({
                                                    operation: "networkChangeScope",
                                                    proposalId: proposal.proposalId,
                                                    confirmed: scopeConfirmed,
                                                    publicConfirmed: funnelConfirmed,
                                                })
                                            }
                                        >
                                            {t("settings.mobileSettings.confirmAccessScopeChange")}</Button>
                                    </div>
                                )}
                            </fieldset>
                            <fieldset disabled={busy} hidden={accessMethod !== "organization"} className="remote-access-fields">
                                <legend>{t("settings.mobileSettings.organizationHTTPS")}</legend>
                                <p className="remote-muted">{t("settings.mobileSettings.useAnHTTPSEntryConfiguredByYour")}</p>
                                <label>
                                    {t("settings.mobileSettings.httpsOrigin")}
                                    <Input
                                        aria-label={t("settings.mobileSettings.organizationHTTPSOrigin")}
                                        placeholder="https://remote.example.com"
                                        value={organizationOrigin}
                                        onChange={(event) => {
                                            setOrganizationOrigin(event.target.value);
                                            setOrganizationConfirmed(false);
                                            setPublicConfirmed(false);
                                        }}
                                    />
                                </label>
                                <div className="settings-choice-field">
                                    {t("settings.mobileSettings.accessScope")}<SettingsSelect aria-label={t("settings.mobileSettings.organizationEntryAccessScope")} value={visibility} onValueChange={selectedValue => {
                                            setVisibility(selectedValue);
                                            setOrganizationConfirmed(false);
                                            setPublicConfirmed(false);
                                        }}>
                                        <option value="private">{t("settings.mobileSettings.privateOrganizationNetwork")}</option>
                                        <option value="public">{t("settings.mobileSettings.mayBePubliclyAccessible")}</option>
                                    </SettingsSelect>
                                </div>
                                <SettingsDisclosure title={<> {t("settings.mobileSettings.organizationEntryRequirements")}</>}><p>
                                    {t("settings.mobileSettings.thisSavesOnlyTheExactHTTPSOrigin")}</p></SettingsDisclosure>
                                <label className="block">
                                    <input
                                        type="checkbox"
                                        checked={organizationConfirmed}
                                        onChange={(event) =>
                                            setOrganizationConfirmed(event.target.checked)
                                        }
                                    />
                                    {t("settings.mobileSettings.iConfirmTheOrganizationEntryIsReady")}</label>
                                {visibility === "public" && (
                                    <label className="block">
                                        <input
                                            type="checkbox"
                                            checked={publicConfirmed}
                                            onChange={(event) =>
                                                setPublicConfirmed(event.target.checked)
                                            }
                                        />
                                        {t("settings.mobileSettings.iConfirmAgainThatThisHTTPSEntry")}</label>
                                )}
                                <Button
                                    disabled={
                                        busy ||
                                        !state.directEnabled ||
                                        !organizationConfirmed ||
                                        (visibility === "public" && !publicConfirmed)
                                    }
                                    onClick={() =>
                                        void run({
                                            operation: "networkConfigureOrganization",
                                            publicOrigin: organizationOrigin,
                                            visibility,
                                            confirmed: true,
                                            publicConfirmed,
                                        })
                                    }
                                >
                                    {t("settings.mobileSettings.saveOrganizationHTTPSOrigin")}</Button>
                            </fieldset>
                            <div className="remote-network-status" role="status" aria-label={t("settings.mobileSettings.networkConfigurationStatus")}>
                                <span>{t("settings.mobileSettings.configurationStatus")}</span><strong>{state.network?.kind ? !state.network.scope ? t("settings.mobileSettings.needsVerification") : state.network.kind === "organization" ? t("settings.mobileSettings.organizationEntry") : state.network.scope === "public" ? t("settings.mobileSettings.publicEntry") : t("settings.mobileSettings.privateEntry") : t("settings.mobileSettings.notConfigured")}</strong><span>{t("settings.mobileSettings.phoneConnectionNeedsVerification")}</span>
                            </div>
                            {state.network?.kind && (
                                <SettingsDisclosure className="remote-network-recovery" title={<> {t("settings.mobileSettings.restoreOrRemoveThisAppSNetwork")}</>}><fieldset disabled={busy} className="p-4">
                                    <p>
                                        {t("settings.mobileSettings.restoreChecksTheActualScopeOfThe")}</p>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={recoveryConfirmed}
                                            onChange={(event) =>
                                                setRecoveryConfirmed(event.target.checked)
                                            }
                                        />
                                        {t("settings.mobileSettings.iConfirmOnlyThisAppSRecords")}</label>
                                    <div className="flex gap-2">
                                        <Button
                                            disabled={busy || !recoveryConfirmed}
                                            onClick={() =>
                                                void run({
                                                    operation: "networkRecover",
                                                    confirmed: true,
                                                })
                                            }
                                        >
                                            {t("settings.mobileSettings.verifyAndRestore")}</Button>
                                        <Button
                                            variant="outline"
                                            disabled={busy || !recoveryConfirmed}
                                            onClick={() =>
                                                void run({
                                                    operation: "networkRemove",
                                                    confirmed: true,
                                                })
                                            }
                                        >
                                            {t("settings.mobileSettings.removeNetworkConfiguration")}</Button>
                                    </div>
                                </fieldset></SettingsDisclosure>
                            )}
                        </SettingsGroupCard>
                    </SettingsSection>
                    <SettingsDisclosure className="remote-relay-settings" title={<> {t("settings.mobileSettings.connectThroughARelayService")}</>}>
                    <SettingsSection
                        title={t("settings.mobileSettings.connectThroughARelayService")}
                        description={t("settings.mobileSettings.yourOrganizationProvidesASameOriginHTTPS")}
                    >
                        <SettingsGroupCard>
                            <fieldset disabled={busy} className="p-4">
                                <legend>{t("settings.mobileSettings.enrollOrReconnectRelay")}</legend>
                                <label>
                                    {t("settings.mobileSettings.relayHTTPSOrigin")}<Input
                                        aria-label={t("settings.mobileSettings.relayHTTPSOrigin")}
                                        value={relayOrigin}
                                        placeholder="https://relay.example.org"
                                        onChange={(event) => {
                                            setRelayOrigin(event.target.value);
                                            setRelayConfirmed(false);
                                        }}
                                    />
                                </label>
                                <label>
                                    {t("settings.mobileSettings.administratorOneTimeEnrollmentCode")}<Input
                                        aria-label={t("settings.mobileSettings.administratorOneTimeEnrollmentCode")}
                                        type="password"
                                        autoComplete="off"
                                        value={enrollmentCode}
                                        onChange={(event) => {
                                            setEnrollmentCode(event.target.value);
                                            setRelayConfirmed(false);
                                        }}
                                    />
                                </label>
                                <p>
                                    {t("settings.mobileSettings.initialEnrollmentChangingTheOriginOrRe")}</p>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={relayConfirmed}
                                        onChange={(event) =>
                                            setRelayConfirmed(event.target.checked)
                                        }
                                    />{" "}
                                    {t("settings.mobileSettings.iTrustTheRemotePageProvidedBy")}</label>
                                <div className="flex gap-2">
                                    <Button
                                        disabled={busy || !relayConfirmed || !relayOrigin}
                                        onClick={() =>
                                            void run({
                                                operation: "enable",
                                                relay: relayOrigin,
                                                confirmed: true,
                                                ...(enrollmentCode ? { code: enrollmentCode } : {}),
                                            })
                                        }
                                    >
                                        {t("settings.mobileSettings.enrollOrEnableRelay")}</Button>
                                    <Button
                                        variant="outline"
                                        disabled={busy || !state.enabled}
                                        onClick={() => void run({ operation: "disable" })}
                                    >
                                        {t("settings.mobileSettings.disconnectRelay")}</Button>
                                </div>
                                <p role="status">
                                    {state.connected
                                        ? t("settings.mobileSettings.relayIsConnectedActualPhoneReachabilityHas")
                                        : state.enabled
                                          ? t("settings.mobileSettings.relayIsDisconnectedCheckTheServiceAnd")
                                          : t("settings.mobileSettings.relayIsOff")}
                                </p>
                                {state.relayError && <p role="alert">{state.relayError}</p>}
                            </fieldset>
                        </SettingsGroupCard>
                    </SettingsSection>
                    </SettingsDisclosure>
                    <SettingsSection
                        title={t("settings.mobileSettings.closeConnectionEntry")}
                        description={t("settings.mobileSettings.stopTheEntryFirstThenRemoveThis")}
                    >
                        <Button
                            variant="outline"
                            disabled={busy || !state.directEnabled}
                            onClick={() => void run({ operation: "disableDirect" })}
                        >
                            {t("settings.mobileSettings.turnOffRemoteAndRemoveMapping")}</Button>
                    </SettingsSection>
                </div>
            </SettingsDisclosure>
        </div>
    );
}
