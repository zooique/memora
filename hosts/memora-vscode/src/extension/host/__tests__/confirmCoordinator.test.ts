/**
 * 确认协调器单测（HOST-SPLIT-1 第 2 刀）
 *
 * 覆盖 `ConfirmCoordinator` 的核心不变式：
 *   ① 注册：onWriteConfirmation 唯一注入口被正确调用；
 *   ② 单条全链路：触发 → 推送 write_confirm_request（载荷完整）→ 应答 → resolve + 决策留痕；
 *   ③ **FIFO 串行**：并发两条只推一张卡；裁决第一条后**立即**推第二条且**不推** closed；
 *   ④ 迟到旧回执：pending 已终结的 id 再应答 ⇒ 零副作用（不 resolve / 不留痕 / 不收卡）；
 *   ⑤ 队列空才收卡：write_confirm_closed 恰好一条；
 *   ⑥ 超时 fail-closed：30 分钟无响应 ⇒ resolve(false) + 决策记录 level=error；
 *   ⑦ 载荷纪律：决策记录只记工具面 basename，**不记** description 全文（反向守卫）；
 *   ⑧ 恰好一条决策记录（防双写）。
 *
 * 驱动方式：直接驱动协调器公开面（bindWriteConfirmation / answer）——协调器**零 vscode 依赖**
 * （依赖经构造注入），故本文件不需要 mock vscode，node 环境即可跑。
 *
 * ⚠️ 未覆盖面（如实登记）：webview 侧审批卡渲染形态归 chatView.test.ts（jsdom 侧 class/文本
 * 断言）；宿主 chatPanel 的接线（sugar 委托 + 装配路径）归 chatPanelDecision.test.ts。
 */
// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

// 宿主侧 l10n 替身（B9-A 起本模块经 vscode.l10n 解析工具展示名）：
// 语义与真实 `vscode.l10n.t` 在**无译文包**时一致——返回英文源键并按 {0} 占位替换。
vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
  },
}));

import type { Agent, WriteConfirmationRequest } from '@zooique/memora';
import { ConfirmCoordinator } from '../confirmCoordinator.js';
import { createAttentionNotifier } from '../attentionNotice.js';

/** 载荷特征串：反向守卫用它确认 description（diff 全文）从未进决策记录 */
const CARGO_MARKER = 'CARGO-FULLTEXT-9527';

/** 内核确认请求载荷类型（从 handler 形参推导，不自抄一份接口） */
type ConfirmInfo = Parameters<WriteConfirmationRequest>[0];

/** 确认请求载荷（内核 WriteConfirmationRequest 形态；description 含特征串） */
function confirmInfo(overrides: Record<string, unknown> = {}): ConfirmInfo {
  return {
    tool: 'write_file',
    targetPath: '/mock/workspace/notes/foo.md',
    description: `${CARGO_MARKER} 这是 diff 全文级载荷`,
    permission: 'confirm',
    beforeContent: null,
    afterContent: 'new content',
    hasDiff: true,
    ...overrides,
  } as unknown as ConfirmInfo;
}

/** 推送消息（宽松类型：断言按 type/kind 过滤） */
type Posted = Record<string, unknown>;

/** 安全守卫桩：捕获 onWriteConfirmation 注入的 handler，供测试手动触发内核确认 */
function agentStub() {
  let handler: WriteConfirmationRequest | undefined;
  const agent = {
    security: {
      onWriteConfirmation: (h: WriteConfirmationRequest) => {
        handler = h;
      },
    },
  } as unknown as Agent;
  return {
    agent,
    trigger: (info: ConfirmInfo): Promise<boolean> => {
      if (!handler) throw new Error('onWriteConfirmation 未注入');
      return handler(info);
    },
  };
}

