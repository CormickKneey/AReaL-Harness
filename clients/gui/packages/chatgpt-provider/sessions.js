import { randomUUID } from "node:crypto";
import { ACCOUNT_KEY } from "./account.js";
import { ProviderError } from "./errors.js";

// 目录及每个注册的 token 仍整体存于现有系统安全存储，公开投影永不包含 secret。
export class AuthSessionDirectory {
  constructor(store) {
    this.store = store;
  }
  normalize(record) {
    if (record?.kind === "directory") {
      const value = record.payload;
      if (
        value?.version !== 1 ||
        typeof value.hostId !== "string" ||
        !value.records ||
        !Object.hasOwn(value.records, value.activeId)
      )
        throw new ProviderError("credential_invalid", { phase: "storage" });
      return value;
    }
    const hostId = record?.payload?.hostId ?? `urn:uuid:${randomUUID()}`;
    return {
      version: 1,
      hostId,
      activeId: "primary",
      records: {
        primary: {
          label: "ChatGPT 1",
          record: record ?? { kind: "registration", payload: { hostId } },
        },
      },
    };
  }
  async snapshot() {
    return this.normalize(await this.store.readRecord(ACCOUNT_KEY));
  }
  async update(mutate) {
    const saved = await this.store.modifyRecord(ACCOUNT_KEY, async (current) => {
      const value = this.normalize(current);
      if ((await mutate(value)) === false) return undefined;
      return { kind: "directory", payload: value };
    });
    return this.normalize(saved);
  }
  view(id) {
    return {
      readRecord: async () => {
        const value = await this.snapshot();
        return value.records[id ?? value.activeId]?.record;
      },
      modifyRecord: async (_key, mutate) => {
        let result;
        await this.update(async (value) => {
          const selected = id ?? value.activeId;
          if (!Object.hasOwn(value.records, selected))
            throw new ProviderError("account_changed", { phase: "account" });
          const entry = value.records[selected];
          const next = await mutate(entry.record);
          result = next ?? entry.record;
          if (next === undefined) return false;
          entry.record = next;
        });
        return result;
      },
    };
  }
  async add() {
    const id = randomUUID();
    await this.update((value) => {
      const number = Object.keys(value.records).length + 1;
      value.records[id] = {
        label: `ChatGPT ${number}`,
        record: { kind: "registration", payload: { hostId: value.hostId } },
      };
    });
    return id;
  }
  async activate(id) {
    await this.update((value) => {
      if (!Object.hasOwn(value.records, id) || value.records[id].record?.kind !== "grant")
        throw new ProviderError("credential_missing", { phase: "account" });
      value.activeId = id;
    });
  }
  async public() {
    const value = await this.snapshot();
    return {
      activeAccountId: value.activeId,
      accounts: Object.entries(value.records).map(([id, entry]) => ({
        id,
        label: entry.label,
        email: entry.record?.payload?.email ?? null,
        active: id === value.activeId,
        state:
          entry.record?.kind === "grant"
            ? "saved"
            : entry.record?.payload?.reauthRequired
              ? "reauth_required"
              : "signed_out",
        billing: "subscription",
      })),
    };
  }
}
