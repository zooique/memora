/**
 * HOST-BUG-1 真机首装缺陷回归测试：装配失败可重试 + 配置变更重试入口
 *
 * 背景（2026-10-12 新电脑真机实测）：新装机未配置 LLM → 首开面板装配 throw →
 * `performAgentAssembly` 的 catch 吞错但**不重置 `_agentReady`** ⇒ Promise 缓存成
 * 「已 settle 但 `_agent` 仍 null」的僵尸，后续 `ensureAgent()` 永远 await 它、
 * 永不重试——配置好 LLM 后插件仍不可用，只能重启。
 *
 * 覆盖：
 *   ① 失败后 `_agentReady` 必须重置（僵尸回归守卫，对照 extension.ts / settingsPanel 两对照组）；
 *   ② 再次 `ensureAgent` 真正重启装配（工厂被二次调用）；
 *   ③ `retryAgentAssembly`（extension.ts 配置变更监听的调用入口）三态分流：
 *      已装配（**IMG-5 起改为「刷新派生副本」而非跳过**）/ 装配在途 / 面板未开——
 *      以及失败态 + 面板在时的重试成功。
 *
 * ⚠️ 未覆盖面（如实登记）：extension.ts 的 `onDidChangeConfiguration` 判据扩展
 * （`memora.providers` / `memora.activeProvider`）属零测试覆盖区，走兜底链
 * （tsc + eslint + 重建 dist 实读产物），测试不能当该段的闭环证明。
 *
 * 替身策略：agent 桩 + `setAgentFactory` + cast 调私有方法，
 * 与 chatPanelHistory（懒装配用例）/ chatPanelBackground 既有模式一致。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
// 临时目录统一入口：建目录 + 模块顶层注册清理（禁止裸 mkdtempSync，见 helpers/tmpDir.ts）
import { makeTempDir } from '../../__tests__/helpers/tmpDir.js';
import type { Agent } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

// mock vscode：chatPanel 装配链最小 API（与 chatPanelHistory 同款）
vi.mock('vscode', async () => {
  const uri = {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    fsPath: '/mock/path',
  };
  return {
    Uri: uri,
    window: {
      showInputBox: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
      // 活动文件 chip 的两条 workspace 侧订阅（同文件被编辑 / 保存翻 isDirty）：
      // resolveWebviewView 装配时注册，替身缺任一条即 TypeError——不是可选事件
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };
});

import * as vscode from 'vscode';

/** 装配相关私有/公开成员的 cast 形状（测试经此驱动，不改生产可见性） */
interface AssemblyCast {
  ensureAgent(): Promise<void>;
  retryAgentAssembly(): Promise<void>;
  _agent: Agent | null;
  _view: unknown;
  _agentReady: Promise<void> | null;
  _agentResolving: boolean;
  _providerStale: boolean;
}

/** setup 返回形状 */
interface AssemblyFixture {
  provider: MemoraChatViewProvider;
  cast: AssemblyCast;
}

/**
 * 构造最小测试夹具：临时目录双 store + providerStore 桩 + provider
 * （与 chatPanelHistory.setup 同构；webviewView 按需手动注入——
 *  「面板是否打开」是被测判据之一，不能在 setup 里一刀切设死）
 *
 * @param activeConfig 传入则 `getActive()` 返回它（IMG-5 热刷新用例需要「有激活配置」态）
 */
function setup(activeConfig?: Record<string, unknown>): AssemblyFixture {
  const dir = makeTempDir('memora-assembly-');
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  // providerStore 桩：listMasked / getActiveName / getActive（装配后补推链 + IMG-5 热刷新消费）
  const providerStore = {
    listMasked: async () => [],
    getActiveName: () => undefined,
    getActive: async () => activeConfig,
  } as never;
  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    providerStore,
    '/mock/workspace',
  );
  const cast = provider as unknown as AssemblyCast;
  return { provider, cast };
}

/** 注入「面板已打开」视图桩（postMessage 静默记录） */
function attachView(cast: AssemblyCast): unknown[] {
  const posted: unknown[] = [];
  const webviewView = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      options: {},
      html: '',
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
    onDidReceiveMessage: () => ({ dispose: () => {} }),
  } as never;
  cast._view = webviewView;
  return posted;
}

/** 装配成功链最小 agent 桩（chatPanelHistory 懒装配用例同款：on/off/getMetrics）
 *  + IMG-5 热刷新的三连注入方法（默认成功，按需在用例里覆盖实现） */
function agentStub(): Agent {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getMetrics: () => ({ context: { occupancy: { rolePackBaseTokens: 0 } } }),
    setProvider: vi.fn(),
    setContextWindow: vi.fn(),
    setMaxTokens: vi.fn(),
  } as unknown as Agent;
}

/** 取 agent 桩上的某个 spy（避免在断言处散落 cast） */
function spyOf(
  agent: Agent,
  key: 'setProvider' | 'setContextWindow' | 'setMaxTokens',
): ReturnType<typeof vi.fn> {
  return (agent as unknown as Record<string, ReturnType<typeof vi.fn>>)[key]!;
}

