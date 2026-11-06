/**
 * settingsPanel `security_toggle` 路由测试
 *
 * 2026-11-06（E4 批 4）写入二次确认退役：写文件一律直接落盘，协议里的 `target` 字段
 * 随双开关一起删除，本通道只剩「执行确认」一个语义。
 *
 * 覆盖被测不变量：
 *   ① `security_toggle` → 持久化 CONFIRM_SCRIPTS_KEY + 热更新 `setConfirmScripts`；
 *   ② 写入确认无任何宿主通道（`setConfirmWrites` 永远不会被本通道触碰）；
 *   ③ 回推 `security_status` 只含 `confirmScripts`（协议面残留 confirmWrites 即双源）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@zooique/memora';
import { MemoraSettingsPanel } from '../panels/settingsPanel.js';
import { CONFIRM_SCRIPTS_KEY } from '../../shared/constants.js';

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

/** agent 桩：只暴露 security 热更新入口 + 事件订阅空实现（ensureAgent 绑定用） */
function agentStub(): {
  agent: Agent;
  setConfirmWrites: ReturnType<typeof vi.fn>;
  setConfirmScripts: ReturnType<typeof vi.fn>;
} {
  const setConfirmWrites = vi.fn();
  const setConfirmScripts = vi.fn();
  const agent = {
    security: { setConfirmWrites, setConfirmScripts },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Agent;
  return { agent, setConfirmWrites, setConfirmScripts };
}

function setup(agent: Agent): {
  provider: MemoraSettingsPanel;
  posted: { type: string; level?: string; message?: string }[];
  globalUpdate: ReturnType<typeof vi.fn>;
  factory: ReturnType<typeof vi.fn>;
} {
  const posted: { type: string; level?: string; message?: string }[] = [];
  const globalUpdate = vi.fn();
  // provider 第二参 = LLM 配置 store：ready 握手会触发 loadConfig，缺面即 unhandled rejection
  // （本文件只测安全开关与 MCP 推送，store 给最小可满足面即可）
  const store = {
    listMasked: async () => [],
    getActiveName: () => '',
    getBackgroundName: () => '',
  };
  const provider = new MemoraSettingsPanel({} as never, store as never);
  // 工厂包一层 spy：未装配路径的「接入」是否真的触发装配只能从这里看见（装配是宿主生命周期）
  const factory = vi.fn(async () => agent);
  provider.setAgentFactory(factory);
  provider.setGlobalState({ get: () => undefined, update: globalUpdate } as never);
  (provider as unknown as { _panel: unknown })._panel = {
    webview: {
      postMessage: (msg: never) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
  };
  return { provider, posted, globalUpdate, factory };
}

/** 经 handleMessage 路由发 security_toggle（测全链：消息分支 → toggleConfirmScripts） */
function sendSecurityToggle(provider: MemoraSettingsPanel, enabled: boolean): Promise<void> {
  return (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
    type: 'security_toggle',
    enabled,
  });
}

describe('settingsPanel 安全开关（只剩执行确认一个语义）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('security_toggle → 持久化 + 热更新执行确认；写入确认无任何通道', async () => {
    const { agent, setConfirmWrites, setConfirmScripts } = agentStub();
    const { provider, posted, globalUpdate } = setup(agent);

    await sendSecurityToggle(provider, true);

    expect(globalUpdate).toHaveBeenCalledWith(CONFIRM_SCRIPTS_KEY, true);
    expect(setConfirmScripts).toHaveBeenCalledWith(true);
    // 写入确认已退役：本通道绝不能回退成「顺手也改写入」
    expect(setConfirmWrites).not.toHaveBeenCalled();
    // 协议面只剩执行确认一项
    expect(posted).toContainEqual({ type: 'security_status', confirmScripts: true });
  });
});

