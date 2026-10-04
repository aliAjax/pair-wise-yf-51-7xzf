<script lang="ts">
  import { onMount } from "svelte";
  import { derived } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import {
    activeCues, activeDeviceId, activeTrackId, addCue, createSnapshot, cues, deviceActor, deviceName,
    ensureSeed, lastSyncReport, lockTerm, mergeNext, nudgeCue, online, outbox, pendingConflicts,
    resolveConflict, restoreSnapshot, reviewCue, reviewEvents, selectedCueId,
    setCueStatus, setOnline, snapshots, splitCue, syncMessage, syncNow, switchDevice, terms, tracks, updateCue
  } from "$lib/stores/subtitles";
  import type { Cue } from "$lib/sync/types";

  const DEVICE_OPTIONS = [
    { id: "dev-lin", name: "林岚的笔记本" },
    { id: "dev-zhou", name: "周野的工位机" }
  ];

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      addCue({
        trackId: $activeTrackId,
        start,
        end: start + Number(formData.get("duration") ?? 2.5),
        source: String(formData.get("source") ?? ""),
        translated: String(formData.get("translated") ?? "")
      });
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => $activeCues }));
  const query = createQuery(queryOptions);
  let reviewNote = $state("");

  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  const opLabel: Record<string, string> = {
    "cue.add": "新增字幕",
    "cue.edit": "编辑字幕",
    "cue.split": "拆分",
    "cue.merge": "合并",
    "cue.status": "状态变更",
    "review.approve": "审校通过",
    "review.reject": "退回修改",
    "term.lock": "术语锁定",
    "term.edit": "术语编辑",
    "conflict.resolve": "冲突裁定",
    "baseline.import": "旧版数据迁移"
  };

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  onMount(() => {
    ensureSeed();
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s") splitCue($selectedCueId);
      if (event.key.toLowerCase() === "m") mergeNext($selectedCueId);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); createSnapshot(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:head><title>多语言字幕时间轴协作</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>版本快照</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header><div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>断网也能拆合字幕、改时间码；每台设备的改动按序留凭据，回网逐条重放。</p></div><div class="header-actions"><select value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select><button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button></div></header>

    <section class="sync-bar panel">
      <div class="sync-id">
        <small>当前设备</small>
        <select value={$activeDeviceId} onchange={(e) => switchDevice(e.currentTarget.value)}>
          {#each DEVICE_OPTIONS as opt}<option value={opt.id}>{opt.name}</option>{/each}
        </select>
        <b>{$deviceName}</b><span class="actor">操作人 {$deviceActor}</span>
      </div>
      <div class="sync-net">
        <span class={`net-dot {$online ? "on" : "off"}`}></span>
        <b>{$online ? "已联网" : "断网中（改动只留在本机凭据）"}</b>
        <button class="btn btn-sm" onclick={() => setOnline(!$online)}>{$online ? "模拟断网" : "恢复联网并重放"}</button>
        <button class="btn btn-sm variant-filled-primary" disabled={$online} onclick={() => syncNow()}>立即同步</button>
      </div>
      <div class="sync-stat"><span>待重放凭据</span><b class={$outbox.length ? "warn" : ""}>{$outbox.length}</b></div>
      <div class="sync-stat"><span>待判冲突</span><b class={$pendingConflicts.length ? "danger" : ""}>{$pendingConflicts.length}</b></div>
      <div class="sync-msg">{$syncMessage || "在线状态下编辑会即时重放"}</div>
    </section>

    <section class="metrics"><article><span>当前轨道</span><b>{$tracks.find((t) => t.id === $activeTrackId)?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>待审</span><b>{$activeCues.filter((cue) => cue.status === "待审").length}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>每次拆分/合并/改时间码都会先写成本机凭据，离线不丢、回网可重放</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p></div>
                <span class={`chip ${cue.status}`}>{cue.status}</span>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class={`chip ${selected.status}`}>{selected.status}</span>{/if}</div>
          {#if selected}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={selected.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) })} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) })} /></label></div>
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => reviewCue(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => reviewCue(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button></div>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定后他机重放的改动会被拦截</small></div>
          {#each $terms as term}
            <div class="term"><span><b>{term.source}</b> → {term.target}</span><button class="btn btn-sm" disabled={term.status === "已锁定"} onclick={() => lockTerm(term.id)}>{term.status}</button></div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>冲突两版待判</h2><small>已通过结论不会被盖掉；两边都改过时两版都保留</small></div>
          {#each $pendingConflicts as conflict}
            <article class="conflict">
              <b>{conflict.message}</b>
              <div class="versions">
                <div class="version-a"><small>A · {conflict.versions[0].label}（{conflict.versions[0].actor}）</small><p>{conflict.versions[0].cue.translated || "（无译文）"}</p><span class="chip">{conflict.versions[0].cue.status}</span></div>
                <div class="version-b"><small>B · {conflict.versions[1].label}（{conflict.versions[1].actor}）</small><p>{conflict.versions[1].cue.translated || "（无译文）"}</p><span class="chip">{conflict.versions[1].cue.status}</span></div>
              </div>
              <div class="actions">
                <button class="btn btn-sm" onclick={() => resolveConflict(conflict.id, "apply-a")}>保留 A（当前/已通过）</button>
                <button class="btn btn-sm variant-filled-primary" onclick={() => resolveConflict(conflict.id, "apply-b")}>采用 B（来稿）</button>
              </div>
            </article>
          {:else}<p class="muted">暂无待判冲突。</p>{/each}
        </section>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>新增字幕</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          <label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /><small>{$errors.translated?.[0]}</small></label>
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道</button>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>本机凭据发件箱（{$outbox.length}）</h2>{#if $lastSyncReport}<small>上轮：重放 {$lastSyncReport.pushed} · 重复 {$lastSyncReport.duplicate} · 拦截 {$lastSyncReport.blocked.length} · 待重试 {$lastSyncReport.retryPending.length}</small>{/if}</div>
        <div class="events">
          {#each $outbox as cred}
            <article class="cred"><b>#{cred.seq} {opLabel[cred.op.type] ?? cred.op.type}</b><p>{cred.actor} · {new Date(cred.time).toLocaleTimeString("zh-CN")}</p></article>
          {:else}<p class="muted">发件箱已空，所有改动都已留据回传。</p>{/each}
        </div>
      </section>

      <section class="panel"><div class="panel-head"><h2>审校记录</h2></div><div class="events">{#each $reviewEvents as item}<article><b>{item.action}{item.legacy ? "（旧版迁移）" : ""}</b><p>{item.detail}</p><small>{item.actor} · {new Date(item.time).toLocaleTimeString("zh-CN")}</small></article>{/each}{#if !$reviewEvents.length}<p>暂无审校操作。</p>{/if}</div></section>
    </div>

    <section class="panel" style="margin-top:18px"><div class="panel-head"><h2>版本快照</h2></div><div class="events snap-row">{#each $snapshots as item}<article><b>{item.name}</b><p>{item.cues.length} 条字幕 · {new Date(item.time).toLocaleString("zh-CN")}</p><button class="btn btn-sm" onclick={() => restoreSnapshot(item.id)}>恢复（按凭据回放）</button></article>{/each}{#if !$snapshots.length}<p>使用 ⌘S 或顶部按钮创建快照。</p>{/if}</div></section>
  </main>
</div>
