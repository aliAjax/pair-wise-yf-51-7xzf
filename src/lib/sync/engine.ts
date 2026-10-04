// 凭据重放引擎：纯函数，不持久化、不依赖 DOM。
// Hub 重放与本机草稿预演共用同一份逻辑（draft 模式不做保护拦截）。
import type {
  ApplyOutcome,
  ConflictVersion,
  Credential,
  CredentialOp,
  Cue,
  EditFields,
  PendingConflict,
  ReviewAction,
  ReviewEvent,
  SyncState,
  TimeHint,
  Tombstone
} from "./types";

export interface ApplyOptions {
  /** 本机草稿模式：保护规则放宽（锁定术语/已通过仍允许本地编辑），冲突只在 Hub 产生 */
  draft?: boolean;
}

export function emptyState(): SyncState {
  return { revision: 0, tracks: [], cues: [], terms: [], events: [], conflicts: [], tombstones: [] };
}

export function bumpRev(state: SyncState): number {
  state.revision += 1;
  return state.revision;
}

function addEvent(state: SyncState, cred: Credential, action: ReviewAction, cueId: string, detail: string) {
  // 由凭据派生事件 id，重复重放只产生一条
  const id = `ev:${cred.id}`;
  if (state.events.some((item) => item.id === id)) return;
  state.events.unshift({ id, cueId, action, detail, actor: cred.actor, time: cred.time, credentialId: cred.id });
}

/* ---------------- 目标字幕定位 ---------------- */

function cueById(state: SyncState, id: string): Cue | undefined {
  return state.cues.find((cue) => cue.id === id);
}

/** 时间区间距离（中点优先，重叠距离为 0） */
function timeDistance(hint: TimeHint, start: number, end: number): number {
  const overlap = Math.min(hint.end, end) - Math.max(hint.start, start);
  if (overlap > 0) return 0;
  const mid = (hint.start + hint.end) / 2;
  return Math.min(Math.abs(hint.start - end), Math.abs(hint.end - start), Math.abs(mid - (start + end) / 2));
}

/** 重叠时长（多个候选都重叠时优先重叠最长、开始最早者） */
function overlapLen(hint: TimeHint, start: number, end: number): number {
  return Math.max(0, Math.min(hint.end, end) - Math.max(hint.start, start));
}

const FIND_TOLERANCE = 2.5;

/** 候选打分：距离越小越好，同距看重叠长度，再同看开始时间 */
function betterMatch(current: { score: number; overlap: number; start: number } | undefined, score: number, overlap: number, start: number): boolean {
  if (!current) return true;
  return score < current.score || (score === current.score && overlap > current.overlap) || (score === current.score && overlap === current.overlap && start < current.start);
}

/** 在存活字幕里找时间最接近的同轨条目（对方拆分/合并导致 id 变化时按时间找回） */
function findLiveByTime(state: SyncState, hint: TimeHint, excludeId?: string): Cue | undefined {
  let best: Cue | undefined;
  let bestScore = Infinity;
  let bestOverlap = -1;
  for (const cue of state.cues) {
    if (cue.trackId !== hint.trackId || (excludeId && cue.id === excludeId)) continue;
    const score = timeDistance(hint, cue.start, cue.end);
    if (score > FIND_TOLERANCE) continue;
    const overlap = overlapLen(hint, cue.start, cue.end);
    if (betterMatch(best ? { score: bestScore, overlap: bestOverlap, start: best.start } : undefined, score, overlap, cue.start)) {
      best = cue;
      bestScore = score;
      bestOverlap = overlap;
    }
  }
  return best;
}