describe('settingsPanel ready 握手 → MCP 状态首屏推送（无独立拉取消息后的唯一初始通路）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ready 分支调用 pushMcpStatus（断链则 MCP 页永远停在「加载中…」，且无测试会红）', async () => {
    const { agent } = agentStub();
    const { provider, posted } = setup(agent);
    const spy = vi.spyOn(provider, 'pushMcpStatus');

    await (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
      type: 'ready',
    });

    expect(spy).toHaveBeenCalled();
    // 未装配 Agent ⇒ 运行时快照为空 ⇒ 合法空态（面板按空态文案渲染，不报错）。
    // omitted 必带：它是「配置里有、列表里没有」的那部分，缺了面板会少说一句话
    expect(posted).toContainEqual({
      type: 'mcp_status',
      servers: [],
      omitted: { configured: 0, missingName: 0, duplicate: 0 },
    });
  });
});

/**
 * `mcp_write/connect` → 按当前配置让运行态追平（pending 卡片的唯一出路，面板侧的接线）
 *
 * 为什么必须测：追平分两步（未装配 → `ensureAgent()` 懒装配；已装配 → `reconcileMcpConfig`
 * 热更），`connect` 的语义全靠 `mcpOpsDeps().connect` 这一处接线把它接上。接错了（比如
 * 只接到 ensureAgent、把「已装配」当完成）**没有任何编译错**——用户点「接入」只会看到一个
 * 永远不动的「待接入」。
 */
describe('settingsPanel mcp_write/connect → 运行态追平接线', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未装配时点接入 ⇒ 触发一次 agent 工厂，并回推状态', async () => {
    const { agent } = agentStub();
    const { provider, posted, factory } = setup(agent);

    await (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
      type: 'mcp_write',
      op: 'connect',
      name: 'fs',
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(posted.some((msg) => msg.type === 'mcp_status')).toBe(true);
  });

  it('连点两次 ⇒ 每次都经唯一真源取用（面板不缓存实例）', async () => {
    const { agent } = agentStub();
    const { provider, factory } = setup(agent);
    const send = () =>
      (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
        type: 'mcp_write',
        op: 'connect',
        name: 'fs',
      });

    await send();
    await send();

    // SETTINGS-AGENT-STALE-1 方案 B：面板级缓存已删，每次动作都向登记表取用。
    // 「不来第二个运行时」由 `AgentRegistry` 的按会话复用保证（其单测覆盖）。
    expect(factory).toHaveBeenCalledTimes(2);
  });

  /**
   * 判据同源：pending = 「该名没进 applied」，接入 = 「按当前配置让它进 applied」。
   * 旧实现拿「Agent 是否装配过」当完成条件 ⇒ 已装配 + 工具执行器不可用时，按钮返回
   * 成功却什么都没做（面板纹丝不动）。⚠ 变异靶标：把 `connect` 的
   * `return result` 改成无条件 `return { ok: true }` ⇒ 本用例转红（收不到 error 回执）。
   */
  it('同一实例但工具执行器不可用 ⇒ 接入必须报真实失败（不能假动作）', async () => {
    const { agent } = agentStub();
    const { provider, posted, factory } = setup(agent);
    const send = () =>
      (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
        type: 'mcp_write',
        op: 'connect',
        name: 'fs',
      });

    await send();
    // 只看**第二次**（同一实例再次取用后）的回执：第一次未装配时的失败回执不能当作证据
    posted.length = 0;
    await send();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(posted.some((msg) => msg.type === 'notice' && msg.level === 'error')).toBe(true);
  });

  it('同一实例且工具执行器可用 ⇒ 接入走热更追平（不报错）', async () => {
    const { tools } = {
      tools: { registerTool: vi.fn(), removeTool: vi.fn(), listTools: () => [] },
    };
    const agent = { ...agentStub().agent, tools } as unknown as Agent;
    const { provider, posted, factory } = setup(agent);
    const send = () =>
      (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
        type: 'mcp_write',
        op: 'connect',
        name: 'fs',
      });

    await send();
    await send();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(posted.some((msg) => msg.type === 'notice' && msg.level === 'error')).toBe(false);
  });
});
