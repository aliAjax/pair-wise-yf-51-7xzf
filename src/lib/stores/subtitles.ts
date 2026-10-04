// 字幕协作 store：所有编辑都写成设备本地的有序凭据；
// 断网时乐观生效，联网后逐条重放到 Hub（见 src/lib/sync）。
import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";
import { Device, LEGACY_KEY } from "$lib/sync/device";
import { Hub } from "$lib/sync/hub";
import type {
  ConflictVersion,
  Credential,
  Cue,
  GlossaryTerm,
  PendingConflict,
  ReviewEvent,
  Snapshot,
  Track
} from "$lib/sync/types";
import type { SyncReport } from "$lib/sync/device";

export type { TrackStatus, CueStatus, TermStatus, Track, Cue, GlossaryTerm, ReviewEvent, Snapshot } from "$lib/sync/types";

const DEVICES = [
  { id: "dev-lin", name: "林岚的笔记本", actor: "林岚" },
  { id: "dev-zhou", name: "周野的工位机", actor: "周野" }
] as const;
const ACTIVE_DEVICE_KEY = "pair-wise-yf-51/active-device";
const NETWORK_KEY = "pair-wise-yf-51/online";
const LEGACY_BACKUP_KEY = "pair-wise-yf-51/subtitles-v1-migrated";

// localStorage 同时承担“云端 Hub”与各设备本机存储（单机多设备演示）
const hub = browser ? new Hub(localStorage) : new Hub(undefined);

// SSR 时给一个内存 storage，避免触碰 localStorage
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value)
  };
}

function makeDevice(id: string, name: string, actor: string): Device {
  return new Device(browser ? localStorage : memoryStorage(), id, name, hub, actor);
}

export const activeDeviceId = writable<string>(
  browser ? localStorage.getItem(ACTIVE_DEVICE_KEY) ?? DEVICES[0].id : DEVICES[0].id
);
export const online = writable<boolean>(browser ? localStorage.getItem(NETWORK_KEY) !== "off" : true);
const version = writable(0);
function tick() { version.update((n) => n + 1); }

let device: Device = makeDevice(...deviceParams(get(activeDeviceId)));

function deviceParams(id: string): [string, string, string] {
  const found = DEVICES.find((item) => item.id === id) ?? DEVICES[0];
  return [found.id, found.name, found.actor];
}

// 首次启动：旧数据没有凭据 → 迁移为基线凭据（字幕、审校记录、快照都保留）
if (browser && !device.migrated) {
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    device.migrateLegacy(legacy);
    localStorage.setItem(LEGACY_BACKUP_KEY, legacy);
    localStorage.removeItem(LEGACY_KEY);
  }
}

export function switchDevice(id: string) {
  if (id === get(activeDeviceId)) return;
  activeDeviceId.set(id);
  if (browser) localStorage.setItem(ACTIVE_DEVICE_KEY, id);
  device = makeDevice(...deviceParams(id));
  if (browser && get(online)) {
    device.sync();
    syncMessage.set(`已切换到 ${device.name} 并同步最新协作状态`);
  }
  const firstCue = device.view().cues.find((c) => c.trackId === get(activeTrackId));
  selectedCueId.set(firstCue?.id ?? "");
  tick();
}

export function setOnline(value: boolean) {
  online.set(value);
  if (browser) localStorage.setItem(NETWORK_KEY, value ? "on" : "off");
  if (value) syncNow();
}

let lastReport: SyncReport | null = null;
export const lastSyncReport = writable<SyncReport | null>(null);
export const syncMessage = writable("");

/** 联网后同步：逐条重放凭据；合并失败等重试场景下轮从未做完的凭据继续 */
export function syncNow(): SyncReport | null {
  if (!browser) return null;
  const report = device.sync();
  lastReport = report;
  lastSyncReport.set(report);
  const parts: string[] = [];
  if (report.pushed) parts.push(`重放 ${report.pushed} 条`);
  if (report.duplicate) parts.push(`跳过重复 ${report.duplicate} 条`);
  if (report.blocked.length) parts.push(`拦截 ${report.blocked.length} 条`);
  if (report.conflict.length) parts.push(`冲突待判 ${report.conflict.length} 条`);
  if (report.retryPending.length) parts.push(`${report.retryPending.length} 条待重试（合并对端未就绪）`);
  syncMessage.set(parts.length ? parts.join("，") : "已是最新");
  tick();
  return report;
}

/* ---------------- 由凭据视图派生的响应式状态 ---------------- */

function view() {
  return device.view();
}

export const tracks = derived(version, () => view().tracks as Track[]);
export const cues = derived(version, () => view().cues as Cue[]);
export const terms = derived(version, () => view().terms as GlossaryTerm[]);
export const reviewEvents = derived(version, () => view().events as ReviewEvent[]);
export const pendingConflicts = derived(version, () => view().conflicts as PendingConflict[]);
export const snapshots = derived(version, () => device.snapshots as Snapshot[]);
export const outbox = derived(version, () => device.pendingCredentials as Credential[]);
export const deviceName = derived(activeDeviceId, () => device.name);
export const deviceActor = derived(version, () => device.actorName);

export const activeTrackId = writable("en");
export const selectedCueId = writable<string>("");
export const reviewer = writable("审校-顾宁");

const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "", rev: 1 },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", rev: 1 },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", rev: 1 },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", rev: 1 }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员" },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
];

