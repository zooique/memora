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
    expect(decisions[0].message).toContain('已批准');
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
    expect(decisions[0].message).toContain('已自动拒绝');
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

  it('label 是「工具：basename」简写（不承载 diff 全文）', () => {
    const h = makeWired();
    const stub = agentStub();
    h.holder.agent = stub.agent;
    h.coordinator.bindWriteConfirmation();

    stub.trigger(confirmInfo());

    expect(h.shown[0].label).toContain('：');
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
