"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { test } = require("node:test");
const { taskCatalog } = require("../app/src/core/task-catalog.cjs");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
const scheduled = (id) => ({ id, mode: "scheduled" });
const page = (data = [], nextCursor = null) => ({ data, nextCursor });

function fixture(ids = ["owner"]) {
    const owners = Object.fromEntries(
        ids.map((id) => [
            id,
            {
                calls: [],
                tasks: [],
                read: async () => page([scheduled(id)]),
            },
        ]),
    );
    const backend = {
        saved: ids.map((id) => ({ id, root: `/work/${id}` })),
        library: { value: { projects: {} } },
        providers: { redact: (text) => text.replaceAll("secret", "[redacted]") },
        starts: [],
        async start(id) {
            this.starts.push(id);
            return owners[id].project;
        },
        requireConnection(project, client) {
            if (this.closing || project.client !== client || client.closed)
                throw new Error("STALE_CONNECTION secret");
        },
    };
    for (const [id, owner] of Object.entries(owners)) {
        owner.project = { id, model: { setTask: (task) => owner.tasks.push(task) } };
        owner.project.client = {
            request: async (method, params) => {
                owner.calls.push({ method, params });
                return owner.read(method, params);
            },
        };
    }
    return { backend, owners };
}

function observe(promise) {
    const state = { settled: false };
    promise.then(
        (value) => Object.assign(state, { settled: true, value }),
        (error) => Object.assign(state, { settled: true, error }),
    );
    return state;
}

async function deadline(advance, state, milliseconds = 5000) {
    await flush();
    advance(milliseconds);
    await flush();
    assert.equal(state.settled, true, "catalog must settle within the owner deadline");
    assert.equal(state.error, undefined);
    return state.value;
}

function clock(t) {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    return (milliseconds) => {
        now += milliseconds;
        t.mock.timers.tick(milliseconds);
    };
}

for (const phase of ["startup", "RPC"]) {
    test(`never-settled ${phase} reports timeout while retaining healthy owner data`, async (t) => {
        const advance = clock(t);
        const { backend, owners } = fixture(["blocked", "healthy"]);
        const gate = deferred();
        if (phase === "startup") {
            const start = backend.start.bind(backend);
            backend.start = (id) =>
                id === "blocked" ? (backend.starts.push(id), gate.promise) : start(id);
        } else owners.blocked.read = () => gate.promise;
        const state = observe(taskCatalog(backend, { operation: "list" }));
        await flush();
        advance(4999);
        await flush();
        assert.equal(state.settled, false);
        const result = await deadline(advance, state, 1);
        assert.deepEqual(
            result.data.map((task) => task.id),
            ["healthy"],
        );
        assert.equal(result.hasMore, false);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].projectId, "blocked");
        assert.equal(result.errors[0].code, "TASK_CATALOG_TIMEOUT");
        assert.equal(result.errors[0].stage, phase === "startup" ? "start" : "list");
        assert.match(result.errors[0].message, /超时|timed?\s*out|deadline/i);
        assert.deepEqual(result.owners, [
            { projectId: "blocked", status: "error" },
            { projectId: "healthy", status: "ready", connectionGeneration: 0 },
        ]);
        const again = await deadline(advance, observe(taskCatalog(backend, { operation: "list" })));
        assert.equal(again.errors.length, 1);
        assert.equal(again.errors[0].code, "TASK_CATALOG_TIMEOUT");
        assert.equal(
            backend.starts.filter((id) => id === "blocked").length,
            1,
            "polling must not duplicate abandoned startup",
        );
        assert.equal(
            owners.blocked.calls.length,
            phase === "RPC" ? 1 : 0,
            "polling must not duplicate abandoned RPC",
        );
    });
}

