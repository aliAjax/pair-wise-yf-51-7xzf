// 同步内核端到端测试（node --test）。覆盖：
// 1) 每台设备改动按序留凭据、联网逐条重放
// 2) 目标字幕不在 → 按时间找回
// 3) 凭据重复回传只算一次
// 4) 锁定术语 / 已通过审校结论不被重放盖掉
// 5) 两边都改过 → 两版待判
// 6) 合并失败后从没做完的凭据接着重试
// 7) 旧数据无凭据迁移，字幕和审校记录不丢，升级后可继续编辑
import assert from "node:assert/strict";
import { test } from "node:test";
import { Device, type StorageLike, LEGACY_KEY } from "../src/lib/sync/device";
import { Hub } from "../src/lib/sync/hub";
import type { Cue, GlossaryTerm, ReviewEvent, Track } from "../src/lib/sync/types";

class MemStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  dump() { return [...this.map.keys()]; }
}

// 所有“设备”共用 Hub storage（模拟云端），各自有独立 storage（模拟本机）
function setup() {
  const hubStorage = new MemStorage();
  const makeHub = () => new Hub(hubStorage);
  return {
    hubStorage,
    deviceAStorage: new MemStorage(),
    deviceBStorage: new MemStorage(),
    makeDeviceA: () => new Device(new MemStorage(), "devA", "林岚的电脑", makeHub(), "林岚"),
    makeDeviceB: () => new Device(new MemStorage(), "devB", "周野的电脑", makeHub(), "周野"),
    // 需要多次 sync 看到同一个 Hub 时，用固定 storage 反复 new Hub（Hub 无内存缓存）
    newHub: makeHub
  };
}

const tracks: Track[] = [{ id: "en", name: "English", locale: "en", status: "草稿" }];
function cue(id: string, patch: Partial<Cue> = {}): Cue {
  return {
    id, trackId: "en", start: 0, end: 2.8,
    source: "原文", translated: "old", status: "翻译中",
    translator: "林岚", reviewerNote: "", rev: 1, ...patch
  };
}
const terms: GlossaryTerm[] = [{ id: "g1", source: "潮汐", target: "tide", status: "建议", owner: "林岚" }];

function seedBaseline(device: Device, cues: Cue[], extra: { terms?: GlossaryTerm[]; events?: ReviewEvent[] } = {}) {
  device.emit({ type: "baseline.import", tracks, cues, terms: extra.terms ?? terms, events: extra.events ?? [] });
  return device.sync();
}

test("1. 离线改动按序生成凭据，联网后逐条重放", () => {
  const { newHub, makeDeviceA } = setup();
  const A = makeDeviceA();
  seedBaseline(A, [cue("c1")]);

  // 模拟断网：连续两条改动，先进入发件箱
  const c1 = A.view().cues.find((c) => c.id === "c1")!;
  A.emit({ type: "cue.edit", cueId: "c1", expectRev: 1, hint: A.hintFor(c1), fields: { translated: "first edit" } });
  A.emit({ type: "term.lock", termId: "g1" });
  assert.equal(A.pendingCount, 2, "基线已确认，2 条改动待回传");

  const report = A.sync();
  assert.equal(report.pushed, 2);
  assert.equal(A.pendingCount, 0);

  const hub = newHub().snapshot();
  assert.equal(hub.cues.find((c) => c.id === "c1")?.translated, "first edit");
  assert.equal(hub.terms.find((t) => t.id === "g1")?.status, "已锁定");
  // 审校痕迹按凭据保留
  assert.ok(hub.events.some((e) => e.action === "术语锁定" && e.credentialId));
});

test("2. 目标字幕被对方拆分换了 id，仍按时间找回并重放到正确片段", () => {
  const { makeDeviceA, makeDeviceB, newHub } = setup();
  const A = makeDeviceA();
  seedBaseline(A, [cue("c1", { start: 0, end: 4 })]);

  // B 先在基线处“离线”（两边都只有整条 c1，0–4）
  const B = makeDeviceB();
  B.sync();
  const bc1 = B.view().cues.find((c) => c.id === "c1")!;
  assert.ok(bc1, "B 离线时基线里有 c1");

  // A 回网后拆分 c1（B 对此不知情，其凭据仍指向旧 id）
  const c1 = A.view().cues.find((c) => c.id === "c1")!;
  A.emit({ type: "cue.split", cueId: "c1", expectRev: 1, hint: A.hintFor(c1) });
  assert.equal(A.sync().pushed, 1);

  // B 离线改译文，回网重放：c1 已不在，按时间找回
  B.emit({ type: "cue.edit", cueId: "c1", expectRev: 1, hint: B.hintFor(bc1), fields: { translated: "B 的精修译文" } });
  const report = B.sync();
  assert.equal(report.pushed, 1);

  const hub = newHub().snapshot();
  // c1 已不存在；按时间 (0–4) 找回，改文落在时间重叠的拆分片段上
  assert.equal(hub.cues.find((c) => c.id === "c1"), undefined);
  assert.ok(
    hub.cues.some((c) => c.translated === "B 的精修译文" && c.start >= 0 && c.end <= 4),
    "按时间找回后译文应落在拆分片段"
  );
});

