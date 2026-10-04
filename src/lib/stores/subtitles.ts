import { derived, get, writable } from "svelte/store";
import { recordCredential } from "./sync";
import type { OpKind } from "./sync";
import { initialState } from "./persistence";
import { seedCues, seedTerms, seedTracks } from "./seed";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
}

export interface Cue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
}

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: "提交审校" | "审校通过" | "退回修改" | "术语锁定";
  detail: string;
  actor: string;
  time: string;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  cues: Cue[];
}

export const tracks = writable<Track[]>(initialState.tracks);
export const cues = writable<Cue[]>(initialState.cues);
export const terms = writable<GlossaryTerm[]>(initialState.terms);
export const reviewEvents = writable<ReviewEvent[]>(initialState.events);
export const snapshots = writable<Snapshot[]>(initialState.snapshots);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");

function event(cue: Cue | undefined, action: ReviewEvent["action"], detail: string) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor: get(reviewer), time: new Date().toISOString() }, ...items]);
}

// 登记一条凭据：记录改动前字段（base）与改动后字段（payload），用于三路合并
function cred(op: OpKind, targetId: string, payload: Record<string, unknown>, base: Record<string, unknown>, trackId?: string) {
  recordCredential({ op, targetId, payload, base, trackId });
}

export function updateCue(id: string, patch: Partial<Cue>, log = false) {
  const before = get(cues).find((cue) => cue.id === id);
  if (!before) return;
  const base = Object.fromEntries(Object.keys(patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k]]));
  cues.update((items) => items.map((cue) => cue.id === id ? { ...cue, ...patch } : cue));
  cred("cue:update", id, { ...patch }, base, before.trackId);
  if (log) event(get(cues).find((cue) => cue.id === id), "退回修改", "编辑字幕内容或时间码");
}

export function nudgeCue(id: string, delta: number) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  updateCue(id, { start: Math.max(0, Number((cue.start + delta).toFixed(1))), end: Math.max(cue.start + 0.5, Number((cue.end + delta).toFixed(1))) });
}

export function splitCue(id: string) {
  const list = get(cues);
  const cue = list.find((item) => item.id === id);
  if (!cue || cue.end - cue.start < 1) return;
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  const first = { ...cue, end: middle, translated: `${cue.translated}`, status: "翻译中" as CueStatus };
  const second = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译" as CueStatus };
  cues.set(list.flatMap((item) => item.id === id ? [first, second] : [item]));
  selectedCueId.set(second.id);
  cred("cue:split", id, { second, firstEnd: middle }, { end: cue.end }, cue.trackId);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  const mergedTranslated = `${current.translated} ${next.translated}`.trim();
  cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => item.id === id ? { ...item, end: next.end, translated: mergedTranslated, status: "翻译中" } : item));
  cred("cue:merge", id, { removeId: next.id, end: next.end, translated: mergedTranslated }, { end: current.end, translated: current.translated }, current.trackId);
}

export function setCueStatus(id: string, status: CueStatus) {
  const before = get(cues).find((cue) => cue.id === id);
  if (!before) return;
  updateCue(id, { status });
  event(get(cues).find((cue) => cue.id === id), status === "待审" ? "提交审校" : status === "已通过" ? "审校通过" : "退回修改", get(cues).find((cue) => cue.id === id)?.translated ?? "");
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  const newStatus = approved ? "已通过" : "退回";
  cues.update((items) => items.map((item) => item.id === id ? { ...item, status: newStatus, reviewerNote: note } : item));
  cred("review:set", id, { status: newStatus, reviewerNote: note }, { status: cue.status, reviewerNote: cue.reviewerNote }, cue.trackId);
  event(cue, approved ? "审校通过" : "退回修改", note || cue.translated);
}

export function lockTerm(id: string) {
  const before = get(terms).find((term) => term.id === id);
  if (!before) return;
  terms.update((items) => items.map((term) => term.id === id ? { ...term, status: "已锁定", owner: "术语管理员" } : term));
  cred("term:lock", id, { status: "已锁定" }, { status: before.status });
  const term = get(terms).find((item) => item.id === id);
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  event(cue, "术语锁定", `${term?.source} → ${term?.target}`);
}

export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
  snapshots.update((items) => [{ id: crypto.randomUUID(), name, time: new Date().toISOString(), cues: structuredClone(get(cues)) }, ...items].slice(0, 12));
}

export function restoreSnapshot(id: string) {
  const snapshot = get(snapshots).find((item) => item.id === id);
  if (snapshot) cues.set(structuredClone(snapshot.cues));
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) => $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId })));

// 重新导出种子，供需要重置/演示的地方使用
export { seedCues, seedTerms, seedTracks };