test("same owner reads are singleflight only while pending and scoped to the backend", async () => {
    const { backend, owners } = fixture();
    const gate = deferred();
    owners.owner.read = () => gate.promise;
    const request = { operation: "list", projectId: "owner", requestId: "catalog-request", viewEpoch: 7 };
    const first = taskCatalog(backend, request);
    const second = taskCatalog(backend, request);
    await flush();
    assert.equal(owners.owner.calls.length, 1);
    const other = fixture();
    assert.equal((await taskCatalog(other.backend, { operation: "list" })).data[0].id, "owner");
    gate.resolve(page([scheduled("shared")]));
    const result = await first;
    assert.deepEqual(result.data.map((task) => task.id), ["shared"]);
    assert.equal(result.projectId, "owner");
    assert.equal(result.requestId, "catalog-request");
    assert.equal(result.viewEpoch, 7);
    assert.deepEqual(result.owners, [{ projectId: "owner", status: "ready", connectionGeneration: 0 }]);
    assert.deepEqual(await second, result);
    owners.owner.read = async () => page([scheduled("fresh")]);
    assert.equal((await taskCatalog(backend, { operation: "list" })).data[0].id, "fresh");
});

for (const outcome of ["resolve", "reject"]) {
    test(`timeout releases the pending scan only after actual RPC ${outcome}`, async (t) => {
        const advance = clock(t);
        const { backend, owners } = fixture();
        const gate = deferred();
        owners.owner.read = () => gate.promise;
        const timedOut = await deadline(advance, observe(taskCatalog(backend, { operation: "list" })));
        assert.equal(timedOut.errors.length, 1);
        const polling = observe(taskCatalog(backend, { operation: "list" }));
        await flush();
        assert.equal(polling.settled, false, "polling waits for pending work within its own deadline");
        assert.equal(owners.owner.calls.length, 1);
        const polled = await deadline(advance, polling);
        assert.deepEqual(polled.data, []);
        assert.equal(polled.errors[0].code, "TASK_CATALOG_TIMEOUT");
        assert.equal(polled.errors[0].stage, "list");
        if (outcome === "resolve") gate.resolve(page([scheduled("late")], "next"));
        else gate.reject(new Error("late failure secret"));
        await flush();
        assert.equal(owners.owner.calls.length, 1, "late completion must not start another page");
        assert.deepEqual(owners.owner.tasks, [], "late data must not update the model");
        owners.owner.read = async () => page([scheduled("recovered")]);
        const recovered = await taskCatalog(backend, { operation: "list" });
        assert.deepEqual(
            recovered.data.map((task) => task.id),
            ["recovered"],
        );
        assert.deepEqual(recovered.errors, []);
        assert.deepEqual(owners.owner.tasks, [scheduled("recovered")]);
    });
}

test("one deadline spans startup and every page; late startup does not launch an RPC", async (t) => {
    const advance = clock(t);
    const { backend, owners } = fixture();
    const startup = deferred(),
        nextPage = deferred();
    backend.start = () => startup.promise;
    owners.owner.read = async (_method, params) =>
        params.after ? nextPage.promise : page([{ id: "ordinary", mode: "interactive" }], "next");
    const state = observe(taskCatalog(backend, { operation: "list" }));
    advance(3000);
    startup.resolve(owners.owner.project);
    await flush();
    assert.deepEqual(owners.owner.calls.at(-1).params, { limit: 30, after: "next" });
    advance(1999);
    await flush();
    assert.equal(state.settled, false);
    assert.equal((await deadline(advance, state, 1)).errors[0].code, "TASK_CATALOG_TIMEOUT");
    nextPage.resolve(page());
    await flush();

    const late = fixture();
    const gate = deferred();
    late.backend.start = () => gate.promise;
    await deadline(advance, observe(taskCatalog(late.backend, { operation: "list" })));
    gate.resolve(late.owners.owner.project);
    await flush();
    assert.equal(late.owners.owner.calls.length, 0);
});