/** 协调器 + 消息收集器（deps 全注入，无外部副作用） */
function makeCoordinator() {
  const posted: Posted[] = [];
  const holder = { agent: undefined as Agent | undefined };
  const coordinator = new ConfirmCoordinator({
    getAgent: () => holder.agent,
    post: (msg) => {
      posted.push(msg as unknown as Posted);
    },
  });
  return {
    posted,
    holder,
    coordinator,
    /** 取全部审批卡消息 */
    requests: () =>
      posted.filter((m) => m.type === 'write_confirm_request') as Array<{ requestId: string }>,
    /** 取全部决策记录消息（kind='decision' 的 notice） */
    decisions: () =>
      posted.filter((m) => m.kind === 'decision') as Array<{ level: string; message: string }>,
    /** 取全部收卡消息 */
    closed: () => posted.filter((m) => m.type === 'write_confirm_closed'),
  };
}

describe('ConfirmCoordinator（宿主确认队列域 · HOST-SPLIT-1 第 2 刀）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('注册：onWriteConfirmation 唯一注入口被调用一次，handler 非空', () => {
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;

    h.coordinator.bindWriteConfirmation();

    // 桩捕获到 handler ⇒ 注入成功（重复绑定为覆盖赋值，桩内以最后一次为准）
    expect(() => stub.trigger(confirmInfo())).not.toThrow();
  });

  it('单条全链路：推送 write_confirm_request（载荷完整）→ 应答 ⇒ resolve(true) + 一条决策记录', async () => {
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    const settled = stub.trigger(confirmInfo());
    const reqs = h.requests();
    expect(reqs).toHaveLength(1);
    const req = h.posted.find((m) => m.type === 'write_confirm_request') as Posted;
    expect(req.targetPath).toBe('/mock/workspace/notes/foo.md');
    expect(req.tool).toBe('write_file');
    expect(req.description).toContain(CARGO_MARKER);
    expect(req.permission).toBe('confirm');
    expect(req.beforeContent).toBeNull();
    expect(req.afterContent).toBe('new content');
    expect(req.hasDiff).toBe(true);
    // 超时时长透传（A5 SSOT）：真源在协调器，webview 只投影不自算
    expect(req.timeoutMs).toBe(30 * 60 * 1000);

    h.coordinator.answer(reqs[0].requestId, true);
    await expect(settled).resolves.toBe(true);

    const decisions = h.decisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].message).toContain('Approved');
    expect(decisions[0].message).toContain('foo.md');
  });

  it('FIFO 串行：并发两条只推一张卡；裁决第一条后立即推第二条且不推 closed', async () => {
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    const first = stub.trigger(confirmInfo({ targetPath: '/mock/workspace/a.md' }));
    const second = stub.trigger(confirmInfo({ targetPath: '/mock/workspace/b.md' }));

    // 并发两条 ⇒ 只推第一张卡（第二张排队，不白烧超时额度）
    expect(h.requests()).toHaveLength(1);
    expect(h.closed()).toHaveLength(0);

    h.coordinator.answer(h.requests()[0].requestId, true);
    await expect(first).resolves.toBe(true);

    // 裁决第一条 ⇒ 立即推第二条（覆盖渲染），队列未空 ⇒ 不收卡
    expect(h.requests()).toHaveLength(2);
    expect(h.requests()[1].requestId).not.toBe(h.requests()[0].requestId);
    expect(h.closed()).toHaveLength(0);

    // 第二条仍在途（未裁决 ⇒ promise 未 settle）
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
  });

  it('迟到旧回执：pending 已终结的 id 再应答 ⇒ 零副作用（不留痕、不收卡、不影响在途）', async () => {
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo({ targetPath: '/mock/workspace/a.md' }));
    stub.trigger(confirmInfo({ targetPath: '/mock/workspace/b.md' }));
    const firstId = h.requests()[0].requestId;

    // 裁决第一条 ⇒ 推进到第二条
    h.coordinator.answer(firstId, true);
    expect(h.requests()).toHaveLength(2);
    const postedAfterSettle = h.posted.length;

    // 迟到回执（旧 id 的 pending 已 delete）⇒ 必须零副作用
    h.coordinator.answer(firstId, true);
    expect(h.posted.length).toBe(postedAfterSettle);
    expect(h.closed()).toHaveLength(0);
    expect(h.decisions()).toHaveLength(1);
  });

  it('队列空才收卡：最后一条裁决 ⇒ write_confirm_closed 恰好一条', () => {
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo());
    h.coordinator.answer(h.requests()[0].requestId, false);

    expect(h.closed()).toHaveLength(1);
    expect(h.closed()[0].requestId).toBe(h.requests()[0].requestId);
  });

  it('超时 fail-closed：30 分钟无响应 ⇒ resolve(false) + 决策记录 level=error', async () => {
    vi.useFakeTimers();
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    const settled = stub.trigger(confirmInfo());
    // 30 分钟超时（CONFIRM_TIMEOUT_MS 语义）
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await expect(settled).resolves.toBe(false);

    const decisions = h.decisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].level).toBe('error');
    expect(decisions[0].message).toContain('declined automatically');
    expect(decisions[0].message).toContain('foo.md');
  });

  it('超时后推进队列：超时拒第一条 ⇒ 立即推第二条（不推 closed）', async () => {
    vi.useFakeTimers();
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    const first = stub.trigger(confirmInfo({ targetPath: '/mock/workspace/a.md' }));
    stub.trigger(confirmInfo({ targetPath: '/mock/workspace/b.md' }));
    expect(h.requests()).toHaveLength(1);

    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await expect(first).resolves.toBe(false);

    expect(h.requests()).toHaveLength(2);
    expect(h.closed()).toHaveLength(0);
  });

  it('载荷纪律：决策记录只记工具面 basename，不记 description 全文（反向守卫）', () => {
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo());
    h.coordinator.answer(h.requests()[0].requestId, true);

    const d = h.decisions()[0];
    expect(d.message).toContain('foo.md');
    expect(d.message).not.toContain(CARGO_MARKER);
  });

  it('恰好一条决策记录：单次裁决 ⇒ kind=decision 消息恰好 1 条（防双写）', () => {
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo());
    h.coordinator.answer(h.requests()[0].requestId, true);

    expect(h.decisions()).toHaveLength(1);
  });

  it('未注入 handler 前调用 bindWriteConfirmation 不抛错（无 agent ⇒ 直接返回）', () => {
    const h = makeCoordinator();
    // 未设 agent ⇒ getAgent() 返回 undefined ⇒ 静默返回（不得抛）
    expect(() => h.coordinator.bindWriteConfirmation()).not.toThrow();
    expect(h.posted).toHaveLength(0);
  });
});

