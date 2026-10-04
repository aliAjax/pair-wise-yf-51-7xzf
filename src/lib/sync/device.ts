// 设备端：本地发件箱 + 拉取/回传/续传 + 旧数据迁移。
// 每条用户改动先写成本机有序凭据（离线立即可用），联网后逐条重放到 Hub。
import { replayInto } from "./engine";
import type { PushResult } from "./hub";
import { Hub } from "./hub";
import type {
  Cue,
  Credential,
  CredentialOp,
  GlossaryTerm,
  ReviewEvent,
  SyncState,
  Track
} from "./types";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LegacyData {
  tracks?: Track[];
  cues?: Cue[];
  terms?: GlossaryTerm[];
  events?: ReviewEvent[];
  snapshots?: unknown[];
}

interface DeviceData {
  deviceId: string;
  deviceName: string;
  actor: string;
  /** 下一条凭据的 seq（从 1 开始） */
  nextSeq: number;
  /** 待回传/可能重试的凭据，严格按 seq 排序 */
  outbox: Credential[];
  /** Hub 最近一次 pull 下来的基线状态 */
  hubState: SyncState;
  /** 本机自己已确认终态的凭据 id（applied/conflict/blocked） */
  acked: string[];
  /** 旧数据迁移标记 */
  migrated: boolean;
  snapshots: { id: string; name: string; time: string; cues: Cue[] }[];
}

export interface SyncReport {
  pushed: number;
  duplicate: number;
  blocked: string[];
  conflict: string[];
  /** 本轮仍重试不了、下次继续的凭据 id（合并失败等） */
  retryPending: string[];
  errors: string[];
}

const DEVICE_KEY_PREFIX = "pair-wise-yf-51/device-v1:";
export const LEGACY_KEY = "pair-wise-yf-51/subtitles-v1";

export function emptyHubState(): SyncState {
  return { revision: 0, tracks: [], cues: [], terms: [], events: [], conflicts: [], tombstones: [] };
}

/**
 * 一台设备 = 一个独立 localStorage 命名空间 + 同一个 Hub（模拟断网/回网）。
 */
export class Device {
  private data: DeviceData;
  private readonly key: string;

  constructor(
    private storage: StorageLike,
    public deviceId: string,
    deviceName: string,
    private hub: Hub,
    actor = deviceName
  ) {
    this.key = DEVICE_KEY_PREFIX + deviceId;
    const raw = storage.getItem(this.key);
    if (raw) {
      this.data = JSON.parse(raw) as DeviceData;
    } else {
      this.data = {
        deviceId,
        deviceName,
        actor,
        nextSeq: 1,
        outbox: [],
        hubState: emptyHubState(),
        acked: [],
        migrated: false,
        snapshots: []
      };
      this.save();
    }
  }

  get name() {
    return this.data.deviceName;
  }

  get actorName() {
    return this.data.actor;
  }

  setActor(actor: string) {
    this.data.actor = actor;
    this.save();
  }

  private save() {
    this.storage.setItem(this.key, JSON.stringify(this.data));
  }

  /* ---------------- 凭据生产 ---------------- */

  /** 写一条有序凭据。离线也立即生效（体现在 draft 视图）。 */
  emit(op: CredentialOp): Credential {
    const cred: Credential = {
      id: crypto.randomUUID(),
      deviceId: this.deviceId,
      seq: this.data.nextSeq++,
      actor: this.data.actor,
      time: new Date().toISOString(),
      op
    };
    this.data.outbox.push(cred);
    this.save();
    return cred;
  }

  hintFor(cue: Cue) {
    return { trackId: cue.trackId, start: cue.start, end: cue.end };
  }

  /* ---------------- 视图 ---------------- */

  /** Hub 基线 + 本机未确认凭据的草稿预演（draft 模式放宽保护） */
  view(): SyncState {
    return replayInto(this.data.hubState, this.data.outbox, { draft: true });
  }

  /** 已确认的 Hub 视图（不含本机未回传改动） */
  hubView(): SyncState {
    return structuredClone(this.data.hubState);
  }

  get pendingCount() {
    return this.data.outbox.length;
  }

  get pendingCredentials(): Credential[] {
    return [...this.data.outbox];
  }

  get snapshots() {
    return this.data.snapshots;
  }

