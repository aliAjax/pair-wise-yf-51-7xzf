import { browser } from "$app/environment";
import type { Cue, GlossaryTerm, ReviewEvent, Snapshot, Track } from "./subtitles";
import { seedCues, seedTerms, seedTracks } from "./seed";

// 状态初始化、旧数据迁移与共享类型独立成模块，避免 sync 与 subtitles 循环依赖。
// 旧数据没有凭据，升级后作为共同基线保留，字幕与审校记录不丢。

export const LEGACY_KEY = "pair-wise-yf-51/subtitles-v1";
export const KEY = "pair-wise-yf-51/subtitles-v2";
export const DEVICE_KEY = "pair-wise-yf-51/device-id";

export type OpKind =
  | "cue:add"
  | "cue:update"
  | "cue:remove"
  | "cue:split"
  | "cue:merge"
  | "term:lock"
  | "review:set";

export type CredentialState = "pending" | "applied" | "conflict" | "skipped";

export interface Credential {
  id: string;
  deviceId: string;
  seq: number;
  op: OpKind;
  trackId?: string;
  targetId: string;
  payload: Record<string, unknown>;
  base: Record<string, unknown>;
  createdAt: string;
  state: CredentialState;
  attempts: number;
  lastError?: string;
  appliedAt?: string;
  retargetedFrom?: string;
}

export interface SyncConflict {
  id: string;
  credentialId: string;
  deviceId: string;
  seq: number;
  op: OpKind;
  cueId: string;
  trackId: string;
  field: string;
  message: string;
  localValue: unknown;
  remoteValue: unknown;
  status: "待处理" | "采用本机" | "采用协作版本";
  createdAt: string;
}

export interface PersistedV2 {
  version: 2;
  deviceId: string;
  seq: number;
  cues: Cue[];
  terms: GlossaryTerm[];
  events: ReviewEvent[];
  snapshots: Snapshot[];
  tracks: Track[];
  outbox: Credential[];
  remoteCues: Cue[];
  remoteTerms: GlossaryTerm[];
  remoteEvents: ReviewEvent[];
  remoteCredentials: Credential[];
  appliedCredentialIds: string[];
  conflicts: SyncConflict[];
}

function createDeviceId(): string {
  if (!browser) return "server";
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const id = `dev-${crypto.randomUUID().slice(0, 8)}`;
  localStorage.setItem(DEVICE_KEY, id);
  return id;
}

function fallback(): PersistedV2 {
  return {
    version: 2,
    deviceId: createDeviceId(),
    seq: 0,
    cues: seedCues,
    terms: seedTerms,
    events: [],
    snapshots: [],
    tracks: seedTracks,
    outbox: [],
    remoteCues: structuredClone(seedCues),
    remoteTerms: structuredClone(seedTerms),
    remoteEvents: [],
    remoteCredentials: [],
    appliedCredentialIds: [],
    conflicts: []
  };
}

export function loadState(): PersistedV2 {
  const base = fallback();
  if (!browser) return base;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<PersistedV2>) };
  } catch {
    /* 损坏则尝试迁移 */
  }
  // 从 v1 迁移：旧数据无凭据，整体作为基线，不进凭据台账
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const d = JSON.parse(legacyRaw) as Partial<PersistedV2>;
      const cues = d.cues ?? seedCues;
      const terms = d.terms ?? seedTerms;
      const events = d.events ?? [];
      return {
        ...base,
        cues,
        terms,
        events,
        snapshots: d.snapshots ?? [],
        tracks: d.tracks ?? seedTracks,
        remoteCues: structuredClone(cues),
        remoteTerms: structuredClone(terms),
        remoteEvents: structuredClone(events)
      };
    }
  } catch {
    /* 忽略损坏的旧数据 */
  }
  return base;
}

export const initialState = loadState();