function findTombstone(state: SyncState, hint: TimeHint): Tombstone | undefined {
  let best: Tombstone | undefined;
  let bestScore = Infinity;
  let bestOverlap = -1;
  for (const stone of state.tombstones) {
    if (stone.trackId !== hint.trackId) continue;
    const score = timeDistance(hint, stone.start, stone.end);
    if (score > FIND_TOLERANCE) continue;
    const overlap = overlapLen(hint, stone.start, stone.end);
    if (betterMatch(best ? { score: bestScore, overlap: bestOverlap, start: best.start } : undefined, score, overlap, stone.start)) {
      best = stone;
      bestScore = score;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** 同轨、按开始时间排在锚点之后、且与锚点相接或最近的存活字幕（合并目标） */
function findNextLive(state: SyncState, anchor: Cue): Cue | undefined {
  const sameTrack = state.cues
    .filter((cue) => cue.trackId === anchor.trackId && cue.id !== anchor.id && cue.start >= anchor.start)
    .sort((a, b) => a.start - b.start);
  return sameTrack[0];
}

/**
 * 定位凭据的目标字幕。
 * 返回 found / not-found（可稍后重试）/ restored（从墓碑找回）。
 */
type Located =
  | { kind: "found"; cue: Cue; retargeted: boolean }
  | { kind: "restored"; cue: Cue; tombstone: Tombstone; retargeted: boolean }
  | { kind: "missing" };

function locateCue(state: SyncState, cueId: string, hint: TimeHint): Located {
  const live = cueById(state, cueId);
  if (live) return { kind: "found", cue: live, retargeted: false };
  const byTime = findLiveByTime(state, hint, cueId);
  if (byTime) return { kind: "found", cue: byTime, retargeted: true };
  const stone = findTombstone(state, hint);
  if (stone) return { kind: "restored", cue: structuredClone(stone.cue), tombstone: stone, retargeted: false };
  return { kind: "missing" };
}

/** 从墓碑恢复：重新放回字幕表，标记结构冲突（要求人工确认） */
function restoreFromTombstone(state: SyncState, cred: Credential, located: { cue: Cue; tombstone: Tombstone }, opName: string): Cue {
  const restored = { ...located.cue, rev: located.cue.rev + 1 };
  state.cues.push(restored);
  state.tombstones = state.tombstones.filter((stone) => stone.id !== located.tombstone.id);
  addEvent(state, cred, "拆分字幕", restored.id, `${opName}：目标已被合并，按时间找回「${restored.id}」待确认`);
  return restored;
}

/* ---------------- 冲突构造 ---------------- */

function conflictId(cred: Credential): string {
  return `conflict:${cred.id}`;
}

function buildConflict(
  state: SyncState,
  cred: Credential,
  kind: PendingConflict["kind"],
  message: string,
  cueId: string,
  hint: TimeHint,
  currentCue: Cue,
  incomingCue: Cue
): PendingConflict {
  const versions: ConflictVersion[] = [
    { label: kind === "protected-edit" ? "已锁定/已通过版本" : "协作版本", actor: state.events.find((e) => e.cueId === cueId)?.actor ?? "协作者", cue: currentCue },
    { label: "来稿版本", actor: cred.actor, cue: incomingCue }
  ];
  return {
    id: conflictId(cred),
    kind,
    trackId: hint.trackId,
    cueId,
    message,
    fromCredentialId: cred.id,
    fromDeviceId: cred.deviceId,
    versions,
    op: cred.op,
    time: cred.time,
    status: "待判"
  };
}

function fileConflict(state: SyncState, cred: Credential, conflict: PendingConflict): ApplyOutcome {
  const idx = state.conflicts.findIndex((item) => item.id === conflict.id);
  if (idx >= 0) state.conflicts[idx] = conflict;
  else state.conflicts.unshift(conflict);
  addEvent(state, cred, "冲突待判", conflict.cueId, conflict.message);
  return { outcome: "conflict", conflict };
}

/* ---------------- 各操作重放 ---------------- */

function applyEditFields(cue: Cue, fields: EditFields): Cue {
  return { ...cue, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), rev: cue.rev };
}

function protectedField(fields: EditFields): keyof EditFields | undefined {
  if (fields.source !== undefined || fields.translated !== undefined) return "translated";
  return undefined;
}

function applyCueEdit(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "cue.edit" }>, draft: boolean): ApplyOutcome {
  const located = locateCue(state, op.cueId, op.hint);
  if (located.kind === "missing") return { outcome: "retry", reason: "目标字幕暂不存在，等待后续凭据恢复" };
  let target = located.kind === "restored" ? restoreFromTombstone(state, cred, located, "编辑") : located.cue;

  const incoming = { ...applyEditFields(target, op.fields), rev: target.rev };
  if (!draft) {
    // 已通过的审校结论不能被重放盖掉
    if (target.status === "已通过" && protectedField(op.fields)) {
      return fileConflict(
        state, cred,
        buildConflict(state, cred, "protected-edit", "该字幕已审校通过，来稿译文不能直接覆盖", target.id, op.hint, target, incoming),
      );
    }
    // 两边都改过（同一条字幕乐观锁版本不一致）→ 留两版待判。
    // 按时间找回的目标是拆分/合并后产生的新片段，不是同一条记录，跳过 rev 比对。
    if (!located.retargeted && target.rev !== op.expectRev) {
      return fileConflict(
        state, cred,
        buildConflict(state, cred, "divergent-edit", `同一条字幕两边都改过（当前 rev ${target.rev}，来稿基于 rev ${op.expectRev}）`, target.id, op.hint, target, incoming),
      );
    }
  }
  target = { ...target, ...incoming, rev: target.rev + 1 };
  state.cues = state.cues.map((cue) => (cue.id === target.id ? target : cue));
  addEvent(state, cred, "编辑字幕", target.id, located.retargeted ? "目标已被拆分/合并，按时间找回后重放改动" : "重放字幕内容/时间码改动");
  return { outcome: "applied" };
}

function childIds(credId: string): { first: string; second: string } {
  return { first: `split:${credId}:a`, second: `split:${credId}:b` };
}

function applySplit(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "cue.split" }>, draft: boolean): ApplyOutcome {
  const located = locateCue(state, op.cueId, op.hint);
  if (located.kind === "missing") return { outcome: "retry", reason: "待拆分字幕暂不存在" };
  if (located.kind === "restored") restoreFromTombstone(state, cred, located, "拆分");

  // 幂等：凭据重跑时两个子条都已存在
  const ids = childIds(cred.id);
  if (state.cues.some((cue) => cue.id === ids.first) && state.cues.some((cue) => cue.id === ids.second)) {
    return { outcome: "applied", noop: true };
  }
  const cue = cueById(state, located.cue.id)!;
  if (cue.end - cue.start < 1) {
    addEvent(state, cred, "重放拦截", cue.id, "拆分被拦截：字幕短于 1 秒");
    return { outcome: "blocked", reason: "字幕短于 1 秒，不能拆分" };
  }
  if (!draft && cue.status === "已通过") {
    const incoming: Cue = { ...cue, status: "翻译中" };
    return fileConflict(
      state, cred,
      buildConflict(state, cred, "protected-edit", "已通过字幕被拆分，需要人工确认", cue.id, op.hint, cue, incoming),
    );
  }
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  const first: Cue = { ...cue, id: ids.first, end: middle, status: "翻译中", rev: cue.rev + 1 };
  const second: Cue = {
    ...cue,
    id: ids.second,
    start: middle,
    source: op.secondSource ?? cue.source,
    translated: op.secondText ?? "",
    status: "待译",
    reviewerNote: "",
    rev: cue.rev + 1
  };
  state.cues = state.cues.flatMap((item) => (item.id === cue.id ? [first, second] : item));
  addEvent(state, cred, "拆分字幕", cue.id, `在 ${middle}s 处拆分为两条`);
  return { outcome: "applied" };
}

