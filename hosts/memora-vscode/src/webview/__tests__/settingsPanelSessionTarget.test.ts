/**
 * settingsPanel 会话归属测试（SETTINGS-AGENT-STALE-1 方案 B 的机判）
 *
 * 不变量：面板**不缓存 Agent**——每次设置动作都向注入的取用面取「chat 面板当前显示会话」
 * 的实例。因此「A 显示 → 切 B」后，角色 / MCP / 记忆动作全部作用在 B，A 的实例零新增调用。
 *
 * 为什么必须测（不带伤自证）：会话归属由 extension 的 `resolveCommandSessionId` 解析；
 * 面板若再缓存一份实例（旧实现 `_agentPromise`），切会话后它会静默停在 A——设置页改的是
 * 已经不在显示的那个会话，**没有任何编译错**，也没有别的测试会红。
 *
 * ⚠ 变异靶标：在 ensureAgent 里恢复「第一次取到就存下来、之后复用」⇒ 三个用例同时转红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@zooique/memora';
import { MemoraSettingsPanel } from '../panels/settingsPanel.js';
import { restartMcpServer } from '../../extension/host/mcp/runtime.js';

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'mock://uri' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn() })),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1 },
  env: { language: 'zh-cn' },
}));

// MCP 运行时外置为 mock：只为看清「restart 拿到了哪台实例」，不复制其实现
vi.mock('../../extension/host/mcp/runtime.js', () => ({
  setMcpStatusListener: vi.fn(),
  getMcpServerStatus: vi.fn(() => ({
    servers: [],
    omitted: { configured: 0, missingName: 0, duplicate: 0 },
  })),
  reconcileMcpConfig: vi.fn(async () => ({ ok: true })),
  restartMcpServer: vi.fn(async () => ({ ok: true })),
}));

/** 会话实例桩（角色切换 / 记忆写入可观测；事件订阅为空实现，够 ensureAgent 绑定用） */
function agentStub(): {
  agent: Agent;
  switchRolePack: ReturnType<typeof vi.fn>;
  writeUpsert: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
} {
  const switchRolePack = vi.fn(() => true);
  const writeUpsert = vi.fn();
  const on = vi.fn();
  const off = vi.fn();
  // 记忆面只需满足 editMemory → loadMemory / loadGovernance 的最小读取契约
  const memory = {
    getById: (id: string) => ({ id, name: 'n', source: 's', content: 'old' }),
    writeUpsert,
    stats: () => ({ total: 0, bySource: {} }),
    list: () => [],
    listDeleted: () => [],
  };
  const agent = {
    switchRolePack,
    getRolePackSwitchLockStatus: () => ({ locked: false, unlockAt: null }),
    memory,
    on,
    off,
  } as unknown as Agent;
  return { agent, switchRolePack, writeUpsert, on, off };
}

/**
 * 装配面板 + 可切换的「当前显示会话」解析面
 *
 * `pick()` 就是 extension `getAgent` / `peekAgent` 的替身：真源 = chat 面板 `_currentSessionId`，
 * 此处用可变变量模拟「用户在面板里切了会话」这一事件。
 */
function setup() {
  const a = agentStub();
  const b = agentStub();
  /** 当前显示会话（模拟 chat 面板 `_currentSessionId`） */
  let current: 'a' | 'b' = 'a';
  const pick = (): Agent => (current === 'a' ? a.agent : b.agent);
  const getAgent = vi.fn(async () => pick());
  const peekAgent = vi.fn(() => pick());
  // provider 第二参 = LLM 配置 store（ready 握手会 loadConfig，给最小可满足面）
  const store = {
    listMasked: async () => [],
    getActiveName: () => '',
    getBackgroundName: () => '',
  };
  const provider = new MemoraSettingsPanel({} as never, store as never);
  provider.setAgentFactory(getAgent, peekAgent);
  provider.setGlobalState({ get: () => undefined, update: vi.fn() } as never);
  (provider as unknown as { _panel: unknown })._panel = {
    webview: { postMessage: async () => true },
  };
  const send = (msg: unknown) =>
    (provider as unknown as { handleMessage(m: unknown): Promise<void> }).handleMessage(msg);
  /** 模拟「用户把对话面板切到另一会话」 */
  const switchTo = (s: 'a' | 'b'): void => {
    current = s;
  };
  return { a, b, send, switchTo, getAgent, peekAgent };
}

describe('settingsPanel 会话归属（SETTINGS-AGENT-STALE-1 方案 B）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('角色切换：A 显示 → 切 B ⇒ 第二次作用在 B，A 零新增调用', async () => {
    const { a, b, send, switchTo } = setup();

    await send({ type: 'roles_set_active', name: 'r1' });
    expect(a.switchRolePack).toHaveBeenCalledWith('r1');

    switchTo('b');
    await send({ type: 'roles_set_active', name: 'r2' });

    expect(b.switchRolePack).toHaveBeenCalledWith('r2');
    // A 零新增调用：实例方法只被 A 显示时那一次触碰，切走后再取用也不碰它
    expect(a.switchRolePack).toHaveBeenCalledTimes(1);
    expect(a.on).toHaveBeenCalledTimes(2);
    expect(a.off).toHaveBeenCalledTimes(2);
    expect(b.on).toHaveBeenCalledTimes(2);
  });

  it('记忆操作：切到 B 后 edit 作用在 B 的 memory，A 的记忆零写入', async () => {
    const { a, b, send, switchTo } = setup();

    await send({ type: 'memory_edit', id: 'm1', content: '在 A 上编辑' });
    expect(a.writeUpsert).toHaveBeenCalledTimes(1);

    switchTo('b');
    await send({ type: 'memory_edit', id: 'm1', content: '在 B 上编辑' });

    expect(b.writeUpsert).toHaveBeenCalledTimes(1);
    expect(a.writeUpsert).toHaveBeenCalledTimes(1);
  });

  it('MCP restart：切到 B 后探视到 B 的实例，全程不触发装配', async () => {
    const { a, b, send, switchTo, getAgent, peekAgent } = setup();
    const restart = vi.mocked(restartMcpServer);

    await send({ type: 'mcp_write', op: 'restart', name: 'fs' });
    expect(restart).toHaveBeenLastCalledWith(a.agent, 'fs');

    switchTo('b');
    await send({ type: 'mcp_write', op: 'restart', name: 'fs' });

    expect(restart).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenLastCalledWith(b.agent, 'fs');
    // restart 只做同步探视（不懒装配）：装配入口零调用
    expect(peekAgent).toHaveBeenCalledTimes(2);
    expect(getAgent).toHaveBeenCalledTimes(0);
  });
});
