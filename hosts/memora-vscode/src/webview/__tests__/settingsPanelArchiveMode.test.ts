/**
 * settingsPanel 会话归档模式链路测试（2026-10-16 setArchiveMode 接线）
 *
 * 覆盖被测不变量（对齐 security_toggle / setAllowedPaths 的「持久化 + 热更新 + 回推」三段式）：
 *   ① 合法枚举（full / manual）→ 持久化用户级设置 memora.archiveMode（Global）
 *      + 热更新 agent.setArchiveMode + 回推 archive_mode_status + info 提示；
 *   ② 非法枚举 → 整体拒绝（不落盘 / 不热更新 / 不回推——不依赖 webview 下拉收敛，
 *      直接发消息的越界值照拒，与服务端校验同一条纪律）；
 *   ③ 对话繁忙（内核 assertNotBusy 抛错）→ **偏好仍落盘**（装配期读取）+ 回推 status
 *      + info 级顺延提示——不得谎报「已生效」，也不得把「用户偏好已保存」显示成红色错误；
 *   ④ loadArchiveModeStatus：ready 握手回推的真相源 = 用户级设置（缺省 full）。
 *
 * ⚠ 变异验证靶标：撤掉 setArchiveMode 里的 config.update → 「持久化」断言转红；
 * 撤掉 agent.setArchiveMode 调用 → 「热更新」断言转红；把繁忙 catch 改成回滚偏好
 * → 「偏好仍落盘」断言转红（那会让保存过的偏好下次装配又变回去）；把 `applied` 初值
 * 改回 true（或删掉 agent 未就绪的降级提示）→「Agent 未就绪」用例转红（假成功回归锚点）；
 * 撤掉拒收分支的 loadArchiveModeStatus() → 「复位下拉」断言转红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@zooique/memora';
import { MemoraSettingsViewProvider } from '../panels/settingsPanel.js';

// 可观测的 workspace 配置 mock（vi.hoisted：vi.mock 工厂提升到顶部，闭包外变量须先提升）。
// 基座实现忠实于 VS Code API：get(key, defaultValue) 未配置时回落默认值——
// 早期版本 mock 恒返回 undefined，「缺省回落」用例会假红（harness 保真度问题，非实现缺陷）。
const vscodeConfigMock = vi.hoisted(() => ({
  cfgGet: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
  cfgUpdate: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'mock://uri' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: vscodeConfigMock.cfgGet,
      update: vscodeConfigMock.cfgUpdate,
    })),
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

/** agent 桩：只暴露 setArchiveMode 热更新入口 + 事件订阅空实现（ensureAgent 绑定用） */
function agentStub(onSetArchiveMode?: () => void): {
  agent: Agent;
  setArchiveMode: ReturnType<typeof vi.fn>;
} {
  const setArchiveMode = vi.fn(onSetArchiveMode ?? (() => {}));
  const agent = {
    setArchiveMode,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Agent;
  return { agent, setArchiveMode };
}

/** 构造 provider + 记录 postMessage 的 posted 数组（复刻 settingsPanelRoles 的 harness） */
function setup(agent: Agent): {
  provider: MemoraSettingsViewProvider;
  posted: { type: string; level?: string; message?: string }[];
} {
  const posted: { type: string; level?: string; message?: string }[] = [];
  const provider = new MemoraSettingsViewProvider({} as never, {} as never);
  provider.setAgentFactory(async () => agent);
  provider.setGlobalState({ get: () => undefined, update: vi.fn() } as never);
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      postMessage: (msg: never) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
  };
  return { provider, posted };
}

/** 经 handleMessage 路由发 archive_mode_set（测全链：消息分支 → setArchiveMode） */
function sendArchiveModeSet(provider: MemoraSettingsViewProvider, mode: string): Promise<void> {
  return (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
    type: 'archive_mode_set',
    mode,
  });
}

/** 取 notice 消息 */
function notices(posted: { type: string; level?: string; message?: string }[]) {
  return posted.filter((m) => m.type === 'notice');
}