function applyMerge(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "cue.merge" }>, draft: boolean): ApplyOutcome {
  const located = locateCue(state, op.cueId, op.hint);
  if (located.kind === "missing") return { outcome: "retry", reason: "合并起点字幕暂不存在" };
  if (located.kind === "restored") restoreFromTombstone(state, cred, located, "合并");
  const anchor = cueById(state, located.cue.id)!;
  const next = findNextLive(state, anchor);
  if (!next) {
    // 合并对端还没到（可能是更早的凭据尚未重放）→ 从这个凭据开始稍后重试
    return { outcome: "retry", reason: "合并对端字幕尚未就绪" };
  }
  const approved = anchor.status === "已通过" || next.status === "已通过";
  if (!draft && approved) {
    const incoming: Cue = { ...anchor, end: next.end, translated: `${anchor.translated} ${next.translated}`.trim() };
    return fileConflict(
      state, cred,
      buildConflict(state, cred, "protected-merge", "合并涉及已通过字幕，需要人工确认", anchor.id, op.hint, anchor, incoming),
    );
  }
  const merged: Cue = {
    ...anchor,
    end: next.end,
    source: `${anchor.source} ${next.source}`.trim(),
    translated: `${anchor.translated} ${next.translated}`.trim(),
    status: "翻译中",
    rev: anchor.rev + 1
  };
  state.cues = state.cues.filter((cue) => cue.id !== next.id).map((cue) => (cue.id === anchor.id ? merged : cue));
  state.tombstones.push({ id: next.id, trackId: next.trackId, start: next.start, end: next.end, cue: structuredClone(next), time: cred.time });
  addEvent(state, cred, "合并字幕", anchor.id, `与后续字幕合并（${next.start}s–${next.end}s）`);
  return { outcome: "applied" };
}

