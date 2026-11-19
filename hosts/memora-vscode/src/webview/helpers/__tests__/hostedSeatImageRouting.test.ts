/**
 * 助手窗图片上行分流回归（2026-11-18 真机缺陷 · IMAGE-TARGET-1）
 *
 * 真机实锤：在助手窗输入框点「添加图片」，缩略图串进侧栏工作会话的输入区。
 * 根因 = hostedSeat.handleMessage 对图片消息无分支 → forward → 面板 post() 硬投
 * `_currentSessionId`（侧栏当前会话）。本测试钉死：图片上行必须按助手会话定向，
 * 且不转 forward；非图片消息仍走原分流，零变化。
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// hostedSeat 顶层解构 vscode.l10n 之外只用 l10n.t，补齐被解构的键避免 import 期 throw
vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
}));

import { createHostedSeat, type HostedSeatDeps } from '../hostedSeat.js';

/** 替身：只记录调用目标，不碰真实会话 / webview */
function makeDeps(assistantSid: string | undefined = 'assistant-1'): {
  deps: HostedSeatDeps;
  calls: { attach: unknown[][]; forward: unknown[][]; refreshActivity: number };
} {
  const calls = {
    attach: [] as unknown[][],
    forward: [] as unknown[][],
    refreshActivity: 0,
  };
  const deps: HostedSeatDeps = {
    assistantSessionId: () => assistantSid,
    dropAssistantSession: () => {},
    isResolvable: (sid) => sid === assistantSid,
    createAssistantSession: async () => true,
    assembleAgent: async () => {},
    replaySession: () => {},
    handleInput: async () => {},
    attachImagesFrom: (msg, sid) => calls.attach.push([msg, sid]),
    forward: (msg) => calls.forward.push([msg]),
    isCurrentSession: (sid) => sid === 'side-current',
    noteComposerState: () => {},
    postToSession: () => {},
    postToExtras: () => {},
    stop: async () => true,
    pause: () => {},
    pushProviders: () => {},
    setAdditionalForeground: () => {},
    repostConfirm: () => {},
    refreshActivity: () => {
      calls.refreshActivity += 1;
    },
    openWorkbench: () => {},
  };
  return { deps, calls };
}

const pickRequest = { type: 'image_pick_request' } as const;
const ingest = {
  type: 'image_ingest',
  base64: '',
  name: 'p.png',
  mime: 'image/png',
  width: 1,
  height: 1,
  sha256: 'x',
} as const;

describe('DISPATCH-CARD-HOSTED-READY-1 · 助手窗 ready 必 force 补推首份活跃度快照', () => {
  it('有助手会话：handleReady 调 refreshActivity（快照去重基线是面板级单一串，不补则卡区恒 hidden）', async () => {
    const { deps, calls } = makeDeps();
    const seat = createHostedSeat(deps);
    await seat.handleReady();
    expect(calls.refreshActivity).toBe(1);
  });

  it('空态（无助手会话）：handleReady 同样补推（无会话即空列表，零副作用）', async () => {
    const { deps, calls } = makeDeps(undefined);
    const seat = createHostedSeat(deps);
    await seat.handleReady();
    expect(calls.refreshActivity).toBe(1);
  });
});

describe('HOSTED-IMAGE-TARGET-1 · 助手窗图片上行按来源会话定向', () => {
  it('image_pick_request → attachImagesFrom(助手会话)，绝不 forward', () => {
    const { deps, calls } = makeDeps();
    const seat = createHostedSeat(deps);

    seat.handleMessage(pickRequest);

    expect(calls.attach).toEqual([[pickRequest, 'assistant-1']]);
    expect(calls.forward).toEqual([]);
  });

  it('image_ingest（粘贴 / 拖入）同样定向助手会话，不 forward', () => {
    const { deps, calls } = makeDeps();
    const seat = createHostedSeat(deps);

    seat.handleMessage(ingest);

    expect(calls.attach).toEqual([[ingest, 'assistant-1']]);
    expect(calls.forward).toEqual([]);
  });

  it('助手指针失效（无会话 id）→ 不盲投，退回 forward 兜底可见反馈', () => {
    const { deps, calls } = makeDeps();
    deps.assistantSessionId = () => undefined;
    const seat = createHostedSeat(deps);

    seat.handleMessage(pickRequest);

    expect(calls.attach).toEqual([]);
    expect(calls.forward).toEqual([[pickRequest]]);
  });

  it('非图片消息仍走原分流：composer_state 不误伤，其余 forward 不变', () => {
    const { deps, calls } = makeDeps();
    const seat = createHostedSeat(deps);

    seat.handleMessage({ type: 'ready' });
    seat.handleMessage({ type: 'open_settings_tab', tab: 'config' });

    expect(calls.attach).toEqual([]);
    expect(calls.forward).toHaveLength(1);
    expect(calls.forward[0][0]).toMatchObject({ type: 'open_settings_tab' });
  });

  it('判据原文守卫：handleMessage 源码含图片分支且定向调用 attachImagesFrom', () => {
    const src = readFileSync(new URL('../hostedSeat.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/msg\.type === 'image_pick_request' \|\| msg\.type === 'image_ingest'/);
    expect(src).toMatch(/deps\.attachImagesFrom\(msg, sid\)/);
    // 图片分支必须早于兜底 forward，否则仍会串窗
    const branchAt = src.indexOf(
      "msg.type === 'image_pick_request' || msg.type === 'image_ingest'",
    );
    const forwardAt = src.indexOf('deps.forward(msg);', branchAt);
    expect(forwardAt).toBeGreaterThan(branchAt);
  });
});