  createSnapshot(name?: string) {
    const view = this.view();
    const item = {
      id: crypto.randomUUID(),
      name: name ?? `时间轴快照 ${this.data.snapshots.length + 1}`,
      time: new Date().toISOString(),
      cues: structuredClone(view.cues)
    };
    this.data.snapshots = [item, ...this.data.snapshots].slice(0, 12);
    this.save();
  }

  /* ---------------- 旧数据迁移（没有凭据） ---------------- */

  /**
   * 升级迁移：旧数据没有凭据，字幕和审校记录不能丢。
   * 打包成一条 baseline.import 凭据：本设备接着编辑；联网回传后进 Hub，
   * 其他设备 pull 即可拿到全部旧字幕与审校记录。
   */
  migrateLegacy(raw: string | null): boolean {
    if (this.data.migrated || !raw) return false;
    const legacy = JSON.parse(raw) as LegacyData;
    const cues = (legacy.cues ?? []).map((cue) => ({ ...cue, rev: cue.rev ?? 1 }));
    // 旧审校记录保留，标记为无凭据的历史记录
    const events = (legacy.events ?? []).map((evt, index) => ({
      ...evt,
      id: evt.id || `legacy-ev-${index}`,
      legacy: true as const
    }));
    this.emit({
      type: "baseline.import",
      cues,
      terms: legacy.terms ?? [],
      tracks: legacy.tracks ?? [],
      events
    });
    this.data.migrated = true;
    if (Array.isArray(legacy.snapshots)) {
      this.data.snapshots = legacy.snapshots as DeviceData["snapshots"];
    }
    this.save();
    return true;
  }

  get migrated() {
    return this.data.migrated;
  }

  /* ---------------- 同步：逐条重放，失败续传 ---------------- */

  /**
   * 联网后同步：先 pull，再把发件箱凭据按 seq 逐条回传。
   * - 重复回传只算一次（Hub 去重，本机出箱）
   * - retry（如合并对端缺失）：停在这条凭据，下一轮从没做完处接着重试
   * - conflict/blocked 是终态：凭据出箱，冲突留两版待判
   */
  sync(): SyncReport {
    const report: SyncReport = { pushed: 0, duplicate: 0, blocked: [], conflict: [], retryPending: [], errors: [] };

    // 1) 拉取 Hub 最新基线（含其他设备已确认改动与待判冲突）
    const pulled = this.hub.pull();
    this.data.hubState = pulled.state;

    // 2) 以 journal 为准清理本机已确认凭据（处理“别的窗口/会话已回传”的重复）
    const myJournal = new Map(pulled.journal.filter((entry) => entry.deviceId === this.deviceId).map((entry) => [entry.id, entry]));

    // 3) 按序逐条回传
    const remaining: Credential[] = [];
    for (const cred of this.data.outbox) {
      const known = myJournal.get(cred.id);
      if (known) {
        report.duplicate += 1;
        continue; // 凭据重复回传只算一次
      }
      let result: PushResult;
      try {
        result = this.hub.push(cred);
      } catch (err) {
        report.errors.push(`${cred.seq}: ${(err as Error).message}`);
        remaining.push(cred);
        continue;
      }
      if (result.result === "duplicate") {
        report.duplicate += 1;
        continue;
      }
      if (result.result === "out-of-order") {
        // Hub 缺更早的凭据（不应发生）：停住，从这条开始下轮重试
        report.errors.push(`凭据 ${cred.seq} 乱序，等待前序凭据`);
        remaining.push(cred);
        break;
      }
      if (result.result === "retry") {
        // 合并失败等：从没做完的凭据开始，后续凭据本轮也不越过它
        report.retryPending.push(cred.id);
        remaining.push(cred, ...this.data.outbox.slice(this.data.outbox.indexOf(cred) + 1));
        break;
      }
      if (result.result === "blocked") report.blocked.push(result.entry.reason ?? cred.op.type);
      if (result.result === "conflict") report.conflict.push(cred.id);
      report.pushed += 1;
    }

    this.data.outbox = remaining;

    // 4) 回放完成后再次 pull，拿到本轮重放结果（冲突/拦截事件）
    this.data.hubState = this.hub.pull().state;
    this.save();
    return report;
  }
}
