import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteControl } from "../app/src/core/remote.cjs";

async function host(t) {
  const home = await mkdtemp(join(tmpdir(), "rc12-host-"));
  const remote = new RemoteControl(
    {
      schedule() {},
      backend: {
        home,
        saved: [],
        async save(name, value) {
          await writeFile(join(home, name), JSON.stringify(value));
        },
      },
    },
    {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "fixture",
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
  );
  t.after(async () => {
    remote.close();
    await rm(home, { recursive: true, force: true });
  });
  await remote.init();
  return remote;
}

test("Relay enrollment requires explicit local confirmation and exact HTTPS origin", async (t) => {
  const remote = await host(t);
  assert.throws(
    () =>
      remote.control({ operation: "enable", relay: "https://relay.example", code: "x".repeat(43) }),
    /无效手机设置参数/,
  );
  for (const relay of [
    "http://127.0.0.1:3000",
    "wss://relay.example",
    "https://relay.example/",
    "https://relay.example/path",
    "https://user:pass@relay.example",
  ]) {
    await assert.rejects(
      remote.control({ operation: "enable", relay, code: "x".repeat(43), confirmed: true }),
      { code: "invalid-origin" },
    );
  }
  assert.equal(remote.state().enabled, false);
});

test("fresh desktop does not access secure storage until remote is requested", async (t) => {
  const remote = await host(t);
  let accesses = 0;
  remote.encryption = {
    isEncryptionAvailable() {
      accesses += 1;
      return false;
    },
    decryptString() {
      throw new Error("unexpected decryption");
    },
    encryptString() {
      throw new Error("unexpected encryption");
    },
  };
  await remote.init();
  assert.equal(accesses, 0);
  assert.equal(remote.state().enabled, false);
  assert.equal(remote.state().directEnabled, false);
  await assert.rejects(remote.control({ operation: "enableDirect" }), /系统安全存储不可用/);
  assert.equal(accesses, 1);
});

test("existing encrypted remote state still requires successful secure storage", async (t) => {
  const remote = await host(t);
  await writeFile(join(remote.backend.home, "remote.json"), JSON.stringify({ encrypted: "eA==" }));
  remote.encryption.decryptString = () => {
    throw new Error("fixture access denied");
  };
  await assert.rejects(remote.init(), /无法读取手机配对/);
  assert.equal(remote.state().enabled, false);
});