/**
 * 交互提醒钩子（HOST-ATTN-1）：`onConfirmShown` 在**卡片推出之后**被调一次
 *
 * 为什么顺序也要断言：先提醒后发卡 ⇒ 用户点完「去处理」回来找不到卡（提醒与承接面脱节）。
 * 这类缺陷单看「钩子被调过」是看不见的，故本组用事件序列表断言相对顺序。
 */
describe('ConfirmCoordinator · onConfirmShown 交互提醒钩子（HOST-ATTN-1）', () => {
  /** 带 hook 的协调器：记录 post 与 hook 的**发生顺序** */
  function makeWired() {
    const order: string[] = [];
    const shown: Array<{ requestId: string; label: string }> = [];
    const requests: Array<{ requestId: string; targetPath: string }> = [];
    const holder = { agent: undefined as Agent | undefined };
    const coordinator = new ConfirmCoordinator({
      getAgent: () => holder.agent,
      post: (msg) => {
        const m = msg as unknown as Record<string, unknown>;
        if (m.type === 'write_confirm_request') {
          order.push('post');
          requests.push({ requestId: m.requestId as string, targetPath: m.targetPath as string });
        }
      },
      onConfirmShown: (info) => {
        order.push('shown');
        shown.push(info);
      },
    });
    return { order, shown, requests, holder, coordinator };
  }

  it('卡推出 ⇒ 钩子被调一次，requestId 与推送的卡一致', () => {
    const h = makeWired();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo());

    expect(h.shown).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(h.shown[0].requestId).toBe(h.requests[0].requestId);
  });

  it('label 是「工具: basename」简写（不承载 diff 全文）', () => {
    const h = makeWired();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo());

    // 无译文包 ⇒ 英文源键形态「Write file: foo.md」（判据 = 工具面 + 冒号 + basename，不断言具体语言）
    expect(h.shown[0].label).toContain(': ');
    expect(h.shown[0].label.endsWith('foo.md')).toBe(true);
    // 反向守卫：diff 全文绝不进提醒文案（通知是最可能被截图外传的面）
    expect(h.shown[0].label).not.toContain(CARGO_MARKER);
  });

  it('顺序契约：先 post 后 shown（提醒必须有承接面）', () => {
    const h = makeWired();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo());

    expect(h.order).toEqual(['post', 'shown']);
  });

  it('FIFO 排队：并发两条只提醒已推出的那张卡（排队的不提醒）', () => {
    const h = makeWired();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo({ targetPath: '/mock/workspace/a.md' }));
    stub.trigger(confirmInfo({ targetPath: '/mock/workspace/b.md' }));

    expect(h.requests).toHaveLength(1);
    expect(h.shown).toHaveLength(1);
    expect(h.requests[0].targetPath.endsWith('a.md')).toBe(true);
  });

  it('裁决后推出第二张卡 ⇒ 再提醒一次（每张卡各自一次）', () => {
    const h = makeWired();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo({ targetPath: '/mock/workspace/a.md' }));
    stub.trigger(confirmInfo({ targetPath: '/mock/workspace/b.md' }));
    h.coordinator.answer(h.requests[0].requestId, true);

    expect(h.requests).toHaveLength(2);
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1].requestId).toBe(h.requests[1].requestId);
  });

  it('未注入钩子 ⇒ 主链路零行为变化（向后兼容）', () => {
    const h = makeCoordinator();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    expect(() => stub.trigger(confirmInfo())).not.toThrow();
    expect(h.requests()).toHaveLength(1);
  });

  it('提醒层注入面同步抛错 ⇒ 确认链路照常（真形态：接的是真实 notifier）', () => {
    // 这条用例打的是**生产组合**，不是假想的坏钩子：chatPanel 注入的就是
    // `createAttentionNotifier(...)`，其 `playSound` 最终会 spawn PowerShell
    // （系统策略拦截、powershell 被改名等边角面会同步抛）。提醒是增值能力，确认卡是安全
    // 关键路径——前者不得把后者打掉。
    const notifier = createAttentionNotifier({
      isWindowFocused: () => false, // 失焦 ⇒ 真的走到响提示音那一步
      playSound: () => {
        throw new Error('提示音层炸了');
      },
    });
    const holder = { agent: undefined as Agent | undefined };
    const posted: Posted[] = [];
    const coordinator = new ConfirmCoordinator({
      getAgent: () => holder.agent,
      post: (msg) => {
        posted.push(msg as unknown as Posted);
      },
      onConfirmShown: (info) => notifier.onConfirmShown(info),
    });
    const stub = agentStub();
    holder.agent = stub.agent;
    coordinator.bindWriteConfirmation();

    expect(() => stub.trigger(confirmInfo())).not.toThrow();
    expect(posted.filter((m) => m.type === 'write_confirm_request')).toHaveLength(1);
  });
});

