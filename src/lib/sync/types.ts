// 离线同步内核：类型定义
// 凭据(Credential) = 设备上按序产生的一条改动，联网后逐条重放到 Hub。

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
  /** 该字幕最后一次被 Hub 采纳的修订号；乐观锁依据 */
  rev: number;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
}

export type ReviewAction =
  | "提交审校"
  | "审校通过"
  | "退回修改"
  | "术语锁定"
  | "编辑字幕"
  | "拆分字幕"
  | "合并字幕"
  | "冲突待判"
  | "冲突裁定"
  | "重放拦截";

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: ReviewAction;
  detail: string;
  actor: string;
  time: string;
  /** 产生该记录的凭据；旧数据迁移来的记录没有凭据 */
  credentialId?: string;
  legacy?: boolean;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  cues: Cue[];
}

/** 时间锚点：目标字幕可能已被对方拆分/合并而换 id，按时间找回 */
export interface TimeHint {
  trackId: string;
  start: number;
  end: number;
}

export interface EditFields {
  source?: string;
  translated?: string;
  start?: number;
  end?: number;
}

/** 凭据携带的操作 */
export type CredentialOp =
  | { type: "baseline.import"; cues: Cue[]; terms: GlossaryTerm[]; tracks: Track[]; events: ReviewEvent[] }
  | { type: "cue.add"; cue: Cue }
  | { type: "cue.edit"; cueId: string; expectRev: number; hint: TimeHint; fields: EditFields }
  | { type: "cue.split"; cueId: string; expectRev: number; hint: TimeHint; secondSource?: string; secondText?: string }
  | { type: "cue.merge"; cueId: string; expectRev: number; hint: TimeHint }
  | { type: "cue.status"; cueId: string; hint: TimeHint; status: CueStatus }
  | { type: "review.approve"; cueId: string; expectRev: number; hint: TimeHint }
  | { type: "review.reject"; cueId: string; expectRev: number; hint: TimeHint; note: string }
  | { type: "term.lock"; termId: string }
  | { type: "term.edit"; termId: string; target?: string; status?: TermStatus }
  | { type: "conflict.resolve"; conflictId: string; action: ResolveAction };

/** 冲突裁定动作：apply-a 保留 Hub 现状版本，apply-b 强制落地来稿版本 */
export type ResolveAction = "apply-a" | "apply-b";

export interface Credential {
  /** 全局唯一凭据号 */
  id: string;
  deviceId: string;
  /** 设备内单调递增序号，重放严格按此顺序 */
  seq: number;
  actor: string;
  time: string;
  op: CredentialOp;
}

export type ConflictKind = "divergent-edit" | "protected-edit" | "protected-merge" | "structural-restore";

export interface ConflictVersion {
  label: string;
  actor: string;
  cue: Cue;
}

export interface PendingConflict {
  /** 由凭据派生，重放/重复回传天然幂等 */
  id: string;
  kind: ConflictKind;
  trackId: string;
  cueId: string;
  message: string;
  fromCredentialId: string;
  fromDeviceId: string;
  /** 两版待判：[0]=Hub/协作者版本，[1]=来稿草稿版本 */
  versions: ConflictVersion[];
  /** 触发冲突的原始操作，裁定 apply-b 时带 force 重放 */
  op: CredentialOp;
  time: string;
  status: "待判";
}

/** 已被合并删除的字幕墓碑，供“按时间找回” */
export interface Tombstone {
  id: string;
  trackId: string;
  start: number;
  end: number;
  cue: Cue;
  time: string;
}

export interface SyncState {
  revision: number;
  tracks: Track[];
  cues: Cue[];
  terms: GlossaryTerm[];
  events: ReviewEvent[];
  conflicts: PendingConflict[];
  tombstones: Tombstone[];
}

export type ApplyOutcome =
  | { outcome: "applied"; noop?: boolean }
  | { outcome: "conflict"; conflict: PendingConflict }
  | { outcome: "blocked"; reason: string }
  | { outcome: "retry"; reason: string };

/** 凭据在 Hub 上的终态回执 */
export interface JournalEntry {
  id: string;
  deviceId: string;
  seq: number;
  result: "applied" | "conflict" | "blocked";
  reason?: string;
  time: string;
}

export interface PullResponse {
  state: SyncState;
  journal: JournalEntry[];
}
