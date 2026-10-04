// Hub：协作中心。浏览器环境用 localStorage 模拟服务端持久化；
// 测试环境可注入内存 Storage。
import { applyCredential, emptyState } from "./engine";
import type {
  ApplyOutcome,
  Credential,
  JournalEntry,
  PullResponse,
  SyncState
} from "./types";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface HubData {
  state: SyncState;
  /** 已接收凭据去重表：credentialId -> JournalEntry，重复回传只算一次 */
  seen: Record<string, JournalEntry>;
  /** 每个设备已接收的最大连续 seq（要求按序，缺口不接收） */
  deviceSeq: Record<string, number>;
  journal: JournalEntry[];
}

const HUB_KEY = "pair-wise-yf-51/sync-hub-v1";

function load(storage: StorageLike | undefined): HubData {
  if (!storage) return { state: emptyState(), seen: {}, deviceSeq: {}, journal: [] };
  const raw = storage.getItem(HUB_KEY);
  if (!raw) return { state: emptyState(), seen: {}, deviceSeq: {}, journal: [] };
  try {
    const data = JSON.parse(raw) as HubData;
    return { state: { ...emptyState(), ...data.state }, seen: data.seen ?? {}, deviceSeq: data.deviceSeq ?? {}, journal: data.journal ?? [] };
  } catch {
    return { state: emptyState(), seen: {}, deviceSeq: {}, journal: [] };
  }
}

export type PushResult =
  | { result: "duplicate"; entry: JournalEntry }
  | { result: "out-of-order" }
  | { result: "retry"; outcome: Extract<ApplyOutcome, { outcome: "retry" }> }
  | { result: "applied" | "conflict" | "blocked"; entry: JournalEntry; outcome: ApplyOutcome };

export class Hub {
  private data: HubData;

  constructor(private storage?: StorageLike) {
    this.data = load(storage);
  }

  private save() {
    if (this.storage) this.storage.setItem(HUB_KEY, JSON.stringify(this.data));
  }

  /** 存储即真相源：每次操作前重载，保证多个实例看到同一个 Hub */
  private reload() {
    if (this.storage) this.data = load(this.storage);
  }

  /** 当前中心状态的深拷贝（pull 用） */
  snapshot(): SyncState {
    this.reload();
    return structuredClone(this.data.state);
  }

  pull(): PullResponse {
    this.reload();
    return { state: structuredClone(this.data.state), journal: structuredClone(this.data.journal) };
  }

  /**
   * 回传一条凭据。
   * - 重复凭据只返回既有回执（只算一次，不再重放）
   * - 必须按设备 seq 连续，缺口返回 out-of-order
   * - 冲突/拦截是凭据的终态（记入去重表）；retry 不记终态，允许从未做完处接着重试
   */
  push(cred: Credential): PushResult {
    this.reload();
    const duplicate = this.data.seen[cred.id];
    if (duplicate) return { result: "duplicate", entry: duplicate };

    const expected = (this.data.deviceSeq[cred.deviceId] ?? 0) + 1;
    if (cred.seq !== expected) {
      return { result: "out-of-order" };
    }

    const outcome = applyCredential(this.data.state, cred);

    if (outcome.outcome === "retry") {
      // 不落去重表、不推进 seq；之后调用方从这条凭据接着重试
      return { result: "retry", outcome };
    }

    const entry: JournalEntry = {
      id: cred.id,
      deviceId: cred.deviceId,
      seq: cred.seq,
      result: outcome.outcome === "applied" ? "applied" : outcome.outcome,
      reason: outcome.outcome === "blocked" ? outcome.reason : outcome.outcome === "conflict" ? outcome.conflict.message : undefined,
      time: new Date().toISOString()
    };
    this.data.seen[cred.id] = entry;
    this.data.deviceSeq[cred.deviceId] = cred.seq;
    this.data.journal.push(entry);
    this.save();
    return { result: entry.result, entry, outcome };
  }

  isEmpty(): boolean {
    return this.data.state.revision === 0 && this.data.journal.length === 0;
  }
}