/**
 * 按会话绑定（E4 批 4）：后台会话的确认同样入队、可裁决，只是**卡不跨会话串台上屏**
 *
 * 四条判据：
 *   ① 后台会话触发确认 ⇒ 零上屏 + 待处理计数亮（onPendingChanged 收到 (会话, 1)）；
 *   ② 切到该会话 ⇒ 卡出现，裁决生效（后台挂着不等于只能等超时）；
 *   ③ 切走 ⇒ 只收卡（`write_confirm_closed`）**不终结请求**；切回 ⇒ 同一 requestId 重推；
 *   ④ 后台会话的迟到回执被拒（不得从别的会话界面替它做决定）。
 */
describe('ConfirmCoordinator · 按会话绑定（E4 批 4）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 带待处理计数的协调器 */
  function makeSessionCoordinator() {
    const posted: Posted[] = [];
    const pendingChanges: Array<{ sessionId: string; count: number }> = [];
    const coordinator = new ConfirmCoordinator({
      getAgent: () => undefined,
      post: (msg) => {
        posted.push(msg as unknown as Posted);
      },
      onPendingChanged: (sessionId, count) => pendingChanges.push({ sessionId, count }),
    });
    return {
      coordinator,
      pendingChanges,
      requests: () =>
        posted.filter((m) => m.type === 'write_confirm_request') as Array<{
          requestId: string;
        }>,
      closed: () => posted.filter((m) => m.type === 'write_confirm_closed'),
      decisions: () => posted.filter((m) => m.kind === 'decision') as Posted[],
    };
  }

  it('后台会话入队 ⇒ 零上屏 + 待处理计数亮；切过去才推卡并可裁决', async () => {
    const h = makeSessionCoordinator();
    const stub = agentStub();
    h.coordinator.bindSession('2026-11-06-a', stub.agent);

    const settled = stub.trigger(confirmInfo());
    // 后台（前台仍是默认 ''）：卡不上屏，但计数亮（否则用户永远不知道后台在等）
    expect(h.requests()).toHaveLength(0);
    expect(h.coordinator.pendingCount('2026-11-06-a')).toBe(1);
    expect(h.pendingChanges.at(-1)).toEqual({ sessionId: '2026-11-06-a', count: 1 });

    // 切到该会话 ⇒ 补推卡
    h.coordinator.setForeground('2026-11-06-a');
    expect(h.requests()).toHaveLength(1);
    h.coordinator.answer(h.requests()[0].requestId, true);
    await expect(settled).resolves.toBe(true);
    // 裁决后计数归零（列表标识 / 角标随之熄灭）
    expect(h.coordinator.pendingCount('2026-11-06-a')).toBe(0);
  });

  it('切走只收卡不终结；切回重推同一 requestId', async () => {
    const h = makeSessionCoordinator();
    const stub = agentStub();
    h.coordinator.bindSession('2026-11-06-a', stub.agent);
    h.coordinator.setForeground('2026-11-06-a');

    let settled = false;
    const promise = stub.trigger(confirmInfo()).then((v) => {
      settled = true;
      return v;
    });
    expect(h.requests()).toHaveLength(1);
    const requestId = h.requests()[0].requestId;

    h.coordinator.setForeground('2026-11-06-b');
    // 收卡（界面上不残留 A 的卡），但不 resolve（回来还能答）
    expect(h.closed()).toHaveLength(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    h.coordinator.setForeground('2026-11-06-a');
    expect(h.requests()).toHaveLength(2);
    expect(h.requests()[1].requestId).toBe(requestId); // 请求身份不因上屏次数而变
    h.coordinator.answer(requestId, false);
    await expect(promise).resolves.toBe(false);
  });

  it('卡上屏后被切走 ⇒ 超时拒的记录不写当前屏幕，切回该会话时补进它自己的时间线', async () => {
    vi.useFakeTimers();
    const h = makeSessionCoordinator();
    const stub = agentStub();
    h.coordinator.bindSession('2026-11-06-a', stub.agent);
    h.coordinator.setForeground('2026-11-06-a');

    const settled = stub.trigger(confirmInfo());
    expect(h.requests()).toHaveLength(1);
    const decisionsBefore = h.decisions().length;

    // 切到 B：A 的卡收掉，但请求未终结、计时器继续走（既有语义）
    h.coordinator.setForeground('2026-11-06-b');
    expect(h.closed()).toHaveLength(1);

    // 30 分钟后 A 在后台超时 ⇒ fail-closed，且记录**不得**写进当前屏幕（B 的时间线）
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await expect(settled).resolves.toBe(false);
    expect(h.decisions()).toHaveLength(decisionsBefore);

    // 切回 A ⇒ 该会话自己的时间线补上这条「替你拒了什么」
    h.coordinator.setForeground('2026-11-06-a');
    const decisions = h.decisions();
    expect(decisions).toHaveLength(decisionsBefore + 1);
    expect(decisions.at(-1)?.level).toBe('error');
    expect(String(decisions.at(-1)?.message)).toContain('foo.md');
    expect(String(decisions.at(-1)?.message)).toContain('declined automatically');
  });

  it('后台会话的迟到回执被拒：只认当前显示会话在途请求', async () => {
    const h = makeSessionCoordinator();
    const stub = agentStub();
    h.coordinator.bindSession('2026-11-06-a', stub.agent);

    stub.trigger(confirmInfo()); // 后台入队（前台 ''）
    // 前台上没卡 ⇒ 用队列里的 id 也无法替后台裁决（answer 只查前台会话的在途）
    h.coordinator.answer('wc_any', true);
    expect(h.coordinator.pendingCount('2026-11-06-a')).toBe(1);
    expect(h.requests()).toHaveLength(0);
  });

  it('repostForeground：视图重建后重推当前会话在途卡（否则卡凭空消失、无从作答）', () => {
    const h = makeSessionCoordinator();
    const stub = agentStub();
    h.coordinator.bindSession('2026-11-06-a', stub.agent);
    h.coordinator.setForeground('2026-11-06-a');
    stub.trigger(confirmInfo());

    expect(h.requests()).toHaveLength(1);
    h.coordinator.repostForeground();
    expect(h.requests()).toHaveLength(2);
    expect(h.requests()[1].requestId).toBe(h.requests()[0].requestId);
  });
});