test("concurrent differing limits serialize owner reads with exact filtered results and hasMore", async () => {
    const { backend, owners } = fixture(["one", "two"]);
    const gate = deferred();
    for (const [id, owner] of Object.entries(owners)) {
        owner.read = async (_method, params) =>
            params.after
                ? page([scheduled(`${id}-c`)])
                : gate.promise.then(() =>
                      page(
                          [
                              { id: "ordinary", mode: "interactive" },
                              scheduled(`${id}-a`),
                              scheduled(`${id}-b`),
                          ],
                          "next",
                      ),
                  );
    }
    const small = taskCatalog(backend, { operation: "list", limit: 1 });
    const large = taskCatalog(backend, { operation: "list", limit: 3 });
    const medium = taskCatalog(backend, { operation: "list", limit: 2 });
    await flush();
    assert.deepEqual(
        Object.values(owners).map((owner) => owner.calls.length),
        [1, 1],
    );
    gate.resolve();
    const [a, b, c] = await Promise.all([small, large, medium]);
    assert.deepEqual(
        a.data.map((task) => task.id),
        ["one-a", "two-a"],
    );
    assert.equal(a.hasMore, true);
    assert.deepEqual(
        b.data.map((task) => task.id),
        ["one-a", "one-b", "one-c", "two-a", "two-b", "two-c"],
    );
    assert.equal(b.hasMore, false);
    assert.deepEqual(c.data.map((task) => task.id), ["one-a", "one-b", "two-a", "two-b"]);
    assert.equal(c.hasMore, true);
});

test("pagination filters ordinary tasks, deduplicates tasks, projects metadata and redacts errors", async () => {
    const { backend, owners } = fixture(["named", "independent", "broken"]);
    backend.library.value.projects.named = { title: "Project title" };
    backend.saved[1].projectless = true;
    owners.named.read = async (_method, params) =>
        params.after
            ? page([{ ...scheduled("a"), version: 2 }, scheduled("b")])
            : page([{ id: "ordinary", mode: "interactive" }, scheduled("a")], "next");
    owners.broken.read = async () => {
        throw new Error("cannot list secret");
    };
    const result = await taskCatalog(backend, { operation: "list", limit: 2 });
    assert.deepEqual(result, {
        data: [
            {
                ...scheduled("a"),
                version: 2,
                projectId: "named",
                projectName: "Project title",
                scope: "project",
            },
            {
                ...scheduled("b"),
                projectId: "named",
                projectName: "Project title",
                scope: "project",
            },
            {
                ...scheduled("independent"),
                projectId: "independent",
                projectName: "独立任务",
                scope: "independent",
            },
        ],
        errors: [{
            projectId: "broken",
            projectName: "broken",
            code: "TASK_CATALOG_READ_FAILED",
            stage: "list",
            message: "cannot list [redacted]",
        }],
        hasMore: false,
        owners: [
            { projectId: "named", status: "ready", connectionGeneration: 0 },
            { projectId: "independent", status: "ready", connectionGeneration: 0 },
            { projectId: "broken", status: "error" },
        ],
    });
    assert.deepEqual(owners.named.tasks, [{ ...scheduled("a"), version: 2 }, scheduled("b")]);
    assert.deepEqual(
        owners.named.calls.map((call) => call.params),
        [{ limit: 2 }, { limit: 2, after: "next" }],
    );
    const scoped = await taskCatalog(backend, {
        operation: "list",
        projectId: "independent",
        requestId: "scope-request",
        viewEpoch: 9,
    });
    assert.deepEqual(scoped, {
        data: [{ ...scheduled("independent"), projectId: "independent", projectName: "独立任务", scope: "independent" }],
        errors: [],
        hasMore: false,
        owners: [{ projectId: "independent", status: "ready", connectionGeneration: 0 }],
        projectId: "independent",
        requestId: "scope-request",
        viewEpoch: 9,
    });
});

