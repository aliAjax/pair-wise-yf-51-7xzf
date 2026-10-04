// 离线凭据同步引擎逻辑测试：通过 Vite SSR 加载真实模块，mock 浏览器 API
import { createServer } from "vite";
import { get } from "svelte/store";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- mock 浏览器环境 ----
const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k)
};
globalThis.navigator = { onLine: true };
globalThis.window = { addEventListener: () => {} };

const vite = await createServer({
  root,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
  resolve: {
    alias: [{ find: /^\$app\/environment$/, replacement: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mock-env.js") }]
  },
  ssr: { noExternal: ["$app/environment"] },
  plugins: [
    {
      name: "mock-app-environment",
      enforce: "pre",
      transform(code, id) {
        const cleanId = id.split("?")[0];
        if ((cleanId.endsWith("sync.ts") || cleanId.endsWith("persistence.ts")) && code.includes("$app/environment")) {
          const mockPath = path.resolve(path.dirname(cleanId), "../../../scripts/mock-env.js").replace(/\\/g, "/");
          return code.replace(/from "\$app\/environment"/, `from "${mockPath}"`);
        }
      }
    }
  ]
});

const sync = await vite.ssrLoadModule("/src/lib/stores/sync.ts");
const subs = await vite.ssrLoadModule("/src/lib/stores/subtitles.ts");

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
const cue = (id) => get(sync.remoteCues).find((c) => c.id === id);
const localCue = (id) => get(subs.cues).find((c) => c.id === id);

// 场景 1：凭据登记 + 推送重放，协作端应用
console.log("\n[1] 凭据登记与推送重放");
subs.updateCue("c2", { end: 3.0 });
await sync.replay();
check("本机凭据已应用", get(sync.outbox).some((c) => c.targetId === "c2" && c.state === "applied"));
check("协作端 c2.end=3.0", cue("c2")?.end === 3.0);

// 场景 2：凭据重复回传只算一次（幂等）
console.log("\n[2] 幂等去重");
const ledgerBefore = get(sync.appliedCredentialIds).length;
await sync.replay();
const ledgerAfter = get(sync.appliedCredentialIds).length;
check("重复重放不增加台账", ledgerBefore === ledgerAfter);

// 场景 3：目标字幕不在时按时间找回
console.log("\n[3] 按时间码找回目标");
// 先在本机加一条空译文字幕（不登记凭据），协作端凭据目标 id 不存在、但时间码落在它区间
subs.cues.update((l) => [...l, { id: "c5", trackId: "en", start: 7.0, end: 8.0, source: "新字幕", translated: "", status: "翻译中", translator: "我", reviewerNote: "" }]);
sync.remoteCredentials.update((l) => [...l, {
  id: "ghost-1", deviceId: "dev-协作译员", seq: 50, op: "cue:update",
  trackId: "en", targetId: "ghost-1", payload: { start: 7.0, end: 8.0, translated: "找回的译文" },
  base: { start: 7.0, end: 8.0, translated: "" },
  createdAt: new Date().toISOString(), state: "pending", attempts: 0
}]);
await sync.replay();
check("按时间找回 ghost-1 并应用到 c5", localCue("c5")?.translated === "找回的译文");

// 场景 4：两边都改 → 留两版待判
console.log("\n[4] 两边都改 → 冲突留两版");
// 协作方先改 c3 的 end
const collabCred = {
  id: "collab-1", deviceId: "dev-协作译员", seq: 99, op: "cue:update",
  trackId: "en", targetId: "c3", payload: { end: 7.0 }, base: { end: 6.5 },
  createdAt: new Date().toISOString(), state: "pending", attempts: 0
};
sync.remoteCredentials.update((l) => [...l, collabCred]);
// 本机也改 c3 的 end
subs.updateCue("c3", { end: 8.0 });
await sync.replay();
const conflict = get(sync.conflicts).find((c) => c.cueId === "c3" && c.field === "end");
check("产生冲突", !!conflict);
check("冲突保留本机版本", conflict?.localValue === 8.0);
check("冲突保留协作版本", conflict?.remoteValue === 7.0);
check("协作方凭据标记 conflict", get(sync.remoteCredentials).some((c) => c.id === "collab-1" && c.state === "conflict"));

// 场景 5：判「采用协作版本」后应用协作值，凭据继续
console.log("\n[5] 冲突判定与续传");
sync.resolveConflict(conflict.id, "采用协作版本");
check("本机 c3.end 采用协作版本 7.0", localCue("c3")?.end === 7.0);
check("冲突标记已判定", get(sync.conflicts).find((c) => c.id === conflict.id)?.status === "采用协作版本");

// 场景 6：已锁定术语不能被重放盖掉
console.log("\n[6] 锁定术语保护");
const term = get(sync.remoteTerms).find((t) => t.id === "g1");
check("g1 术语已锁定", term?.status === "已锁定");
// 重复锁定 g1：幂等跳过，状态不变
sync.recordCredential({ op: "term:lock", targetId: "g1", payload: { status: "已锁定" }, base: { status: "已锁定" } });
await sync.replay();
check("重复锁定后 g1 仍锁定", get(sync.remoteTerms).find((t) => t.id === "g1")?.status === "已锁定");

// 场景 7：已通过审校结论不能被重放盖掉
console.log("\n[7] 已通过审校结论保护");
// c1 是已通过状态，尝试用 review:set 把它退回
sync.recordCredential({ op: "review:set", targetId: "c1", payload: { status: "退回", reviewerNote: "草稿冲掉" }, base: { status: "已通过", reviewerNote: "" }, trackId: "zh" });
await sync.replay();
const c1 = cue("c1");
check("c1 仍为已通过", c1?.status === "已通过");
check("c1 审校备注未被覆盖", c1?.reviewerNote === "");
check("产生保护冲突", get(sync.conflicts).some((c) => c.cueId === "c1" && c.message.includes("已通过")));

// 场景 8：只有一方改 → 正常采用（不冲突）
console.log("\n[8] 单方改动正常采用");
const before = cue("c4")?.translated;
sync.recordCredential({ op: "cue:update", targetId: "c4", payload: { translated: "单方修改的译文" }, base: { translated: before }, trackId: "ja" });
await sync.replay();
check("协作端 c4 应用单方修改", cue("c4")?.translated === "单方修改的译文");

// 场景 9：旧数据迁移 —— 字幕与审校记录不丢
console.log("\n[9] 旧数据迁移保留");
memory.delete("pair-wise-yf-51/subtitles-v2");
memory.set("pair-wise-yf-51/subtitles-v1", JSON.stringify({
  cues: [{ id: "old1", trackId: "zh", start: 0, end: 1, source: "旧字幕", translated: "旧译文", status: "已通过", translator: "旧译者", reviewerNote: "旧备注" }],
  events: [{ id: "e1", cueId: "old1", action: "审校通过", detail: "旧审校", actor: "旧审校员", time: "2024-01-01T00:00:00.000Z" }],
  terms: [], snapshots: [], tracks: []
}));
// 重新加载 persistence 模块模拟升级（initialState 在模块加载时计算）
const persistence2 = await vite.ssrLoadModule("/src/lib/stores/persistence.ts?migrate=1");
check("迁移保留旧字幕", persistence2.initialState.cues.some((c) => c.id === "old1"));
check("迁移保留审校记录", persistence2.initialState.events.some((e) => e.id === "e1"));
check("迁移后协作端基线含旧字幕", persistence2.initialState.remoteCues.some((c) => c.id === "old1"));

console.log(`\n结果：${passed} 通过，${failed} 失败`);
await vite.close();
process.exit(failed ? 1 : 0);