/** 全新工作区（无旧数据、Hub 空）时播种一条基线凭据 */
export function ensureSeed() {
  if (!browser) return;
  // 新设备首次进入：先拉取 Hub 已有基线，避免重复播种
  if (get(online) && device.pendingCount === 0) {
    device.sync();
    tick();
  }
  const hubState = hub.snapshot();
  const hasLocal = device.pendingCount > 0 || hubState.cues.length > 0;
  if (hasLocal) {
    if (!get(selectedCueId)) selectedCueId.set(hubState.cues.find((c) => c.trackId === get(activeTrackId))?.id ?? "");
    return;
  }
  device.emit({
    type: "baseline.import",
    tracks: seedTracks,
    cues: seedCues,
    terms: seedTerms,
    events: []
  });
  if (get(online)) syncNow();
  else tick();
  if (!get(selectedCueId)) selectedCueId.set("c2");
}

/* ---------------- 编辑动作：一律先出凭据 ---------------- */

function findCue(id: string): Cue | undefined {
  return device.view().cues.find((cue) => cue.id === id);
}

export function updateCue(id: string, patch: Partial<Pick<Cue, "source" | "translated" | "start" | "end">>) {
  const cue = findCue(id);
  if (!cue) return;
  device.emit({ type: "cue.edit", cueId: id, expectRev: cue.rev, hint: device.hintFor(cue), fields: patch });
  if (get(online)) syncNow();
  tick();
}

export function nudgeCue(id: string, delta: number) {
  const cue = findCue(id);
  if (!cue) return;
  updateCue(id, {
    start: Math.max(0, Number((cue.start + delta).toFixed(1))),
    end: Math.max(cue.start + 0.5, Number((cue.end + delta).toFixed(1)))
  });
}

export function splitCue(id: string) {
  const cue = findCue(id);
  if (!cue || cue.end - cue.start < 1) return;
  device.emit({ type: "cue.split", cueId: id, expectRev: cue.rev, hint: device.hintFor(cue) });
  if (get(online)) syncNow();
  tick();
  // 选中拆分出的后半条
  const created = device.view().cues.filter((item) => item.start >= (cue.start + cue.end) / 2 - 0.01 && item.trackId === cue.trackId).sort((a, b) => b.start - a.start)[0];
  if (created) selectedCueId.set(created.id);
}

export function mergeNext(id: string) {
  const cue = findCue(id);
  if (!cue) return;
  device.emit({ type: "cue.merge", cueId: id, expectRev: cue.rev, hint: device.hintFor(cue) });
  if (get(online)) syncNow();
  tick();
}

export function addCue(input: { trackId: string; source: string; translated: string; start: number; end: number }) {
  const cue: Cue = {
    id: crypto.randomUUID(),
    trackId: input.trackId,
    start: input.start,
    end: input.end,
    source: input.source,
    translated: input.translated,
    status: "翻译中",
    translator: device.actorName,
    reviewerNote: "",
    rev: 1
  };
  device.emit({ type: "cue.add", cue });
  if (get(online)) syncNow();
  tick();
  selectedCueId.set(cue.id);
}

export function setCueStatus(id: string, status: Cue["status"]) {
  const cue = findCue(id);
  if (!cue) return;
  if (status === "已通过") {
    device.emit({ type: "review.approve", cueId: id, expectRev: cue.rev, hint: device.hintFor(cue) });
  } else if (status === "退回") {
    device.emit({ type: "review.reject", cueId: id, expectRev: cue.rev, hint: device.hintFor(cue), note: cue.reviewerNote || "请核对术语和断句" });
  } else {
    device.emit({ type: "cue.status", cueId: id, hint: device.hintFor(cue), status });
  }
  if (get(online)) syncNow();
  tick();
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = findCue(id);
  if (!cue) return;
  device.emit(
    approved
      ? { type: "review.approve", cueId: id, expectRev: cue.rev, hint: device.hintFor(cue) }
      : { type: "review.reject", cueId: id, expectRev: cue.rev, hint: device.hintFor(cue), note: note || "请核对术语和断句" }
  );
  if (get(online)) syncNow();
  tick();
}

export function lockTerm(id: string) {
  device.emit({ type: "term.lock", termId: id });
  if (get(online)) syncNow();
  tick();
}

export function createSnapshot(name?: string) {
  device.createSnapshot(name);
  tick();
}

export function restoreSnapshot(id: string) {
  const snap = device.snapshots.find((item) => item.id === id);
  if (!snap) return;
  // 恢复快照 = 对差异字幕逐条出编辑凭据（保持审计链不断）
  for (const snapCue of snap.cues) {
    const current = findCue(snapCue.id);
    if (current && (current.translated !== snapCue.translated || current.start !== snapCue.start || current.end !== snapCue.end || current.status !== snapCue.status)) {
      device.emit({
        type: "cue.edit",
        cueId: snapCue.id,
        expectRev: current.rev,
        hint: device.hintFor(current),
        fields: { translated: snapCue.translated, start: snapCue.start, end: snapCue.end }
      });
    }
  }
  if (get(online)) syncNow();
  tick();
}

/** 冲突两版待判：人来选择保留当前版本或采用来稿版本 */
export function resolveConflict(conflictId: string, action: "apply-a" | "apply-b") {
  device.emit({ type: "conflict.resolve", conflictId, action });
  if (get(online)) syncNow();
  tick();
}

export function conflictVersionLabel(v: ConflictVersion) {
  return v.label;
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) =>
  $cues
    .filter((cue) => cue.trackId === $activeTrackId)
    .sort((a, b) => a.start - b.start)
    .map((cue) => ({ ...cue, selected: cue.id === $selectedCueId }))
);