test("inbox has independent singleflight, deduplicates run/message identities and never sets tasks", async (t) => {
    const advance = clock(t);
    const { backend, owners } = fixture();
    const listGate = deferred(),
        inboxGate = deferred();
    const item = (runId, id) => ({ taskId: "task", message: { runId, id } });
    owners.owner.read = async (method, params) => {
        if (method === "areal/task/list") return listGate.promise;
        if (params.after) return page([item("r1", "m1"), item("r2", "m1"), item("r2", "m2")]);
        await inboxGate.promise;
        return page([item("r1", "m1")], "next");
    };
    const list = observe(taskCatalog(backend, { operation: "list" }));
    const inbox = taskCatalog(backend, { operation: "inbox", limit: 3 });
    const secondInbox = taskCatalog(backend, { operation: "inbox", limit: 1 });
    await flush();
    assert.deepEqual(
        owners.owner.calls.map((call) => call.method),
        ["areal/task/list", "areal/inbox/list"],
    );
    inboxGate.resolve();
    const result = await inbox;
    assert.deepEqual(
        result.data.map((task) => [task.taskId, task.message.runId, task.message.id]),
        [["task", "r1", "m1"], ["task", "r2", "m1"], ["task", "r2", "m2"]],
    );
    assert.equal(result.hasMore, false);
    assert.equal((await secondInbox).hasMore, true);
    assert.deepEqual(owners.owner.tasks, []);
    assert.equal((await deadline(advance, list)).errors[0].code, "TASK_CATALOG_TIMEOUT");
});

for (const change of ["replace", "close", "shutdown"]) {
    test(`connection ${change} rejects stale page before model update and retains healthy owner`, async () => {
        const { backend, owners } = fixture(["stale", "healthy"]);
        const gate = deferred();
        owners.stale.read = () => gate.promise;
        const pending = taskCatalog(backend, { operation: "list" });
        await flush();
        if (change === "replace")
            owners.stale.project.client = {
                request() {
                    throw new Error("not called");
                },
            };
        if (change === "close") owners.stale.project.client.closed = true;
        if (change === "shutdown") backend.closing = true;
        gate.resolve(page([scheduled("stale")]));
        const result = await pending;
        assert.deepEqual(
            result.data.map((task) => task.id),
            ["healthy"],
        );
        assert.match(result.errors[0].message, /STALE_CONNECTION \[redacted\]/);
        assert.deepEqual(owners.stale.tasks, []);
    });
}

test("late timed-out RPC cannot publish after connection replacement", async (t) => {
    const advance = clock(t);
    const { backend, owners } = fixture();
    const gate = deferred();
    owners.owner.read = () => gate.promise;
    const result = await deadline(advance, observe(taskCatalog(backend, { operation: "list" })));
    assert.deepEqual(result.data, []);
    assert.equal(result.errors[0].code, "TASK_CATALOG_TIMEOUT");
    owners.owner.project.client = {};
    gate.resolve(page([scheduled("stale")]));
    await flush();
    assert.deepEqual(owners.owner.tasks, []);
});

test("repeated pagination cursors produce an owner error", async () => {
    const { backend, owners } = fixture();
    owners.owner.read = async () => page([], "same");
    const result = await taskCatalog(backend, { operation: "list" });
    assert.deepEqual(result.data, []);
    assert.match(result.errors[0].message, /分页未前进/);
    assert.equal(result.errors[0].code, "TASK_CATALOG_READ_FAILED");
    assert.equal(result.errors[0].stage, "list");
});

test("maximum scan slices at 1024 and reports remaining data", async () => {
    const { backend, owners } = fixture();
    owners.owner.read = async (_method, params) => {
        const offset = Number(params.after ?? 0);
        return page(
            Array.from({ length: 100 }, (_, i) => scheduled(String(offset + i))),
            String(offset + 100),
        );
    };
    const result = await taskCatalog(backend, { operation: "list", limit: 1024 });
    assert.equal(result.data.length, 1024);
    assert.equal(result.hasMore, true);
    assert.equal(result.data[0].id, "0");
    assert.equal(result.data.at(-1).id, "1023");
});

test("invalid requests are rejected without starting owners", async () => {
    const { backend } = fixture();
    for (const request of [
        { operation: "delete" },
        ...[0, -1, 1025, 1.2, "2"].map((limit) => ({ operation: "list", limit })),
    ]) {
        await assert.rejects(taskCatalog(backend, request), /无效任务列表请求/);
    }
    await assert.rejects(taskCatalog(backend, { operation: "list", projectId: "missing" }), /任务所有者不存在/);
    assert.deepEqual(backend.starts, []);
});
