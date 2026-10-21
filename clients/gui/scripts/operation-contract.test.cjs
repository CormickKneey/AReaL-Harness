"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    validateCommand,
    validateCommandResponse,
} = require("../packages/workbench/client/desktop-contract.cjs");
test("Side model modes reject malformed references and ambiguous default selection", () => {
    const start = {
        projectId: "p",
        operation: "start",
        sourceThreadId: "s",
        requestId: "r",
        text: "question",
        workspaceAccess: "none",
    };
    for (const extra of [{}, { resetModel: true }, { model: { providerId: "p", modelId: "C" } }])
        assert.doesNotThrow(() => validateCommand("side", { ...start, ...extra }));
    for (const extra of [
        { resetModel: true, model: { providerId: "p", modelId: "C" } },
        { model: {} },
        { workspaceAccess: "write" },
    ])
        assert.throws(() => validateCommand("side", { ...start, ...extra }));
});
test("critical operation responses fail malformed identity, pages and recovery outcomes", () => {
    for (const [name, params, bad] of [
        ["fork", {}, {}],
        ["configure", {}, {}],
        ["side", { operation: "recover" }, { confirmed: true }],
        ["side", { operation: "list" }, { data: null }],
        ["side", { operation: "context" }, { snapshotId: "s", evidence: null }],
    ])
        assert.throws(() => validateCommandResponse(name, params, bad));
    assert.doesNotThrow(() =>
        validateCommandResponse("side", { operation: "recover" }, { confirmed: false }),
    );
    assert.doesNotThrow(() =>
        validateCommandResponse(
            "side",
            { operation: "recover" },
            { confirmed: true, threadId: "s" },
        ),
    );
});

test("saved-key reveal accepts only a bounded provider/revision request and key response", () => {
    const request = { operation: "revealKey", id: "provider", expectedRevision: "revision" };
    assert.doesNotThrow(() => validateCommand("providers", request));
    for (const bad of [{ ...request, id: "" }, { ...request, expectedRevision: null }, { ...request, reference: "OTHER_SECRET" }])
        assert.throws(() => validateCommand("providers", bad));
    assert.doesNotThrow(() => validateCommandResponse("providers", request, { apiKey: "synthetic-key" }));
    for (const bad of [{}, { apiKey: "" }, { apiKey: 1 }, { apiKey: "key", snapshot: {} }])
        assert.throws(() => validateCommandResponse("providers", request, bad));
});

test("remote control cannot reveal local provider credentials", async () => {
    const { DesktopService } = require("../app/src/core/service-protocol.cjs");
    const service = { backend: { command: () => assert.fail("Remote reveal must not reach credentials") } };
    await assert.rejects(DesktopService.prototype.executeRemote.call(service, "providers", { operation: "revealKey", id: "p", expectedRevision: "r" }), /本机/);
});