describe('HOST-BUG-1 · 装配失败可重试（僵尸 Promise 回归守卫）', () => {
  it('失败后 _agentReady 被重置为 null（catch 不吞缓存——两对照组均有、chatPanel 曾独缺）', async () => {
    const { provider, cast } = setup();
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('缺少 LLM 配置'))
      .mockResolvedValueOnce(agentStub());
    provider.setAgentFactory(factory);

    await cast.ensureAgent();

    // 失败被 catch 消化（不抛给调用方），但缓存必须清掉
    expect(cast._agent).toBeFalsy();
    expect(cast._agentReady).toBeNull();
    expect(cast._agentResolving).toBe(false);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('失败后再次 ensureAgent 真正重启装配（工厂二次调用、_agent 注入成功）', async () => {
    const { provider, cast } = setup();
    const agent = agentStub();
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('缺少 LLM 配置'))
      .mockResolvedValueOnce(agent);
    provider.setAgentFactory(factory);

    await cast.ensureAgent(); // 首装失败（新装机缺配置）
    await cast.ensureAgent(); // 配置补全后重试

    // 核心：工厂被调 2 次 = 没有 await 僵尸；agent 已注入 = 装配真正完成
    expect(factory).toHaveBeenCalledTimes(2);
    expect(cast._agent).toBe(agent);
  });

  it('装配成功后 ensureAgent 幂等：不再二次调用工厂', async () => {
    const { provider, cast } = setup();
    const agent = agentStub();
    const factory = vi.fn().mockResolvedValue(agent);
    provider.setAgentFactory(factory);

    await cast.ensureAgent();
    await cast.ensureAgent();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(cast._agent).toBe(agent);
  });
});

describe('HOST-BUG-1 · retryAgentAssembly（配置变更重试入口）', () => {
  it('失败态 + 面板在 → 重试装配成功（用户配置 LLM 后自动初始化的主路径）', async () => {
    const { provider, cast } = setup();
    attachView(cast);
    const agent = agentStub();
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('缺少 LLM 配置'))
      .mockResolvedValueOnce(agent);
    provider.setAgentFactory(factory);

    await cast.ensureAgent(); // 首装失败
    await cast.retryAgentAssembly(); // onDidChangeConfiguration → 本入口

    expect(factory).toHaveBeenCalledTimes(2);
    expect(cast._agent).toBe(agent);
  });

  it('已装配 → 不重复装配，但**走一次配置热刷新**（IMG-5：投影按真源重推）', async () => {
    const { provider, cast } = setup();
    const posted = attachView(cast);
    const factory = vi.fn().mockResolvedValue(agentStub());
    provider.setAgentFactory(factory);

    await cast.ensureAgent();
    const before = posted.length;
    await cast.retryAgentAssembly();

    // 不重建 agent（重建会打断会话）——旧实现的判据在此仍成立
    expect(factory).toHaveBeenCalledTimes(1);
    // 但必须走刷新：否则「已勾选 supportsVision 仍要 Reload」的缺陷复现。
    // 以投影重推为可观测证据（refresh 的所有出口都推 chat_providers）。
    const fresh = posted.slice(before) as Array<{ type: string }>;
    expect(fresh.some((m) => m.type === 'chat_providers')).toBe(true);
  });

  it('已装配 + 有激活配置 → 换新 provider 实例（能力位随真源更新，不必再 Reload）', async () => {
    const { provider, cast } = setup({
      name: 'p1',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: '',
      supportsVision: true,
    });
    attachView(cast);
    const agent = agentStub();
    provider.setAgentFactory(vi.fn().mockResolvedValue(agent));

    await cast.ensureAgent();
    await cast.retryAgentAssembly();

    // 核心判据：实例被换掉，且新实例的能力位来自真源（DTO supportsVision=true）
    expect(spyOf(agent, 'setProvider')).toHaveBeenCalledTimes(1);
    const next = spyOf(agent, 'setProvider').mock.calls[0]![0] as { supportsVision: boolean };
    expect(next.supportsVision).toBe(true);
    // 窗口与预算同链路同步（漏一项就会出现「模型换了、预算还是旧的」）
    expect(spyOf(agent, 'setContextWindow')).toHaveBeenCalledTimes(1);
    expect(spyOf(agent, 'setMaxTokens')).toHaveBeenCalledTimes(1);
    expect(cast._providerStale).toBe(false);
  });

  it('换实例被 assertNotBusy 拒 → 不谎报生效：置 _providerStale 等下次 send 前补做', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider, cast } = setup({
      name: 'p1',
      baseUrl: 'https://api.example.com/v1',
      model: 'm1',
      apiKey: '',
      supportsVision: true,
    });
    attachView(cast);
    const agent = agentStub();
    spyOf(agent, 'setProvider').mockImplementation(() => {
      throw new Error('对话进行中，无法切换 Provider');
    });
    provider.setAgentFactory(vi.fn().mockResolvedValue(agent));

    await cast.ensureAgent();
    await cast.retryAgentAssembly();

    // 配置已落盘（真源已变）但实例没换 ⇒ 必须留标记，不能假装成功
    expect(cast._providerStale).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('面板未打开（_view 空）→ 跳过（不为配置变更预装配，留给 resolveWebviewView）', async () => {
    const { provider, cast } = setup();
    const factory = vi.fn().mockResolvedValue(agentStub());
    provider.setAgentFactory(factory);

    await cast.retryAgentAssembly();

    expect(factory).not.toHaveBeenCalled();
    expect(cast._agent).toBeFalsy();
  });

  it('装配在途（_agentResolving）→ 跳过（不制造并行装配）', async () => {
    const { provider, cast } = setup();
    attachView(cast);
    const agent = agentStub();
    // 工厂挂起直到放行：装配停在途中的窗口内触发重试
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = vi.fn(async () => {
      await gate;
      return agent;
    });
    provider.setAgentFactory(factory);

    const inflight = cast.ensureAgent(); // 同步进入在途态（_agentResolving=true）
    await cast.retryAgentAssembly();

    expect(factory).toHaveBeenCalledTimes(1); // 入口未叠加第二次装配

    release();
    await inflight;
    expect(cast._agent).toBe(agent);
  });
});