describe('settingsPanel.setArchiveMode —— 归档模式切换', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 恢复基座实现（clearAllMocks 不清实现；各用例按需 mockImplementation 覆盖）
    vscodeConfigMock.cfgGet.mockImplementation(
      (_key: string, defaultValue?: unknown) => defaultValue,
    );
  });

  it('合法模式 manual → 持久化用户级设置 + 热更新 agent + 回推 status + info 提示', async () => {
    const { agent, setArchiveMode } = agentStub();
    const { provider, posted } = setup(agent);

    await sendArchiveModeSet(provider, 'manual');

    // 持久化：用户级设置（ConfigurationTarget.Global = mock 里的 1）
    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith('archiveMode', 'manual', 1);
    // 热更新：运行时切换（内核 setArchiveMode，繁忙时抛错走下方顺延用例）
    expect(setArchiveMode).toHaveBeenCalledWith('manual');
    // 回推：下拉回显真源（持久值口径）
    expect(posted).toContainEqual({ type: 'archive_mode_status', mode: 'manual' });
    const msgs = notices(posted);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.level).toBe('info');
    expect(msgs[0]?.message).toContain('仅手动归档');
  });

  it('合法模式 full → 同样走通（枚举全集覆盖，非仅测新值）', async () => {
    const { agent, setArchiveMode } = agentStub();
    const { provider, posted } = setup(agent);

    await sendArchiveModeSet(provider, 'full');

    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith('archiveMode', 'full', 1);
    expect(setArchiveMode).toHaveBeenCalledWith('full');
    expect(posted).toContainEqual({ type: 'archive_mode_status', mode: 'full' });
    expect(notices(posted)[0]?.message).toContain('自动归档');
  });

  it('非法枚举 → 整体拒绝（不落盘 / 不热更新）+ 回推持久值复位下拉', async () => {
    const { agent, setArchiveMode } = agentStub();
    const { provider, posted } = setup(agent);

    await sendArchiveModeSet(provider, 'evil');

    expect(vscodeConfigMock.cfgUpdate).not.toHaveBeenCalled();
    expect(setArchiveMode).not.toHaveBeenCalled();
    // 回推持久值（未配置 → 缺省 full）：下拉已被改到非法值，不回推就停在假值上（UI 谎报）
    expect(posted).toContainEqual({ type: 'archive_mode_status', mode: 'full' });
    const msgs = notices(posted);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.level).toBe('error');
    expect(msgs[0]?.message).toContain('无效的归档模式');
  });

  it('对话繁忙（内核 assertNotBusy 抛错）→ 偏好仍落盘 + status 回推 + info 顺延提示', async () => {
    // 内核 setArchiveMode 在 chatLockManager.isBusy 时抛 chatBusyError（MemoraError）
    const { agent, setArchiveMode } = agentStub(() => {
      throw new Error('对话繁忙：切换归档模式需等待当前对话结束');
    });
    const { provider, posted } = setup(agent);

    await sendArchiveModeSet(provider, 'manual');

    // 偏好先落盘（装配期读取）——运行时顺延，不回滚（回滚=保存过的偏好下次装配又变回去）
    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith('archiveMode', 'manual', 1);
    expect(setArchiveMode).toHaveBeenCalledWith('manual');
    // 回推 + 顺延提示：info 级（偏好保存成功，只是运行时没切）——不得谎报「已生效」，
    // 也不得渲染成红色错误（用户主动保存偏好不是故障）
    expect(posted).toContainEqual({ type: 'archive_mode_status', mode: 'manual' });
    const msgs = notices(posted);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.level).toBe('info');
    expect(msgs[0]?.message).toContain('偏好已保存');
    expect(msgs[0]?.message).toContain('对话结束后生效');
  });

  it('Agent 未就绪 → 偏好仍落盘 + status 回推，但不得推「已切换」成功提示（假成功回归锚点）', async () => {
    // ensureAgent 的三条 undefined 出口之一（装配工厂返回空）：运行时零动作、无补应用载体。
    // 变异靶标：把 applied 初值改回 true（或把降级提示删掉）→ 本例转红。
    const { provider, posted } = setup(undefined as unknown as Agent);

    await sendArchiveModeSet(provider, 'manual');

    // 偏好照旧落盘（装配期读取）+ 回推持久值（下拉反映偏好）
    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith('archiveMode', 'manual', 1);
    expect(posted).toContainEqual({ type: 'archive_mode_status', mode: 'manual' });
    const msgs = notices(posted);
    expect(msgs).toHaveLength(1);
    // error 级降级提示，绝不出现「已切换归档模式」——那会让用户以为运行时已生效
    expect(msgs[0]?.level).toBe('error');
    expect(msgs.some((m) => m.message?.includes('已切换归档模式'))).toBe(false);
  });

  it('loadArchiveModeStatus：回推真相源 = 用户级设置（读到的值原样推送）', async () => {
    vscodeConfigMock.cfgGet.mockImplementation((key: string) =>
      key === 'archiveMode' ? 'manual' : undefined,
    );
    const { provider, posted } = setup(agentStub().agent);

    (provider as unknown as { loadArchiveModeStatus(): void }).loadArchiveModeStatus();

    expect(posted).toContainEqual({ type: 'archive_mode_status', mode: 'manual' });
  });

  it('loadArchiveModeStatus 缺省 → full（配置未写时回落，与 package.json default 同口径）', async () => {
    // 基座 mock 忠实 VS Code API：get('archiveMode', 'full') 未配置 → 回落 'full'
    const { provider, posted } = setup(agentStub().agent);

    (provider as unknown as { loadArchiveModeStatus(): void }).loadArchiveModeStatus();

    expect(vscodeConfigMock.cfgGet).toHaveBeenCalledWith('archiveMode', 'full');
    expect(posted).toContainEqual({ type: 'archive_mode_status', mode: 'full' });
  });
});
