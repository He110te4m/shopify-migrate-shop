import { getStore, type Store } from "@netlify/blobs";
import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { MemorySessionStorage } from "@shopify/shopify-app-session-storage-memory";

const isNetlify = process.env.NETLIFY === "true";

// BigInt(userId) 无法直接 JSON.stringify
const jsonStringify = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? Number(v) : v));

async function listAllKeys(store: Store, prefix?: string): Promise<string[]> {
  const { blobs } = await store.list({ prefix });
  return blobs.map((b) => b.key);
}

class NetlifyBlobsSessionStorage implements SessionStorage {
  private store: Store;

  constructor() {
    this.store = getStore({ name: "shopify-sessions", consistency: "strong" });
  }

  async storeSession(session: Session): Promise<boolean> {
    await this.store.set(session.id, jsonStringify(session.toPropertyArray(true)));
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const raw = await this.store.get(id, { type: "text" });
    if (!raw) return undefined;
    return Session.fromPropertyArray(JSON.parse(raw), true);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.store.delete(id);
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await Promise.all(ids.map((id) => this.store.delete(id)));
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const keys = await listAllKeys(this.store);
    const sessions = await Promise.all(keys.map((key) => this.loadSession(key)));
    return sessions.filter((s): s is Session => s?.shop === shop);
  }
}

export interface MigrationRunRecord {
  id: string;
  shop: string;
  createdAt: string;
  fileName: string | null;
  summary: string;
  report: string;
}

interface MigrationRunStore {
  save(
    run: Omit<MigrationRunRecord, "id" | "createdAt">,
  ): Promise<MigrationRunRecord>;
  list(shop: string, limit?: number): Promise<MigrationRunRecord[]>;
  get(shop: string, id: string): Promise<MigrationRunRecord | undefined>;
}

class NetlifyBlobsMigrationRunStore implements MigrationRunStore {
  private store: Store;

  constructor() {
    this.store = getStore({ name: "migration-runs", consistency: "strong" });
  }

  private key(shop: string, id: string) {
    return `${shop}/${id}`;
  }

  async save(run: Omit<MigrationRunRecord, "id" | "createdAt">) {
    const record: MigrationRunRecord = {
      ...run,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.store.set(this.key(run.shop, record.id), jsonStringify(record));
    return record;
  }

  async list(shop: string, limit = 50) {
    const keys = await listAllKeys(this.store, `${shop}/`);
    const records = (
      await Promise.all(
        keys.map(async (key) => {
          const raw = await this.store.get(key, { type: "text" });
          return raw ? (JSON.parse(raw) as MigrationRunRecord) : undefined;
        }),
      )
    ).filter((r): r is MigrationRunRecord => r !== undefined);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return records.slice(0, limit);
  }

  async get(shop: string, id: string) {
    const raw = await this.store.get(this.key(shop, id), { type: "text" });
    return raw ? (JSON.parse(raw) as MigrationRunRecord) : undefined;
  }
}

class MemoryMigrationRunStore implements MigrationRunStore {
  private runs = new Map<string, MigrationRunRecord>();

  async save(run: Omit<MigrationRunRecord, "id" | "createdAt">) {
    const record: MigrationRunRecord = {
      ...run,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.runs.set(record.id, record);
    return record;
  }

  async list(shop: string, limit = 50) {
    return [...this.runs.values()]
      .filter((r) => r.shop === shop)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async get(shop: string, id: string) {
    const record = this.runs.get(id);
    return record?.shop === shop ? record : undefined;
  }
}

// HMR 下保留内存数据
const globalStore = globalThis as unknown as {
  __memoryMigrationRuns?: MemoryMigrationRunStore;
};

export const sessionStorage: SessionStorage = isNetlify
  ? new NetlifyBlobsSessionStorage()
  : new MemorySessionStorage();

export const migrationRuns: MigrationRunStore = isNetlify
  ? new NetlifyBlobsMigrationRunStore()
  : (globalStore.__memoryMigrationRuns ??= new MemoryMigrationRunStore());
