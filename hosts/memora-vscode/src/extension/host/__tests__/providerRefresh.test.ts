/**
 * IMG-5 · 配置热刷新（`refreshActiveProvider`）单测
 *
 * 被测面是**纯编排**：真源 → 实例 → 三连注入 → 投影。宿主差异全部经 deps 注入，
 * 所以这里不需要 vscode 替身（该模块本身零 vscode 依赖，这条也是它的设计目的之一）。
 *
 * 钉死的判据（按重要性）：
 *   ① **失败出口也推投影**：按钮态读真源，与门禁（读内核实例）必须解耦——漏推会让
 *      「保存后按钮不变亮」复现，而那是本缺陷的另一半；
 *   ② **未生效不谎报生效**：读配置 / 造实例 / 换实例任一失败 ⇒ `applied:false` + 原始异常透出，
 *      调用方据此留 stale（下一个 send 前补做）；
 *   ③ **上下文窗口经 `resolveContextWindow` 单点解析**：宿主不复制回落公式。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { LlmProvider } from '@zooique/memora';
import {
  refreshActiveProvider,
  type ProviderRefreshDeps,
  type RefreshingAgent,
} from '../providerRefresh.js';

/** 内核实例替身：本模块只读它的身份（能力位由构造期决定，不在此断言） */
function providerStub(name = 'p1'): LlmProvider {
  return { name, supportsVision: true } as unknown as LlmProvider;
}

/** Agent 替身：三个注入方法各自可断言，且可单独设置抛出（模拟 assertNotBusy） */
interface AgentProbe {
  agent: RefreshingAgent;
  setProvider: ReturnType<typeof vi.fn>;
  setContextWindow: ReturnType<typeof vi.fn>;
  setMaxTokens: ReturnType<typeof vi.fn>;
}

function agentProbe(over: Partial<Record<'setProvider', Error>> = {}): AgentProbe {
  const setProvider = vi.fn(() => {
    if (over.setProvider) throw over.setProvider;
  });
  const setContextWindow = vi.fn();
  const setMaxTokens = vi.fn();
  return {
    agent: { setProvider, setContextWindow, setMaxTokens },
    setProvider,
    setContextWindow,
    setMaxTokens,
  };
}

/** deps 组装：各项默认成功，按用例覆盖 */
function makeDeps(over: Partial<ProviderRefreshDeps> = {}): {
  deps: ProviderRefreshDeps;
  pushProviders: ReturnType<typeof vi.fn>;
  getActiveConfig: ReturnType<typeof vi.fn>;
  buildProvider: ReturnType<typeof vi.fn>;
} {
  const pushProviders = vi.fn(async () => {});
  const getActiveConfig = vi.fn(async () => ({ contextWindow: 32_000, maxTokens: 4096 }));
  const buildProvider = vi.fn(async () => providerStub());
  // 共享同一 agent 替身：若被测实现多次取 agent，也不该拿到不同实例（掩盖问题的替身）
  const shared = agentProbe();
  const deps: ProviderRefreshDeps = {
    getAgent: () => shared.agent,
    getActiveConfig,
    buildProvider,
    pushProviders,
    ...over,
  };
  return { deps, pushProviders, getActiveConfig, buildProvider };
}

