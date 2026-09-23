/**
 * settingsPanel 角色切换失败判定回归测试
 *
 * 被测不变量：`activateRole` 在 `agent.switchRolePack()` 返回 false 时，**必须**用内核公开判据
 * `agent.getRolePackSwitchLockStatus().locked` 区分失败成因，不得由「未收到 rolePackSwitchLocked
 * 事件」推断「角色包不存在」。
 *
 * 判据依据：内核 `RolePackManager.activate()` 仅在**触发锁定**的那一次切换发射
 * onSwitchLocked（该次返回 **true**）；被锁期间的后续切换在 L879-882 直接 `return false` 且
 * **不发射任何事件**。故若以 `ok===false && !_lockedNoticeShown` 判定为"不存在"，
 * 会在锁定期内点击「设为当前」时弹出假错误「角色包不存在：X」（角色包其实存在）（坑）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { MemoraSettingsViewProvider } from '../panels/settingsPanel.js';

// 可观测的 workspace 配置 mock（vi.hoisted：vi.mock 工厂被提升到文件顶部，闭包外变量
// 必须先提升声明，否则工厂内引用报错）。get/update 供 toggleSkillDisabled 用例断言。
const vscodeConfigMock = vi.hoisted(() => ({
  cfgGet: vi.fn(() => undefined),
  cfgUpdate: vi.fn(),
}));

// mock vscode：仅提供 settingsPanel 及其依赖在加载/构造期用到的最小 API
vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'mock://uri' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vscodeConfigMock.cfgGet, update: vscodeConfigMock.cfgUpdate })),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1 },
}));

/** agent 桩：只暴露 activateRole 依赖的切换入口 + 锁定状态判据 + 事件订阅空实现 */
function agentStub(opts: { switchOk: boolean; locked: boolean; unlockAt?: number | null }): {
  agent: Agent;
  switchRolePack: ReturnType<typeof vi.fn>;
  getRolePackSwitchLockStatus: ReturnType<typeof vi.fn>;
} {
  const switchRolePack = vi.fn(() => opts.switchOk);
  const getRolePackSwitchLockStatus = vi.fn(() => ({
    locked: opts.locked,
    unlockAt: opts.unlockAt ?? null,
  }));
  const agent = {
    switchRolePack,
    getRolePackSwitchLockStatus,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Agent;
  return { agent, switchRolePack, getRolePackSwitchLockStatus };
}

/** 构造 provider + 记录 postMessage 的 posted 数组 */
function setup(agent: Agent): {
  provider: MemoraSettingsViewProvider;
  posted: { type: string; level?: string; message?: string }[];
  globalUpdate: ReturnType<typeof vi.fn>;
} {
  const posted: { type: string; level?: string; message?: string }[] = [];
  const globalUpdate = vi.fn();
  const provider = new MemoraSettingsViewProvider({} as never, {} as never);
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

/** 调私有 activateRole */
function activateRole(provider: MemoraSettingsViewProvider, name: string): Promise<boolean> {
  return (provider as unknown as { activateRole(n: string): Promise<boolean> }).activateRole(name);
}

/** 取 notice 消息（过滤掉非 notice 推送） */
function notices(posted: { type: string; level?: string; message?: string }[]) {
  return posted.filter((m) => m.type === 'notice');
}

describe('settingsPanel.activateRole —— 切换失败两成因判定', () => {
  let agent: Agent;
  let switchRolePack: ReturnType<typeof vi.fn>;
  let getRolePackSwitchLockStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('角色包不存在（未锁）→ 返回 false 且弹「角色包不存在」错误提示', async () => {
    ({ agent, switchRolePack, getRolePackSwitchLockStatus } = agentStub({
      switchOk: false,
      locked: false,
    }));
    const { provider, posted } = setup(agent);

    const ok = await activateRole(provider, 'ghost');

    expect(ok).toBe(false);
    expect(switchRolePack).toHaveBeenCalledWith('ghost');
    // 未锁 → 必须查询锁定判据后才能断定"不存在"
    expect(getRolePackSwitchLockStatus).toHaveBeenCalled();
    expect(notices(posted)).toEqual([
      { type: 'notice', level: 'error', message: '角色包不存在：ghost' },
    ]);
  });

  it('切换被限流锁定（角色包存在）→ 弹限流提示，不弹「角色包不存在」', async () => {
    const unlockAt = Date.now() + 90_000;
    ({ agent, switchRolePack, getRolePackSwitchLockStatus } = agentStub({
      switchOk: false,
      locked: true,
      unlockAt,
    }));
    const { provider, posted } = setup(agent);

    const ok = await activateRole(provider, 'existing-pack');

    expect(ok).toBe(false);
    expect(switchRolePack).toHaveBeenCalledWith('existing-pack');
    expect(getRolePackSwitchLockStatus).toHaveBeenCalled();
    const msgs = notices(posted);
    expect(msgs).toHaveLength(1);
    // 不得出现假错误「角色包不存在」
    expect(msgs[0]?.level).toBe('info');
    expect(msgs[0]?.message).not.toContain('不存在');
    expect(msgs[0]?.message).toContain('锁定');
    expect(msgs[0]?.message).toContain('秒后再试');
  });

  it('切换被锁定但 unlockAt 缺失 → 退化为不含秒数的锁定提示（不误报不存在）', async () => {
    ({ agent, switchRolePack, getRolePackSwitchLockStatus } = agentStub({
      switchOk: false,
      locked: true,
      unlockAt: null,
    }));
    const { provider, posted } = setup(agent);

    await activateRole(provider, 'existing-pack');

    const msgs = notices(posted);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.level).toBe('info');
    expect(msgs[0]?.message).toBe('角色包切换已被限流锁定，请稍后再试');
  });

  it('切换成功 → 持久化激活角色包名 + 不弹任何 notice', async () => {
    ({ agent, switchRolePack, getRolePackSwitchLockStatus } = agentStub({
      switchOk: true,
      locked: false,
    }));
    const { provider, posted, globalUpdate } = setup(agent);

    const ok = await activateRole(provider, 'writer');

    expect(ok).toBe(true);
    expect(globalUpdate).toHaveBeenCalledWith('memora.activeRolePack', 'writer');
    expect(notices(posted)).toEqual([]);
    // 成功路径不需要查询锁定判据
    expect(getRolePackSwitchLockStatus).not.toHaveBeenCalled();
  });
});

describe('settingsPanel.toggleSkillDisabled —— 技能启停开关', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 调私有 toggleSkillDisabled */
  function handleToggle(provider: MemoraSettingsViewProvider, name: string, disabled: boolean): Promise<void> {
    return (provider as unknown as { toggleSkillDisabled(n: string, d: boolean): Promise<void> }).toggleSkillDisabled(
      name,
      disabled,
    );
  }

  it('禁用：以内核生效集为基补名，整组写回 memora.disabledSkills（ConfigurationTarget.Global）', async () => {
    const agent = {
      skills: { disabledSkillNames: ['a'] },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Agent;
    const { provider, posted } = setup(agent);

    await handleToggle(provider, 'b', true);

    // 基数 = 内核生效集（不重读宿主配置副本），禁用 = 补名后整组写回
    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith('disabledSkills', ['a', 'b'], vscode.ConfigurationTarget.Global);
    expect(notices(posted)).toEqual([{ type: 'notice', level: 'info', message: '已禁用技能「b」' }]);
  });

  it('启用：从生效集中移名后整组写回', async () => {
    const agent = {
      skills: { disabledSkillNames: ['a', 'b'] },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Agent;
    const { provider, posted } = setup(agent);

    await handleToggle(provider, 'b', false);

    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith('disabledSkills', ['a'], vscode.ConfigurationTarget.Global);
    expect(notices(posted)).toEqual([{ type: 'notice', level: 'info', message: '已启用技能「b」' }]);
  });

  it('Agent 未装配（无 skills）→ 拒绝并提示错误，不写配置', async () => {
    const agent = { on: vi.fn(), off: vi.fn() } as unknown as Agent;
    const { provider, posted } = setup(agent);

    await handleToggle(provider, 'b', true);

    expect(vscodeConfigMock.cfgUpdate).not.toHaveBeenCalled();
    expect(notices(posted)).toEqual([{ type: 'notice', level: 'error', message: 'Agent 未就绪，无法切换技能禁用状态' }]);
  });
});