/**
 * 会话删除清理（E4 批 3 · 会话级僵尸）
 *
 * 伤：`_sessions` 只在裁决/超时终结单条请求，没有「整会话移除」出口 ⇒ 已删会话的条目
 * 永久留在表里（排队 Promise 永不 settle、计时器照烧、`pendingCount` 持续亮待处理）。
 *
 * 判据：
 *   ① 在途 + 排队的请求全部 `resolve(false)`（fail-closed，与超时同向）；
 *   ② `pendingCount` 归零且回调收到 (会话, 0)；
 *   ③ 前台已上屏的卡收掉（不留点了无响应的僵尸卡）；
 *   ④ 条目摘除后，迟到回执零副作用。
 */
describe('ConfirmCoordinator · disposeSession 会话删除清理（E4 批 3）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 带待处理计数的协调器（复用「按会话绑定」的构造，避免第二份装配） */
  function makeSessionCoordinator() {
    const posted: Posted[] = [];
    const pendingChanges: Array<{ sessionId: string; count: number }> = [];
    const coordinator = new ConfirmCoordinator({
      getAgent: () => undefined,
      post: (msg) => {
        posted.push(msg as unknown as Posted);
      },
      onPendingChanged: (sessionId, count) => pendingChanges.push({ sessionId, count }),
    });
    return {
      coordinator,
      pendingChanges,
      requests: () =>
        posted.filter((m) => m.type === 'write_confirm_request') as Array<{
          requestId: string;
        }>,
      closed: () => posted.filter((m) => m.type === 'write_confirm_closed'),
    };
  }

  it('在途 + 排队全部 fail-closed 终结，计数归零且收卡', async () => {
    const h = makeSessionCoordinator();
    const stub = agentStub();
    h.coordinator.bindSession('2026-11-06-a', stub.agent);
    h.coordinator.setForeground('2026-11-06-a');

    const first = stub.trigger(confirmInfo({ targetPath: '/mock/workspace/a.md' }));
    const second = stub.trigger(confirmInfo({ targetPath: '/mock/workspace/b.md' }));
    // 删除前：一张在途 + 一张排队
    expect(h.coordinator.pendingCount('2026-11-06-a')).toBe(2);
    expect(h.requests()).toHaveLength(1);
    expect(h.closed()).toHaveLength(0);

    h.coordinator.disposeSession('2026-11-06-a');

    // ① fail-closed：两条都拒绝（不得永久挂起内核）
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    // ② 整会话条目摘除 ⇒ 待处理归零 + 通知宿主熄灭标识
    expect(h.coordinator.pendingCount('2026-11-06-a')).toBe(0);
    expect(h.pendingChanges.at(-1)).toEqual({ sessionId: '2026-11-06-a', count: 0 });
    // ③ 已上屏的卡必须收掉
    expect(h.closed()).toHaveLength(1);
  });

  it('计时器随条目摘除而停（不再到点重推/重结算），迟到回执零副作用', async () => {
    vi.useFakeTimers();
    const h = makeSessionCoordinator();
    const stub = agentStub();
    h.coordinator.bindSession('2026-11-06-a', stub.agent);
    h.coordinator.setForeground('2026-11-06-a');

    const settled = stub.trigger(confirmInfo());
    const requestId = h.requests()[0].requestId;
    h.coordinator.disposeSession('2026-11-06-a');
    await expect(settled).resolves.toBe(false);
    const postedAfterDispose = h.requests().length;
    const closedAfterDispose = h.closed().length;

    // ③ 超时计时器已清：推进超时窗口后不得再推卡、再收卡
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(h.requests()).toHaveLength(postedAfterDispose);
    expect(h.closed()).toHaveLength(closedAfterDispose);
    // ④ 迟到回执：`answer` 只查前台会话的在途，条目已摘 ⇒ 零副作用
    h.coordinator.answer(requestId, true);
    expect(h.requests()).toHaveLength(postedAfterDispose);
    expect(h.closed()).toHaveLength(closedAfterDispose);
  });

  it('未建队列的会话 ⇒ 幂等零副作用（不重复回调、不抛错）', () => {
    const h = makeSessionCoordinator();
    const before = h.pendingChanges.length;
    expect(() => h.coordinator.disposeSession('2026-11-06-never')).not.toThrow();
    expect(h.pendingChanges.length).toBe(before);
  });
});

