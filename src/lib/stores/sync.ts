import { browser } from "$app/environment";
import { get, writable } from "svelte/store";
import { cues as localCues, terms as localTerms, reviewEvents as localEvents, snapshots as localSnapshots, tracks as localTracks } from "./subtitles";
import type { Cue, CueStatus, GlossaryTerm, ReviewEvent } from "./subtitles";
import { initialState, KEY } from "./persistence";
import type { Credential, CredentialState, OpKind, PersistedV2, SyncConflict } from "./persistence";

// 重新导出类型，供页面与其它模块使用
export type { Credential, CredentialState, OpKind, SyncConflict } from "./persistence";

// ============================================================================
// 离线凭据同步引擎
//
// 每台设备的改动都会生成一条按设备内序号递增的「凭据」(Credential)。
// 联网后凭据按序重放：
//   - 凭据重复回传只算一次（幂等台账 appliedCredentialIds）
//   - 目标字幕不在时按时间码找回（recoverByTime）
//   - 字段级三路合并：base / 本机 / 协作方，只有一方改则采用，两边都改则留两版待判
//   - 已锁定术语、已通过审校结论受保护，不能被重放盖掉
//   - 合并在某条凭据失败/冲突时停下，下次从没过完的凭据接着重试（断点续传）
// 旧数据没有凭据，升级后以基线身份保留，字幕与审校记录不丢。
// ============================================================================

const RECOVER_THRESHOLD = 2.0; // 按时间找回的最大秒差

// 设备身份与旧数据迁移见 persistence.ts；此处直接使用其初始化结果。

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
export const deviceId = writable<string>(initialState.deviceId);
export const online = writable<boolean>(browser ? navigator.onLine : true);
export const outbox = writable<Credential[]>(initialState.outbox);
export const conflicts = writable<SyncConflict[]>(initialState.conflicts);
export const remoteCues = writable<Cue[]>(initialState.remoteCues);
export const remoteTerms = writable<GlossaryTerm[]>(initialState.remoteTerms);
export const remoteEvents = writable<ReviewEvent[]>(initialState.remoteEvents);
export const remoteCredentials = writable<Credential[]>(initialState.remoteCredentials);
export const appliedCredentialIds = writable<string[]>(initialState.appliedCredentialIds);
export const syncing = writable(false);
export const syncMessage = writable("");

let seq = initialState.seq;
let replayTimer: ReturnType<typeof setTimeout> | undefined;
let replayQueued = false;
let replayInFlight = false;

