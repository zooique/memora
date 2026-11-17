/**
 * confirmAuthFlow 单测（HOSTED-CONFIRM-AUTH-1）
 *
 * 覆盖四条分流判据 + 裁决闭环（允许写条目并叫醒 / 拒绝只叫醒）+ 幂等顶替 + 会话清理
 * + 前台/暂存投递。域不 import vscode ⇒ 全依赖注入，无 mock vscode 负担。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WriteConfirmationRequest } from '@zooique/memora';
import { ConfirmAuthFlow } from '../confirmAuthFlow.js';

/**
 * 构造内核确认载荷（命令面 always-ask 默认；targetPath = 命令原文）
 *
 * 字段形态对齐生产 `confirmGate` 的命令面构造：owner 档、always-ask ⇒ needsConfirm=true、
 * 命令面不传 diff ⇒ hasDiff=false——替身只造生产构造得出来的对象，不造类型上存在、
 * 运行时不可能的形态。返回类型从内核 `WriteConfirmationRequest` 形参推导，不自抄接口。
 */
function info(
  overrides: { verdict?: 'always-ask' | 'normal'; targetPath?: string; tool?: string } = {},
): Parameters<WriteConfirmationRequest>[0] {
  return {
    targetPath: overrides.targetPath ?? 'git push origin main',
    tool: overrides.tool ?? 'run_command',
    permission: 'owner',
    needsConfirm: true,
    hasDiff: false,
    verdict: overrides.verdict ?? 'always-ask',
  };
}

const SEAT = 'seat-1';
const WORK = 'work-1';

/** 收集器桩：post / wakeAgent 全部记录，判据可编程；foreground 可变（模拟切会话） */
function makeHarness(opts: { seatForeground?: boolean; agentDriven?: boolean } = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const wakes: Array<{ target: string; text: string }> = [];
  const attentions: Array<{ requestId: string; label: string }> = [];
  // 前台可变：真实链路里 ConfirmCoordinator.setForeground 先改前台再转发 flush，
  // 桩同步改值才能复现「暂存 → 切回补推」
  const foreground = { id: opts.seatForeground === false ? 'other-1' : SEAT };
  const flow = new ConfirmAuthFlow({
    isAgentDrivenSession: (sid) => sid === WORK && (opts.agentDriven ?? true),
    getManagedSeatId: () => SEAT,
    currentForeground: () => foreground.id,
    getSessionLabel: (sid) => (sid === WORK ? '工作会话甲' : sid),
    post: (msg) => posted.push(msg as unknown as Record<string, unknown>),
    onAttention: (a) => attentions.push(a),
    wakeAgent: async (target, text) => {
      wakes.push({ target, text });
      return { ok: true, accepted: true };
    },
    words: {
      authorized: () => 'Authorized',
      authorizationDenied: () => 'Authorization denied',
      wakeApproved: (c) => `approved:${c}`,
      wakeDenied: (c) => `denied:${c}`,
    },
  });
  return { flow, posted, wakes, attentions, foreground };
}

/** 从 post 列表取第一条 auth_request 载荷（无则抛错——测试意图显式失败） */
function firstAuthRequest(posted: Array<Record<string, unknown>>): {
  requestId: string;
  command: string;
  sessionLabel: string;
} {
  const msg = posted.find((m) => m.type === 'auth_request');
  if (!msg) throw new Error('expected an auth_request post');
  return msg as unknown as { requestId: string; command: string; sessionLabel: string };
}

afterEach(() => vi.useRealTimers());

describe('ConfirmAuthFlow · maybeDefer 四条分流判据', () => {
  it('verdict 非 always-ask ⇒ null（写入面 / normal 档不归本域）', () => {
    const { flow } = makeHarness();
    expect(flow.maybeDefer(WORK, info({ verdict: 'normal' }))).toBeNull();
  });

  it('非代理驱动会话 ⇒ null（自助会话确认卡行为逐字不变）', () => {
    const { flow } = makeHarness({ agentDriven: false });
    expect(flow.maybeDefer(WORK, info())).toBeNull();
  });

  it('命中 ⇒ 返 deferred 且座位前台时直接 post 授权请求卡', () => {
    const { flow, posted } = makeHarness();
    expect(flow.maybeDefer(WORK, info())).toBe('deferred');
    const msg = firstAuthRequest(posted);
    expect(msg.command).toBe('git push origin main');
    expect(msg.sessionLabel).toBe('工作会话甲');
  });

  it('座位非前台 ⇒ 不 post、入暂存、发离屏提醒', () => {
    const { flow, posted, attentions } = makeHarness({ seatForeground: false });
    expect(flow.maybeDefer(WORK, info())).toBe('deferred');
    expect(posted.find((m) => m.type === 'auth_request')).toBeUndefined();
    expect(attentions).toHaveLength(1);
    expect(attentions[0]!.label).toContain('git push origin main');
  });

  it('同会话同命令重复请求 ⇒ 幂等顶替（旧条目终结，只留一张卡）', () => {
    const { flow, posted } = makeHarness();
    expect(flow.maybeDefer(WORK, info())).toBe('deferred');
    expect(flow.maybeDefer(WORK, info())).toBe('deferred');
    const requests = posted.filter((m) => m.type === 'auth_request');
    const closed = posted.filter((m) => m.type === 'auth_closed' && m.outcome === 'void');
    expect(requests).toHaveLength(2);
    expect(closed).toHaveLength(1); // 旧条目被顶替时推 void 终结
  });
});