/**
 * 按会话应答入口 `answerFor`（R0-c · 远程控制前置）
 *
 * 钉住的不变量：
 *   ① **对外行为不变**：`answer()` 委托 `answerFor(前台会话)`，同一场景下消息序列与裁决值逐条相同；
 *   ② 远程可对**指定会话**的在途请求裁决（不要求该会话是屏幕焦点）；
 *   ③ 受理判据与 `answer` 一致：只认该会话的**在途**请求，排队未上屏 / 未知 id / 迟到回执一律拒；
 *   ④ 后台会话裁决**不写决策通知**（notice 无会话寻址能力，发了就是跨会话串台）。
 */
describe('ConfirmCoordinator · answerFor 按会话应答（R0-c）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 归一化 requestId（随机生成，逐条比较时必须抹掉） */
  function normalize(posted: Posted[]): Posted[] {
    return posted.map((m) => {
      const next: Posted = { ...m };
      if (typeof next.requestId === 'string' && next.requestId.startsWith('wc_')) {
        next.requestId = '<id>';
      }
      return next;
    });
  }

  it('answer() 与 answerFor(前台会话) 的消息序列、裁决值逐条相同（委托不改对外行为）', async () => {
    /** 跑一遍完整场景：建会话 → 上屏 → 批准 */
    async function run(viaAnswerFor: boolean) {
      const posted: Posted[] = [];
      const holder = { agent: undefined as Agent | undefined };
      const coordinator = new ConfirmCoordinator({
        getAgent: () => holder.agent,
        post: (msg) => {
          posted.push(msg as unknown as Posted);
        },
      });
      const stub = agentStub();
      holder.agent = stub.agent;
      coordinator.bindWriteConfirmation(); // 前台 = 默认 ''

      const settled = stub.trigger(confirmInfo());
      const requestId = (
        posted.find((m) => m.type === 'write_confirm_request') as { requestId: string }
      ).requestId;
      if (viaAnswerFor) {
        expect(coordinator.answerFor('', requestId, true)).toBe(true);
      } else {
        coordinator.answer(requestId, true);
      }
      return { posted: normalize(posted), verdict: await settled };
    }

    const viaAnswer = await run(false);
    const viaAnswerFor = await run(true);
    expect(viaAnswerFor).toEqual(viaAnswer);
    expect(viaAnswer.verdict).toBe(true);
  });

  it('对指定会话的在途请求裁决：resolve 生效、计数归零、收卡（与 answer 同一套副作用）', async () => {
    const posted: Posted[] = [];
    const coordinator = new ConfirmCoordinator({
      getAgent: () => undefined,
      post: (msg) => {
        posted.push(msg as unknown as Posted);
      },
    });
    const stub = agentStub();
    coordinator.bindSession('s-a', stub.agent);
    coordinator.setForeground('s-a');

    const settled = stub.trigger(confirmInfo());
    const requestId = (
      posted.find((m) => m.type === 'write_confirm_request') as { requestId: string }
    ).requestId;

    expect(coordinator.answerFor('s-a', requestId, false)).toBe(true);
    await expect(settled).resolves.toBe(false);
    expect(coordinator.pendingCount('s-a')).toBe(0);
    expect(posted.filter((m) => m.type === 'write_confirm_closed')).toHaveLength(1);
  });

  it('后台会话（卡已上屏后被切走）可远程裁决：不写当前屏幕，切回该会话时补上决策记录', async () => {
    const posted: Posted[] = [];
    const coordinator = new ConfirmCoordinator({
      getAgent: () => undefined,
      post: (msg) => {
        posted.push(msg as unknown as Posted);
      },
    });
    const stub = agentStub();
    coordinator.bindSession('s-a', stub.agent);
    coordinator.setForeground('s-a');
    const settled = stub.trigger(confirmInfo());
    const requestId = (
      posted.find((m) => m.type === 'write_confirm_request') as { requestId: string }
    ).requestId;

    // 切走：卡收掉但不终结请求（既有语义），此时 s-a 是后台会话
    coordinator.setForeground('s-b');
    const decisionsBefore = posted.filter((m) => m.kind === 'decision').length;
    const closedBefore = posted.filter((m) => m.type === 'write_confirm_closed').length;

    expect(coordinator.answerFor('s-a', requestId, true)).toBe(true);
    await expect(settled).resolves.toBe(true);
    // ④ 决策通知是「屏幕时间线」载荷，后台会话不得**当场**写入（跨会话串台）
    expect(posted.filter((m) => m.kind === 'decision')).toHaveLength(decisionsBefore);
    // 后台会话裁决不驱动屏幕：不额外发 closed（卡在切走时已收）
    expect(posted.filter((m) => m.type === 'write_confirm_closed')).toHaveLength(closedBefore);
    expect(coordinator.pendingCount('s-a')).toBe(0);

    // ⑤ 切回该会话 ⇒ 暂存的决策记录补进它自己的时间线（不丢）
    coordinator.setForeground('s-a');
    const decisions = posted.filter((m) => m.kind === 'decision');
    expect(decisions).toHaveLength(decisionsBefore + 1);
    expect(String((decisions.at(-1) as Posted).message)).toContain('Approved');
  });

  it('排队未上屏 / 未知 id / 迟到旧回执 ⇒ 拒（false）且零副作用', async () => {
    const posted: Posted[] = [];
    const coordinator = new ConfirmCoordinator({
      getAgent: () => undefined,
      post: (msg) => {
        posted.push(msg as unknown as Posted);
      },
    });
    const stub = agentStub();
    coordinator.bindSession('s-a', stub.agent); // 后台：请求只入队，不上屏

    let settled = false;
    void stub.trigger(confirmInfo()).then(() => {
      settled = true;
    });

    // 排队中（无在途卡）⇒ 远程也不得越过 FIFO 提前裁决
    expect(coordinator.answerFor('s-a', 'wc_unknown', true)).toBe(false);
    expect(coordinator.pendingCount('s-a')).toBe(1);

    // 上屏后正常裁决，再重放同一 id ⇒ 迟到回执被拒
    coordinator.setForeground('s-a');
    const requestId = (
      posted.find((m) => m.type === 'write_confirm_request') as { requestId: string }
    ).requestId;
    expect(coordinator.answerFor('s-a', requestId, true)).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(coordinator.answerFor('s-a', requestId, true)).toBe(false);
  });
});