test("3. 凭据重复回传只算一次（Hub 去重 + 出箱）", () => {
  const { makeDeviceA, newHub } = setup();
  const A = makeDeviceA();
  seedBaseline(A, [cue("c1")]);
  const c1 = A.view().cues.find((c) => c.id === "c1")!;
  const cred = A.emit({ type: "cue.edit", cueId: "c1", expectRev: 1, hint: A.hintFor(c1), fields: { translated: "x" } });

  assert.equal(A.sync().pushed, 1);
  // 同一凭据对象直接再推 Hub：duplicate，不产生第二条审校记录
  const again = newHub().push(cred);
  assert.equal(again.result, "duplicate");
  const hub = newHub().snapshot();
  assert.equal(hub.events.filter((e) => e.credentialId === cred.id).length, 1);
  // 设备端再同步（journal 里已有）：计重复且发件箱已空
  assert.equal(A.sync().duplicate, 0);
  assert.equal(A.pendingCount, 0);
});

test("4a. 锁定的术语不能被重放盖掉，拦截留痕", () => {
  const { makeDeviceA, makeDeviceB } = setup();
  const A = makeDeviceA();
  seedBaseline(A, [cue("c1")]);
  A.emit({ type: "term.lock", termId: "g1" });
  A.sync();

  const B = makeDeviceB();
  B.sync();
  B.emit({ type: "term.edit", termId: "g1", target: "HACKED" });
  const report = B.sync();
  assert.equal(report.blocked.length, 1);
  const term = B.view().terms.find((t) => t.id === "g1")!;
  assert.equal(term.target, "tide", "锁定译文保持不变");
  assert.ok(B.view().events.some((e) => e.action === "重放拦截"));
});

test("4b. 已通过的审校结论不能被重放盖掉，转为两版待判", () => {
  const { makeDeviceA, makeDeviceB } = setup();
  const A = makeDeviceA();
  seedBaseline(A, [cue("c1")]);
  const c1a = A.view().cues.find((c) => c.id === "c1")!;
  A.emit({ type: "review.approve", cueId: "c1", expectRev: 1, hint: A.hintFor(c1a) });
  A.sync();

  const B = makeDeviceB();
  B.sync();
  const c1b = B.view().cues.find((c) => c.id === "c1")!;
  B.emit({ type: "cue.edit", cueId: "c1", expectRev: 1, hint: B.hintFor(c1b), fields: { translated: "未经复审的改文" } });
  const report = B.sync();
  assert.equal(report.conflict.length, 1);

  const view = B.view();
  assert.equal(view.cues.find((c) => c.id === "c1")?.status, "已通过", "已通过结论保留");
  assert.equal(view.conflicts.length, 1);
  // 冲突里两版都在，等人判
  const conflict = view.conflicts[0];
  assert.equal(conflict.versions.length, 2);
  assert.ok(conflict.versions[1].cue.translated === "未经复审的改文");
});

test("5. 两边都改过同一条字幕 → 留两版待判，裁定后可收敛", () => {
  const { makeDeviceA, makeDeviceB } = setup();
  const A = makeDeviceA();
  seedBaseline(A, [cue("c1")]);

  const B = makeDeviceB();
  B.sync();

  const aCue = A.view().cues.find((c) => c.id === "c1")!;
  const bCue = B.view().cues.find((c) => c.id === "c1")!;
  A.emit({ type: "cue.edit", cueId: "c1", expectRev: 1, hint: A.hintFor(aCue), fields: { translated: "A 版" } });
  B.emit({ type: "cue.edit", cueId: "c1", expectRev: 1, hint: B.hintFor(bCue), fields: { translated: "B 版" } });

  assert.equal(A.sync().pushed, 1);
  const reportB = B.sync();
  assert.equal(reportB.conflict.length, 1);

  const stateAfter = A.sync(), _ = stateAfter;
  A.sync(); // 拉到 B 的冲突
  let viewA = A.view();
  assert.equal(viewA.conflicts.length, 1);
  const conflictId = viewA.conflicts[0].id;

  // A 裁定：采用 B 的来稿版本
  A.emit({ type: "conflict.resolve", conflictId, action: "apply-b" });
  A.sync();
  B.sync();
  viewA = A.view();
  assert.equal(viewA.conflicts.length, 0, "裁定后冲突消失");
  assert.equal(viewA.cues.find((c) => c.id === "c1")?.translated, "B 版");
  assert.equal(B.view().cues.find((c) => c.id === "c1")?.translated, "B 版", "两台设备收敛一致");
});