describe('ConfirmAuthFlow · answer 裁决闭环', () => {
  it('允许 ⇒ 写条目（下次分流放行走代批）+ 叫醒代理 + decision 留痕', async () => {
    const { flow, posted, wakes } = makeHarness();
    const r = flow.maybeDefer(WORK, info())!;
    expect(r).toBe('deferred');
    const msg = firstAuthRequest(posted);
    expect(flow.answer(msg.requestId, true)).toBe(true);

    // 授权条目生效：同一命令再撞 always-ask ⇒ null（走既有入队 + 代批链路）
    expect(flow.maybeDefer(WORK, info())).toBeNull();
    // 叫醒目标 = 工作会话，正文带命令原文
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.target).toBe(WORK);
    expect(wakes[0]!.text).toBe('approved:git push origin main');
    // 终态 + 决策记录（落座位时间线）
    const closed = posted.find((m) => m.type === 'auth_closed');
    expect(closed?.outcome).toBe('granted');
    const notice = posted.find((m) => m.type === 'notice');
    expect(notice?.message as string).toContain('Authorized');
  });

  it('拒绝 ⇒ 不写条目（同命令再撞仍转授权请求）+ 叫醒改道文案', () => {
    const { flow, posted, wakes } = makeHarness();
    flow.maybeDefer(WORK, info());
    const msg = firstAuthRequest(posted);
    expect(flow.answer(msg.requestId, false)).toBe(true);
    expect(flow.maybeDefer(WORK, info())).toBe('deferred');
    expect(wakes[0]!.text).toBe('denied:git push origin main');
  });

  it('查无此条 / 已裁决的迟到回执 ⇒ false（幂等丢弃）', () => {
    const { flow, posted } = makeHarness();
    flow.maybeDefer(WORK, info());
    const msg = firstAuthRequest(posted);
    flow.answer(msg.requestId, true);
    expect(flow.answer(msg.requestId, true)).toBe(false);
    expect(flow.answer('auth_unknown', true)).toBe(false);
  });
});

describe('ConfirmAuthFlow · 生命周期', () => {
  it('disposeSession：清授权条目 + 在途卡推 void 终结 + 迟到回执失效', () => {
    const { flow, posted } = makeHarness();
    flow.maybeDefer(WORK, info());
    const msg = firstAuthRequest(posted);
    flow.disposeSession(WORK);
    expect(posted.find((m) => m.type === 'auth_closed')).toMatchObject({ outcome: 'void' });
    expect(flow.answer(msg.requestId, true)).toBe(false);
    // 条目清空 ⇒ 再次撞 always-ask 重新转授权请求（不带旧授权）
    expect(flow.maybeDefer(WORK, info())).toBe('deferred');
  });

  it('座位非前台暂存的请求：flushForSeat 切回时补推队首', () => {
    const { flow, posted, foreground } = makeHarness({ seatForeground: false });
    flow.maybeDefer(WORK, info());
    expect(posted.find((m) => m.type === 'auth_request')).toBeUndefined();
    // 非座位会话切换不触发补推（前台也没切到座位）
    flow.flushForSeat('other-1');
    expect(posted.find((m) => m.type === 'auth_request')).toBeUndefined();
    // 用户切到座位（ConfirmCoordinator.setForeground 先改前台再转发 flush）
    foreground.id = SEAT;
    flow.flushForSeat(SEAT);
    expect(posted.find((m) => m.type === 'auth_request')).toBeDefined();
  });

  it('授权 TTL 过期 ⇒ 再次撞 always-ask 重新转授权请求', () => {
    vi.useFakeTimers();
    const { flow, posted } = makeHarness();
    flow.maybeDefer(WORK, info());
    const msg = firstAuthRequest(posted);
    flow.answer(msg.requestId, true);
    // 授权生效期：同命令分流放行
    expect(flow.maybeDefer(WORK, info())).toBeNull();
    // 越过 AUTH_GRANT_TTL_MS（30 分钟）⇒ 过期，重新转授权请求
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(flow.maybeDefer(WORK, info())).toBe('deferred');
  });
});
