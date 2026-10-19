"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater } = require("../app/src/update/controller.cjs");
const { prepareNativeInstall } = require("../app/src/update/native-ready.cjs");
const { githubFeedUrl, validateUpdate } = require("../app/src/update/config.cjs");

const offer = (version) => ({
    version,
    files: [
        {
            url: `https://github.com/areal-project/AReaL-Harness/releases/download/gui-v${version}/AReaLHarness-${version}-macos-arm64.zip`,
            sha512: Buffer.alloc(64).toString("base64"),
            size: 123,
        },
    ],
});
function fixture(options = {}) {
    const calls = [],
        states = [];
    const updater = new EventEmitter();
    updater.setFeedURL = (config) => calls.push(["feed", config]);
    updater.checkForUpdates = async () => ({ updateInfo: offer("0.1.12") });
    updater.downloadUpdate = async () => {
        calls.push("download");
        updater.emit("download-progress", { percent: 42 });
    };
    updater.quitAndInstall = () => calls.push("install");
    const controller = createUpdater({
        updater,
        config: { feedUrl: githubFeedUrl },
        version: "0.1.11",
        platform: "darwin",
        arch: "arm64",
        onState: (state) => states.push(state),
        hasWork: async () => false,
        prepareNativeInstall: async () => calls.push("native-ready"),
        prepareInstall: async () => calls.push("stop-core"),
        log: { warn() {} },
        ...options,
    });
    return { updater, controller, calls, states };
}

test("adjacent formal version stages before stopping Core, then hands off once", async () => {
    const { controller, calls, states } = fixture();
    assert.equal((await controller.check()).status, "available");
    assert.equal((await controller.download()).status, "installing");
    assert.deepEqual(calls.slice(1), ["download", "native-ready", "stop-core", "install"]);
    assert.equal(states.find((state) => state.percent === 42).status, "downloading");
    await controller.install();
    await controller.download();
    assert.deepEqual(calls.slice(1), ["download", "native-ready", "stop-core", "install"]);
});

test("busy work defers install and idle retry uses the same verified download", async () => {
    let busy = true;
    const { controller, calls } = fixture({ hasWork: async () => busy });
    await controller.check();
    assert.equal((await controller.download()).status, "deferred");
    assert.deepEqual(calls.slice(1), ["download", "native-ready"]);
    busy = false;
    assert.equal((await controller.install()).status, "installing");
    assert.deepEqual(calls.slice(1), ["download", "native-ready", "stop-core", "install"]);
});

test("activity appearing at admission is deferred without native replacement", async () => {
    let busy = true;
    const { controller, calls } = fixture({
        prepareInstall: async () => {
            if (busy)
                throw Object.assign(new Error("busy at atomic admission"), { code: "CORE_BUSY" });
            calls.push("stop-core");
        },
    });
    await controller.check();
    assert.equal((await controller.download()).status, "deferred");
    assert.deepEqual(calls.slice(1), ["download", "native-ready"]);
    busy = false;
    await controller.install();
    assert.deepEqual(calls.slice(1), ["download", "native-ready", "stop-core", "install"]);
});

test("download interruption or checksum error preserves Core and supports retry", async () => {
    for (const message of ["connection interrupted", "SHA-512 mismatch"]) {
        const { updater, controller, calls } = fixture();
        updater.downloadUpdate = async () => {
            throw new Error(message);
        };
        await controller.check();
        assert.equal((await controller.download()).detail, message);
        assert.deepEqual(calls.slice(1), []);
        updater.downloadUpdate = async () => calls.push("download");
        await controller.download();
        assert.deepEqual(calls.slice(1), ["download", "native-ready", "stop-core", "install"]);
    }
});

test("failed native validation keeps Core running and permits a fresh staging attempt", async () => {
    let valid = false;
    const { controller, calls } = fixture({
        prepareNativeInstall: async () => {
            if (!valid) throw new Error("native signature rejected");
            calls.push("native-ready");
        },
    });
    await controller.check();
    assert.equal((await controller.download()).detail, "native signature rejected");
    assert.deepEqual(calls.slice(1), ["download"]);
    valid = true;
    await controller.download();
    assert.deepEqual(calls.slice(1), [
        "download",
        "download",
        "native-ready",
        "stop-core",
        "install",
    ]);
});

test("unknown stop result cannot be replayed by idle, check, or download actions", async () => {
    let requests = 0;
    const { controller, calls } = fixture({
        prepareInstall: async () => {
            requests++;
            throw Object.assign(new Error("receipt unknown"), { submissionUnknown: true });
        },
    });
    await controller.check();
    assert.equal((await controller.download()).status, "error");
    await controller.install();
    await controller.check(true);
    await controller.download();
    assert.equal(requests, 1);
    assert.equal(controller.state().status, "error");
    assert.deepEqual(calls.slice(1), ["download", "native-ready"]);
});

test("check errors are visible and a successful retry clears them", async () => {
    const { updater, controller } = fixture();
    updater.checkForUpdates = async () => {
        throw new Error("feed unavailable");
    };
    assert.equal((await controller.check()).status, "error");
    assert.equal(controller.state().detail, "feed unavailable");
    updater.checkForUpdates = async () => ({ updateInfo: offer("0.1.12") });
    assert.equal((await controller.check()).status, "available");
    assert.equal(controller.state().detail, "");
});

test("preview has no automatic channel and invalid offers never become installable", async () => {
    const preview = fixture({ config: null, version: "0.1.12-test.1" });
    assert.equal((await preview.controller.check()).enabled, false);
    assert.deepEqual(preview.calls, []);
    const { updater, controller, calls } = fixture();
    updater.checkForUpdates = async () => ({ updateInfo: { ...offer("0.1.12"), files: [] } });
    assert.equal((await controller.check()).status, "error");
    await controller.download();
    assert.deepEqual(calls.slice(1), []);
    for (const version of ["0.1.10", "0.1.11", "0.1.12-test.1"]) {
        updater.checkForUpdates = async () => ({ updateInfo: offer(version) });
        assert.equal((await controller.check()).downloaded, undefined);
        await controller.download();
        assert.deepEqual(calls.slice(1), []);
    }
    assert.equal(validateUpdate(offer("0.1.12"), githubFeedUrl).version, "0.1.12");
});

test("native staging readiness, rejection, and timeout release every owned listener", async () => {
    for (const event of [
        "update-downloaded",
        "update-not-available",
        "error",
        "timeout",
        "throw",
    ]) {
        const native = new EventEmitter();
        native.checkForUpdates = () => {
            if (event === "throw") throw new Error("native throw");
            if (event !== "timeout")
                queueMicrotask(() => native.emit(event, new Error("native rejection")));
        };
        const pending = prepareNativeInstall(native, 10);
        if (event === "update-downloaded") await pending;
        else await assert.rejects(pending, /原生更新|native/);
        assert.deepEqual(native.eventNames(), []);
        native.checkForUpdates = () => queueMicrotask(() => native.emit("update-downloaded"));
        await prepareNativeInstall(native, 1000);
        assert.deepEqual(native.eventNames(), []);
    }
});