describe('IMG-5 · refreshActiveProvider', () => {
  it('未装配 ⇒ 不造实例、不碰 agent，但仍推投影（面板可能已开、agent 仍在懒装配）', async () => {
    const { deps, pushProviders, getActiveConfig, buildProvider } = makeDeps({
      getAgent: () => undefined,
    });

    const r = await refreshActiveProvider(deps);

    expect(r).toEqual({ applied: true, skipped: 'not-assembled' });
    expect(pushProviders).toHaveBeenCalledTimes(1);
    expect(getActiveConfig).not.toHaveBeenCalled();
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it('无激活配置（env 回退）⇒ 跳过实例重建，但推投影', async () => {
    const probe = agentProbe();
    const { deps, pushProviders, buildProvider } = makeDeps({
      getAgent: () => probe.agent,
      getActiveConfig: async () => undefined,
    });

    const r = await refreshActiveProvider(deps);

    expect(r).toEqual({ applied: true, skipped: 'no-active' });
    expect(pushProviders).toHaveBeenCalledTimes(1);
    expect(buildProvider).not.toHaveBeenCalled();
    expect(probe.setProvider).not.toHaveBeenCalled();
  });

  it('正常路径 ⇒ 换实例 + 窗口经 resolveContextWindow + 预算透传 + 推投影', async () => {
    const probe = agentProbe();
    const built = providerStub('new-model');
    const { deps, pushProviders } = makeDeps({
      getAgent: () => probe.agent,
      buildProvider: async () => built,
    });

    const r = await refreshActiveProvider(deps);

    expect(r).toEqual({ applied: true });
    expect(probe.setProvider).toHaveBeenCalledWith(built);
    // 传了值 ⇒ 原样生效（resolveContextWindow 只在 undefined 时回落）
    expect(probe.setContextWindow).toHaveBeenCalledWith(32_000);
    expect(probe.setMaxTokens).toHaveBeenCalledWith(4096);
    expect(pushProviders).toHaveBeenCalledTimes(1);
  });

  it('上下文窗口未填 ⇒ 回落内核默认（宿主不复制回落公式）', async () => {
    const probe = agentProbe();
    const { deps } = makeDeps({
      getAgent: () => probe.agent,
      getActiveConfig: async () => ({ contextWindow: undefined, maxTokens: undefined }),
    });

    await refreshActiveProvider(deps);

    const tokens = probe.setContextWindow.mock.calls[0]![0] as number;
    expect(tokens).toBeGreaterThan(0);
    expect(probe.setMaxTokens).toHaveBeenCalledWith(undefined);
  });

  it('读真源失败 ⇒ applied:false + 异常透出 + 仍推投影 + 不碰 agent', async () => {
    const probe = agentProbe();
    const err = new Error('钥匙串读取超时');
    const { deps, pushProviders, buildProvider } = makeDeps({
      getAgent: () => probe.agent,
      getActiveConfig: async () => {
        throw err;
      },
    });

    const r = await refreshActiveProvider(deps);

    expect(r).toMatchObject({ applied: false, reason: 'load-failed', error: err });
    expect(pushProviders).toHaveBeenCalledTimes(1);
    expect(buildProvider).not.toHaveBeenCalled();
    expect(probe.setProvider).not.toHaveBeenCalled();
  });

  it('造实例失败（SecretStorage 超时 / 配置非法）⇒ load-failed，同样不碰 agent', async () => {
    const probe = agentProbe();
    const err = new Error('缺少 LLM 配置');
    const { deps, pushProviders } = makeDeps({
      getAgent: () => probe.agent,
      buildProvider: async () => {
        throw err;
      },
    });

    const r = await refreshActiveProvider(deps);

    expect(r).toMatchObject({ applied: false, reason: 'load-failed', error: err });
    expect(pushProviders).toHaveBeenCalledTimes(1);
    expect(probe.setProvider).not.toHaveBeenCalled();
  });

  it('换实例被 assertNotBusy 拒 ⇒ busy + 仍推投影（按钮态不受 busy 影响）', async () => {
    const probe = agentProbe({ setProvider: new Error('对话进行中，无法切换 Provider') });
    const { deps, pushProviders } = makeDeps({ getAgent: () => probe.agent });

    const r = await refreshActiveProvider(deps);

    expect(r).toMatchObject({ applied: false, reason: 'busy' });
    expect(pushProviders).toHaveBeenCalledTimes(1);
    // 主目标失败即停：窗口与预算不落（避免「窗口换了、能力位没换」的错位中间态）
    expect(probe.setContextWindow).not.toHaveBeenCalled();
    expect(probe.setMaxTokens).not.toHaveBeenCalled();
  });

  it('幂等：同一真源重复调用产生同样终态（下拉切换与配置监听双执行的前提）', async () => {
    const probe = agentProbe();
    const { deps } = makeDeps({ getAgent: () => probe.agent });

    await refreshActiveProvider(deps);
    await refreshActiveProvider(deps);

    // 两次都各注入一次（不引入「我刚做过」的抑制状态），但终态一致
    expect(probe.setProvider).toHaveBeenCalledTimes(2);
    expect(probe.setContextWindow.mock.calls[0]).toEqual(probe.setContextWindow.mock.calls[1]);
  });
});