function applyStatus(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "cue.status" }>): ApplyOutcome {
  const located = locateCue(state, op.cueId, op.hint);
  if (located.kind === "missing") return { outcome: "retry", reason: "目标字幕暂不存在" };
  if (located.kind === "restored") restoreFromTombstone(state, cred, located, "状态更新");
  const cue = cueById(state, located.cue.id)!;
  if (cue.status === op.status) return { outcome: "applied", noop: true };
  state.cues = state.cues.map((item) => (item.id === cue.id ? { ...item, status: op.status, rev: cue.rev + 1 } : item));
  addEvent(state, cred, "提交审校", cue.id, `状态更新为「${op.status}」`);
  return { outcome: "applied" };
}

function applyReview(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "review.approve" }> | Extract<CredentialOp, { type: "review.reject" }>): ApplyOutcome {
  const approved = op.type === "review.approve";
  const note = approved ? "" : op.note;
  const located = locateCue(state, op.cueId, op.hint);
  if (located.kind === "missing") return { outcome: "retry", reason: "审校目标字幕暂不存在" };
  if (located.kind === "restored") restoreFromTombstone(state, cred, located, "审校");
  const cue = cueById(state, located.cue.id)!;
  if (!approved && cue.rev !== op.expectRev) {
    // 审校退回与译者编辑并发 → 两版待判
    const incoming = { ...cue, status: "退回" as const, reviewerNote: note };
    return fileConflict(
      state, cred,
      buildConflict(state, cred, "divergent-edit", "审校退回时字幕已被译者继续修改，两版待判", cue.id, op.hint, cue, incoming),
    );
  }
  const patch: Partial<Cue> = approved
    ? { status: "已通过", reviewerNote: cue.reviewerNote }
    : { status: "退回", reviewerNote: note };
  state.cues = state.cues.map((item) => (item.id === cue.id ? { ...item, ...patch, rev: cue.rev + 1 } : item));
  addEvent(state, cred, approved ? "审校通过" : "退回修改", cue.id, approved ? "审校通过" : note || "审校退回");
  return { outcome: "applied" };
}

function applyTermLock(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "term.lock" }>): ApplyOutcome {
  const term = state.terms.find((item) => item.id === op.termId);
  if (!term) return { outcome: "blocked", reason: "术语不存在" };
  if (term.status === "已锁定") return { outcome: "applied", noop: true };
  state.terms = state.terms.map((item) => (item.id === op.termId ? { ...item, status: "已锁定", owner: cred.actor } : item));
  addEvent(state, cred, "术语锁定", "", `${term.source} → ${term.target}`);
  return { outcome: "applied" };
}

function applyTermEdit(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "term.edit" }>, draft: boolean): ApplyOutcome {
  const term = state.terms.find((item) => item.id === op.termId);
  if (!term) return { outcome: "blocked", reason: "术语不存在" };
  // 锁定术语不能被重放盖掉
  if (!draft && term.status === "已锁定") {
    addEvent(state, cred, "重放拦截", "", `术语「${term.source}」已锁定，编辑被拦截`);
    return { outcome: "blocked", reason: `术语「${term.source}」已锁定，普通编辑不能覆盖` };
  }
  state.terms = state.terms.map((item) =>
    item.id === op.termId ? { ...item, ...(op.target !== undefined ? { target: op.target } : {}), ...(op.status ? { status: op.status } : {}) } : item
  );
  addEvent(state, cred, "编辑字幕", "", `编辑术语「${term.source}」`);
  return { outcome: "applied" };
}