test("6. 合并凭据重放时对端缺失 → retry；后续凭据不越过；对端就绪后从没做完处接着重试", () => {
  const { makeDeviceA, makeDeviceB } = setup();
  const A = makeDeviceA();
  // 基线只有 c1，A 离线做了“与下一条合并”
  seedBaseline(A, [cue("c1", { start: 0, end: 2 })]);
  const c1 = A.view().cues.find((c) => c.id === "c1")!;
  A.emit({ type: "cue.merge", cueId: "c1", expectRev: 1, hint: A.hintFor(c1) });
  A.emit({ type: "cue.status", cueId: "c1", hint: A.hintFor(c1), status: "待审" }); // 排在合并之后，不能越过

  const first = A.sync();
  assert.deepEqual(first.retryPending.length, 1, "合并失败，停在没做完的凭据");
  assert.equal(A.pendingCount, 2, "合并和后续凭据都留在发件箱");

  // B 把合并对端 c2 同步上去
  const B = makeDeviceB();
  B.sync();
  B.emit({ type: "cue.add", cue: cue("c2", { start: 2.2, end: 5, translated: "second", status: "待译", rev: 1 }) });
  B.sync();

  // A 重新联网：从合并凭据接着重试，成功后继续状态凭据
  const again = A.sync();
  assert.equal(again.retryPending.length, 0);
  assert.equal(again.pushed, 2);
  assert.equal(A.pendingCount, 0);
  const merged = A.view().cues.find((c) => c.id === "c1")!;
  assert.equal(merged.end, 5);
  assert.ok(merged.translated.includes("second"));
  assert.equal(merged.status, "待审", "后续凭据也已重放");
});

test("7. 旧数据没有凭据：迁移后字幕/审校记录/快照不丢，可继续编辑并同步给其他设备", () => {
  const hubStorage = new MemStorage();
  const storageA = new MemStorage();
  const legacy = {
    tracks,
    cues: [cue("legacy-1", { translated: "旧译文", status: "已通过" })],
    terms,
    events: [{ id: "old-ev-1", cueId: "legacy-1", action: "审校通过" as const, detail: "升级前的通过记录", actor: "顾宁", time: "2026-09-01T00:00:00.000Z" }],
    snapshots: [{ id: "snap-1", name: "升级前快照", time: "2026-09-01T00:00:00.000Z", cues: [] }]
  };
  storageA.setItem(LEGACY_KEY, JSON.stringify(legacy));

  const A = new Device(storageA, "devA", "林岚的电脑", new Hub(hubStorage), "林岚");
  const migrated = A.migrateLegacy(storageA.getItem(LEGACY_KEY));
  assert.equal(migrated, true);
  // 迁移后立即能看到旧数据
  assert.ok(A.view().cues.some((c) => c.id === "legacy-1"));
  assert.ok(A.view().events.some((e) => e.id === "old-ev-1" && e.legacy));
  assert.ok(A.snapshots.some((s) => s.id === "snap-1"), "旧快照保留");

  // 接着编辑 + 联网
  const lc = A.view().cues.find((c) => c.id === "legacy-1")!;
  A.emit({ type: "cue.status", cueId: "legacy-1", hint: A.hintFor(lc), status: "待审" });
  const report = A.sync();
  assert.ok(report.pushed >= 1);

  // B 是全新安装的设备：pull 到全部旧字幕和旧审校记录
  const B = new Device(new MemStorage(), "devB", "周野的电脑", new Hub(hubStorage), "周野");
  B.sync();
  assert.ok(B.view().cues.some((c) => c.id === "legacy-1" && c.translated === "旧译文"));
  assert.ok(B.view().events.some((e) => e.id === "old-ev-1"), "审校记录随基线送达");
  assert.equal(B.view().cues.find((c) => c.id === "legacy-1")?.status, "待审", "升级后继续编辑的结果也同步");
});

test("8. 冲突幂等：来稿凭据因任何原因重放多次，只产生一条待判冲突", () => {
  const { makeDeviceA, makeDeviceB, newHub } = setup();
  const A = makeDeviceA();
  seedBaseline(A, [cue("c1")]);
  const B = makeDeviceB();
  B.sync();
  A.emit({ type: "cue.edit", cueId: "c1", expectRev: 1, hint: A.hintFor(A.view().cues[0]), fields: { translated: "A" } });
  A.sync();
  const bCred = B.emit({ type: "cue.edit", cueId: "c1", expectRev: 1, hint: B.hintFor(B.view().cues[0]), fields: { translated: "B" } });
  B.sync();
  // Hub 已把 bCred 记为 conflict 终态；再次推送是 duplicate，不重复建冲突
  const again = newHub().push(bCred);
  assert.equal(again.result, "duplicate");
  assert.equal(newHub().snapshot().conflicts.filter((c) => c.fromCredentialId === bCred.id).length, 1);
});
