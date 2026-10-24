/**
 * settingsPanel `security_toggle` 路由测试（2026-10-24 协议治理：两通道合并后的 target 分流）
 *
 * 覆盖被测不变量：
 *   ① `target: 'confirmWrites'` → 持久化 CONFIRM_WRITES_KEY + 热更新
 *      `agent.security.setConfirmWrites`，**不**碰 setConfirmScripts；
 *   ② `target: 'confirmScripts'` → 持久化 CONFIRM_SCRIPTS_KEY + 热更新
 *      `agent.security.setConfirmScripts`，**不**碰 setConfirmWrites；
 *   ③ 两个分支各自回推 security_status（另一开关沿用持久值，保持双开关显示一致）。
 *
 * 为什么必须测（不带伤自证）：合并前分流由「消息类型」天然完成（open 两条通道各走各的
 * 分支）；合并后分流由本处的 `msg.target` 判断完成——**这是新写的路由逻辑**，写反了
 * （confirmWrites 调 setConfirmScripts）不会有任何编译错，只会表现为「勾写入却改了脚本
 * 确认」。⚠ 变异靶标：把两个分支对调 ⇒ 用例 ①② 同时转红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@zooique/memora';
import { MemoraSettingsViewProvider } from '../panels/settingsPanel.js';
import { CONFIRM_SCRIPTS_KEY, CONFIRM_WRITES_KEY } from '../../shared/constants.js';

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

/** agent 桩：只暴露 security 双热更新入口 + 事件订阅空实现（ensureAgent 绑定用） */
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
  provider: MemoraSettingsViewProvider;
  posted: { type: string; level?: string; message?: string }[];
  globalUpdate: ReturnType<typeof vi.fn>;
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
  const provider = new MemoraSettingsViewProvider({} as never, store as never);
  provider.setAgentFactory(async () => agent);
  provider.setGlobalState({ get: () => undefined, update: globalUpdate } as never);
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      postMessage: (msg: never) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
  };
  return { provider, posted, globalUpdate };
}

/** 经 handleMessage 路由发 security_toggle（测全链：消息分支 → target 分流 → 具体 toggle） */
function sendSecurityToggle(
  provider: MemoraSettingsViewProvider,
  target: string,
  enabled: boolean,
): Promise<void> {
  return (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
    type: 'security_toggle',
    target,
    enabled,
  });
}

describe('settingsPanel 安全开关 target 路由（协议合并后的唯一分流点）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('target=confirmWrites → 只动写入确认（持久化 + 热更新），不碰脚本开关', async () => {
    const { agent, setConfirmWrites, setConfirmScripts } = agentStub();
    const { provider, posted, globalUpdate } = setup(agent);

    await sendSecurityToggle(provider, 'confirmWrites', true);

    expect(globalUpdate).toHaveBeenCalledWith(CONFIRM_WRITES_KEY, true);
    expect(setConfirmWrites).toHaveBeenCalledWith(true);
    expect(setConfirmScripts).not.toHaveBeenCalled();
    // 回推双开关状态：另一开关沿用持久值（未配置 → false）
    expect(posted).toContainEqual({
      type: 'security_status',
      confirmWrites: true,
      confirmScripts: false,
    });
  });

  it('target=confirmScripts → 只动脚本确认（持久化 + 热更新），不碰写入开关', async () => {
    const { agent, setConfirmWrites, setConfirmScripts } = agentStub();
    const { provider, posted, globalUpdate } = setup(agent);

    await sendSecurityToggle(provider, 'confirmScripts', true);

    expect(globalUpdate).toHaveBeenCalledWith(CONFIRM_SCRIPTS_KEY, true);
    expect(setConfirmScripts).toHaveBeenCalledWith(true);
    expect(setConfirmWrites).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'security_status',
      confirmWrites: false,
      confirmScripts: true,
    });
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
    // 未装配 Agent ⇒ 运行时快照为空 ⇒ 合法空态（面板按空态文案渲染，不报错）
    expect(posted).toContainEqual({ type: 'mcp_status', servers: [] });
  });
});