function applyCueAdd(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "cue.add" }>): ApplyOutcome {
  if (state.cues.some((cue) => cue.id === op.cue.id)) return { outcome: "applied", noop: true };
  state.cues.push({ ...op.cue, rev: op.cue.rev ?? 1 });
  addEvent(state, cred, "编辑字幕", op.cue.id, "新增字幕");
  return { outcome: "applied" };
}

function applyBaselineImport(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "baseline.import" }>): ApplyOutcome {
  // 旧数据没有凭据：升级时由首个设备作为基线导入，幂等且不覆盖此后的新改动
  for (const track of op.tracks) {
    if (!state.tracks.some((item) => item.id === track.id)) state.tracks.push(track);
  }
  for (const cue of op.cues) {
    if (!state.cues.some((item) => item.id === cue.id)) state.cues.push({ ...cue, rev: Math.max(cue.rev ?? 0, 1) });
  }
  for (const term of op.terms) {
    if (!state.terms.find((item) => item.id === term.id)) state.terms.push(term);
  }
  for (const evt of op.events) {
    if (!state.events.some((item) => item.id === evt.id)) state.events.push({ ...evt, legacy: true });
  }
  bumpRev(state);
  return { outcome: "applied" };
}

/** 冲突裁定凭据：把来稿版本带 force 重新落地（或确认保留现状） */
function applyConflictResolve(state: SyncState, cred: Credential, op: Extract<CredentialOp, { type: "conflict.resolve" }>): ApplyOutcome {
  const conflict = state.conflicts.find((item) => item.id === op.conflictId);
  if (!conflict) return { outcome: "retry", reason: "冲突尚未同步到本机视图" };
  if (op.action === "apply-b") {
    const winner = conflict.versions[1]?.cue;
    if (!winner) return { outcome: "blocked", reason: "来稿版本缺失" };
    const existing = state.cues.find((cue) => cue.id === winner.id);
    if (existing) state.cues = state.cues.map((cue) => (cue.id === winner.id ? { ...winner, rev: winner.rev + 1 } : cue));
    else state.cues.push({ ...winner, rev: winner.rev + 1 });
  }
  state.conflicts = state.conflicts.filter((item) => item.id !== conflict.id);
  addEvent(state, cred, "冲突裁定", conflict.cueId, `${op.action === "apply-b" ? "采用来稿版本" : "保留当前版本"}：${conflict.message}`);
  return { outcome: "applied" };
}

/** 在一份可变 state 上重放一条凭据 */
export function applyCredential(state: SyncState, cred: Credential, options: ApplyOptions = {}): ApplyOutcome {
  const draft = !!options.draft;
  const op = cred.op;
  switch (op.type) {
    case "baseline.import": return applyBaselineImport(state, cred, op);
    case "cue.add": return applyCueAdd(state, cred, op);
    case "cue.edit": return applyCueEdit(state, cred, op, draft);
    case "cue.split": return applySplit(state, cred, op, draft);
    case "cue.merge": return applyMerge(state, cred, op, draft);
    case "cue.status": return applyStatus(state, cred, op);
    case "review.approve": return applyReview(state, cred, op);
    case "review.reject": return applyReview(state, cred, op);
    case "term.lock": return applyTermLock(state, cred, op);
    case "term.edit": return applyTermEdit(state, cred, op, draft);
    case "conflict.resolve": return applyConflictResolve(state, cred, op);
  }
}

/** 在 state 的副本上依次重放多条凭据（草稿视图构建用） */
export function replayInto(base: SyncState, creds: Credential[], options: ApplyOptions = {}): SyncState {
  const draft = structuredClone(base);
  for (const cred of creds) applyCredential(draft, cred, options);
  draft.cues.sort((a, b) => (a.trackId === b.trackId ? a.start - b.start || a.end - b.end : a.trackId.localeCompare(b.trackId)));
  return draft;
}