// 字幕/审校状态变化时持久化。订阅放在微任务里，等 subtitles 模块初始化完成后再建立，
// 避免循环依赖导致 deviceId 尚未初始化就触发 persist。
if (browser) {
  queueMicrotask(() => {
    [localTracks, localCues, localTerms, localEvents, localSnapshots].forEach((s) => s.subscribe(persist));
  });
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------
export function persist() {
  if (!browser) return;
  const data: PersistedV2 = {
    version: 2,
    deviceId: get(deviceId),
    seq,
    cues: get(localCues),
    terms: get(localTerms),
    events: get(localEvents),
    snapshots: get(localSnapshots),
    tracks: get(localTracks),
    outbox: get(outbox),
    remoteCues: get(remoteCues),
    remoteTerms: get(remoteTerms),
    remoteEvents: get(remoteEvents),
    remoteCredentials: get(remoteCredentials),
    appliedCredentialIds: get(appliedCredentialIds),
    conflicts: get(conflicts)
  };
  localStorage.setItem(KEY, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function cueModifiedSince(target: Cue, base: Record<string, unknown>): boolean {
  return Object.entries(base).some(([k, v]) => !equals((target as unknown as Record<string, unknown>)[k], v));
}

function mkConflict(cred: Credential, field: string, message: string, localValue: unknown, remoteValue: unknown): SyncConflict {
  return {
    id: crypto.randomUUID(),
    credentialId: cred.id,
    deviceId: cred.deviceId,
    seq: cred.seq,
    op: cred.op,
    cueId: cred.targetId,
    trackId: cred.trackId ?? "",
    field,
    message,
    localValue,
    remoteValue,
    status: "待处理",
    createdAt: new Date().toISOString()
  };
}

// 目标字幕不在时按时间码找回：同轨道上时间重叠最多或相隔最近（阈值内）的一条
function recoverByTime(cred: Credential, list: Cue[]): Cue | undefined {
  const trackId = cred.trackId;
  if (!trackId) return undefined;
  const start = Number(cred.payload.start ?? cred.base.start ?? NaN);
  const end = Number(cred.payload.end ?? cred.base.end ?? NaN);
  if (Number.isNaN(start)) return undefined;
  const candidates = list.filter((c) => c.trackId === trackId);
  let best: Cue | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    const overlap = Math.min(end, c.end) - Math.max(start, c.start);
    if (overlap > 0) {
      const score = -overlap;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    } else {
      const gap = Math.max(0, Math.max(start - c.end, c.start - end));
      if (gap <= RECOVER_THRESHOLD && gap < bestScore) {
        bestScore = gap;
        best = c;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 凭据登记：每台设备的改动都生成一条有序凭据
// ---------------------------------------------------------------------------
export function recordCredential(input: {
  op: OpKind;
  targetId: string;
  payload: Record<string, unknown>;
  base: Record<string, unknown>;
  trackId?: string;
}): Credential {
  const cred: Credential = {
    id: crypto.randomUUID(),
    deviceId: get(deviceId),
    seq: ++seq,
    op: input.op,
    trackId: input.trackId,
    targetId: input.targetId,
    payload: input.payload,
    base: input.base,
    createdAt: new Date().toISOString(),
    state: "pending",
    attempts: 0
  };
  outbox.update((o) => [...o, cred]);
  persist();
  scheduleReplay();
  return cred;
}

function scheduleReplay() {
  if (!get(online)) return;
  if (replayTimer) return;
  replayTimer = setTimeout(() => {
    replayTimer = undefined;
    void replay();
  }, 350);
}

// ---------------------------------------------------------------------------
// 三路合并重放
// ---------------------------------------------------------------------------
interface MergeStores {
  cues: typeof localCues;
  terms: typeof localTerms;
}

interface MergeResult {
  status: "applied" | "conflict" | "skipped";
  conflict?: SyncConflict;
  retargeted?: string;
}

function applySplit(cueStore: typeof localCues, target: Cue, cred: Credential) {
  const second = cred.payload.second as Cue;
  const firstEnd = Number(cred.payload.firstEnd);
  cueStore.update((list) =>
    list.flatMap((c) => (c.id === target.id ? [{ ...c, end: firstEnd }, second] : [c]))
  );
}

function applyMerge(cueStore: typeof localCues, list: Cue[], target: Cue, cred: Credential) {
  const removeId = cred.payload.removeId as string;
  const end = Number(cred.payload.end);
  const translated = String(cred.payload.translated ?? "");
  cueStore.update((items) =>
    items
      .filter((c) => c.id !== removeId)
      .map((c) => (c.id === target.id ? { ...c, end, translated, status: "翻译中" as CueStatus } : c))
  );
}

function mergeInto(cred: Credential, stores: MergeStores, ledger: string[], localSide: boolean): MergeResult {
  if (ledger.includes(cred.id)) return { status: "skipped" };

  // 冲突中「本机版本 / 协作版本」的取值：localSide 表示正在把凭据合并到本机
  const sides = (incoming: unknown, current: unknown): { local: unknown; remote: unknown } =>
    localSide ? { local: current, remote: incoming } : { local: incoming, remote: current };

  if (cred.op === "cue:add") {
    const list = get(stores.cues);
    if (list.some((c) => c.id === cred.targetId)) return { status: "skipped" };
    stores.cues.update((l) => [...l, structuredClone(cred.payload as unknown as Cue)]);
    return { status: "applied" };
  }

  if (cred.op === "cue:remove") {
    const list = get(stores.cues);
    const target = list.find((c) => c.id === cred.targetId);
    if (!target) return { status: "skipped" };
    if (cueModifiedSince(target, cred.base)) {
      const s = sides(cred.base, target);
      return { status: "conflict", conflict: mkConflict(cred, "结构", "字幕已被另一方修改，不能直接删除，留两版待判", s.local, s.remote) };
    }
    stores.cues.update((l) => l.filter((c) => c.id !== cred.targetId));
    return { status: "applied" };
  }

  if (cred.op === "cue:update") {
    const list = get(stores.cues);
    let target = list.find((c) => c.id === cred.targetId);
    let retargeted: string | undefined;
    if (!target) {
      const recovered = recoverByTime(cred, list);
      if (recovered) {
        target = recovered;
        retargeted = recovered.id;
      } else {
        const s = sides(cred.base, null);
        return { status: "conflict", conflict: mkConflict(cred, "id", "目标字幕不存在且按时间找回失败，凭据保留待判", s.local, s.remote) };
      }
    }
    const merged: Record<string, unknown> = { ...target };
    let conflict: SyncConflict | undefined;
    for (const [field, incoming] of Object.entries(cred.payload)) {
      const baseVal = cred.base[field];
      const current = (target as unknown as Record<string, unknown>)[field];
      // 已通过的审校结论不能被重放盖掉
      if (field === "status" && target.status === "已通过" && incoming !== "已通过") {
        const s = sides(incoming, current);
        conflict = conflict ?? mkConflict(cred, field, "已通过的审校结论不能被重放盖掉", s.local, s.remote);
        continue;
      }
      if (equals(current, incoming)) {
        merged[field] = incoming;
        continue;
      }
      if (equals(current, baseVal)) {
        merged[field] = incoming; // 只有提交方改
        continue;
      }
      if (equals(incoming, baseVal)) {
        merged[field] = current; // 只有目标方改
        continue;
      }
      const s = sides(incoming, current);
      conflict = conflict ?? mkConflict(cred, field, `两边都修改了「${field}」，留两版待判`, s.local, s.remote);
    }
    if (conflict) return { status: "conflict", conflict, retargeted };
    stores.cues.update((l) => l.map((c) => (c.id === target!.id ? (merged as unknown as Cue) : c)));
    return { status: "applied", retargeted };
  }

  if (cred.op === "cue:split") {
    const list = get(stores.cues);
    let target = list.find((c) => c.id === cred.targetId);
    let retargeted: string | undefined;
    if (!target) {
      const recovered = recoverByTime(cred, list);
      if (!recovered) {
        const s = sides(cred.base, null);
        return { status: "conflict", conflict: mkConflict(cred, "id", "拆分目标不存在且按时间找回失败", s.local, s.remote) };
      }
      target = recovered;
      retargeted = recovered.id;
    }
    if (!equals(target.end, cred.base.end)) {
      const s = sides(cred.base, target);
      return { status: "conflict", conflict: mkConflict(cred, "结构", "字幕已被另一方拆分/合并，结构冲突留两版待判", s.local, s.remote) };
    }
    applySplit(stores.cues, target, cred);
    return { status: "applied", retargeted };
  }

  if (cred.op === "cue:merge") {
    const list = get(stores.cues);
    const target = list.find((c) => c.id === cred.targetId);
    if (!target) {
      const s = sides(cred.base, null);
      return { status: "conflict", conflict: mkConflict(cred, "id", "合并目标不存在且按时间找回失败", s.local, s.remote) };
    }
    if (!equals(target.end, cred.base.end)) {
      const s = sides(cred.base, target);
      return { status: "conflict", conflict: mkConflict(cred, "结构", "字幕已被另一方拆分/合并，结构冲突留两版待判", s.local, s.remote) };
    }
    applyMerge(stores.cues, list, target, cred);
    return { status: "applied" };
  }

  if (cred.op === "term:lock") {
    const list = get(stores.terms);
    const term = list.find((t) => t.id === cred.targetId);
    if (!term || term.status === "已锁定") return { status: "skipped" };
    stores.terms.update((l) => l.map((t) => (t.id === cred.targetId ? { ...t, status: "已锁定", owner: "术语管理员" } : t)));
    return { status: "applied" };
  }

  if (cred.op === "review:set") {
    const list = get(stores.cues);
    const target = list.find((c) => c.id === cred.targetId);
    if (!target) {
      const s = sides(cred.base, null);
      return { status: "conflict", conflict: mkConflict(cred, "id", "审校目标不存在且按时间找回失败", s.local, s.remote) };
    }
    if (target.status === "已通过" && cred.payload.status !== "已通过") {
      const s = sides(cred.payload.status, target.status);
      return { status: "conflict", conflict: mkConflict(cred, "status", "已通过的审校结论不能被重放盖掉", s.local, s.remote) };
    }
    stores.cues.update((l) =>
      l.map((c) =>
        c.id === target.id
          ? { ...c, status: cred.payload.status as CueStatus, reviewerNote: (cred.payload.reviewerNote as string) ?? c.reviewerNote }
          : c
      )
    );
    return { status: "applied" };
  }

  return { status: "skipped" };
}

function updateCredInStore(id: string, patch: Partial<Credential>) {
  outbox.update((l) => l.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  remoteCredentials.update((l) => l.map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

function markApplied(cred: Credential, retargeted?: string) {
  updateCredInStore(cred.id, {
    state: "applied",
    attempts: cred.attempts + 1,
    appliedAt: new Date().toISOString(),
    ...(retargeted ? { targetId: retargeted, retargetedFrom: cred.targetId } : {})
  });
}

function markConflict(cred: Credential) {
  updateCredInStore(cred.id, { state: "conflict", attempts: cred.attempts + 1 });
}

// ---------------------------------------------------------------------------
// 联网重放：先把本机凭据推到协作端，再把协作端凭据拉回本机
// 任一条冲突/失败即停下，下次从没做完的凭据接着重试
// ---------------------------------------------------------------------------
export async function replay() {
  if (!browser) return;
  if (!get(online)) {
    syncMessage.set("离线：凭据已排队，联网后逐条重放");
    return;
  }
  if (replayInFlight) {
    replayQueued = true;
    return;
  }
  replayInFlight = true;
  syncing.set(true);
  let applied = 0;
  let conflicted = 0;
  try {
    const localStores: MergeStores = { cues: localCues, terms: localTerms };
    const remoteStores: MergeStores = { cues: remoteCues, terms: remoteTerms };
    const ledger = [...get(appliedCredentialIds)];

    // 推：本机待重放凭据 → 协作端
    const pending = get(outbox)
      .filter((c) => c.state === "pending")
      .sort((a, b) => a.seq - b.seq);
    for (const cred of pending) {
      const res = mergeInto(cred, remoteStores, ledger, false);
      if (res.status === "applied") {
        markApplied(cred, res.retargeted);
        ledger.push(cred.id);
        applied += 1;
      } else if (res.status === "skipped") {
        markApplied(cred);
        ledger.push(cred.id);
      } else {
        if (res.conflict) conflicts.update((l) => [res.conflict!, ...l]);
        markConflict(cred);
        conflicted += 1;
        break; // 从没做完的凭据接着重试
      }
    }

    // 拉：协作端凭据 → 本机
    const remotePending = get(remoteCredentials)
      .filter((c) => !ledger.includes(c.id))
      .sort((a, b) => a.seq - b.seq);
    for (const cred of remotePending) {
      const res = mergeInto(cred, localStores, ledger, true);
      if (res.status === "applied") {
        markApplied(cred, res.retargeted);
        ledger.push(cred.id);
        applied += 1;
      } else if (res.status === "skipped") {
        markApplied(cred);
        ledger.push(cred.id);
      } else {
        if (res.conflict) conflicts.update((l) => [res.conflict!, ...l]);
        markConflict(cred);
        conflicted += 1;
        break;
      }
    }

    appliedCredentialIds.set(ledger);
    persist();
    syncMessage.set(conflicted ? `重放完成：${applied} 条已应用，${conflicted} 条待判` : `重放完成：${applied} 条凭据已应用`);
  } finally {
    syncing.set(false);
    replayInFlight = false;
    if (replayQueued) {
      replayQueued = false;
      scheduleReplay();
    }
  }
}

// ---------------------------------------------------------------------------
// 冲突判定：采用本机 / 采用协作版本，判完从没做完的凭据接着重试
// ---------------------------------------------------------------------------
export function resolveConflict(id: string, resolution: "采用本机" | "采用协作版本") {
  const conflict = get(conflicts).find((c) => c.id === id);
  if (!conflict) return;
  conflicts.update((l) => l.map((c) => (c.id === id ? { ...c, status: resolution } : c)));

  const value = resolution === "采用协作版本" ? conflict.remoteValue : conflict.localValue;
  if (conflict.field === "结构" || conflict.field === "id") {
    if (value && typeof value === "object") {
      localCues.update((l) => l.map((c) => (c.id === conflict.cueId ? { ...c, ...(value as object) } : c)));
    }
  } else if (conflict.field === "status") {
    localCues.update((l) => l.map((c) => (c.id === conflict.cueId ? { ...c, status: value as CueStatus } : c)));
  } else {
    localCues.update((l) => l.map((c) => (c.id === conflict.cueId ? { ...c, [conflict.field]: value } : c)));
  }

  // 凭据已判定，记入台账并允许后续凭据继续重放
  if (!get(appliedCredentialIds).includes(conflict.credentialId)) {
    appliedCredentialIds.update((l) => [...l, conflict.credentialId]);
  }
  outbox.update((l) => l.map((c) => (c.id === conflict.credentialId ? { ...c, state: "applied", appliedAt: new Date().toISOString() } : c)));

  persist();
  void replay();
}

// ---------------------------------------------------------------------------
// 模拟协作者改动（另一台设备的凭据），用于演示两边都改
// ---------------------------------------------------------------------------
export function simulateCollaboratorEdit() {
  const list = get(remoteCues);
  const target = list.find((c) => c.id === "c2") ?? list[0];
  if (!target) return;
  const newEnd = Number((target.end + 0.2).toFixed(1));
  const cred: Credential = {
    id: crypto.randomUUID(),
    deviceId: "dev-协作译员",
    seq: get(remoteCredentials).length + 1,
    op: "cue:update",
    trackId: target.trackId,
    targetId: target.id,
    payload: { end: newEnd },
    base: { end: target.end },
    createdAt: new Date().toISOString(),
    state: "pending",
    attempts: 0
  };
  remoteCredentials.update((l) => [...l, cred]);
  persist();
  scheduleReplay();
}

// ---------------------------------------------------------------------------
// 联网 / 离线
// ---------------------------------------------------------------------------
export function setOnline(value: boolean) {
  online.set(value);
  if (value) void replay();
  else syncMessage.set("离线：凭据已排队，联网后逐条重放");
}

if (browser) {
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
}
