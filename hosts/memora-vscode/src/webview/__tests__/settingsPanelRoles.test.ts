/**
 * settingsPanel 角色包链路回归测试
 *
 * 覆盖两组被测不变量：
 *
 * 1. `activateRole` 切换失败两成因判定：`agent.switchRolePack()` 返回 false 时，**必须**用内核
 *    公开判据 `agent.getRolePackSwitchLockStatus().locked` 区分失败成因，不得由「未收到
 *    rolePackSwitchLocked 事件」推断「角色包不存在」。
 *    判据依据：内核 `RolePackManager.activate()` 仅在**触发锁定**的那一次切换发射
 *    onSwitchLocked（该次返回 **true**）；被锁期间的后续切换直接 `return false` 且不发射事件。
 *
 * 2. `roles_save` / `roles_detail` 保存链路（RP-EDIT-1，方案 §6-2/§6-3）：
 *    - 内置包真拒绝在 extension 侧（webview 隐藏编辑按钮只是呈现，直接发消息也必须被拒）；
 *    - 全量保真：只换 strategy 段，skills/displayName 等其余字段原样保留（禁整表重建）；
 *    - 校验失败不写盘（validateManifestText 报 error 即短路）；
 *    - 空 strategy = 删除该键（保持「未声明」语义，不固化空对象）；
 *    - 写盘后必须 rpm.reload()（装配缓存失效防线）；
 *    - 初值真源 = manifest 文件原文，roles_detail 读原文回发（非装配值）。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
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
}));

// mock node:fs/promises：保存链路（roles_detail 读原文 / roles_save 读原文+写盘）不触真实文件系统
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
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
  function handleToggle(
    provider: MemoraSettingsViewProvider,
    name: string,
    disabled: boolean,
  ): Promise<void> {
    return (
      provider as unknown as { toggleSkillDisabled(n: string, d: boolean): Promise<void> }
    ).toggleSkillDisabled(name, disabled);
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
    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith(
      'disabledSkills',
      ['a', 'b'],
      vscode.ConfigurationTarget.Global,
    );
    expect(notices(posted)).toEqual([
      { type: 'notice', level: 'info', message: '已禁用技能「b」' },
    ]);
  });

  it('启用：从生效集中移名后整组写回', async () => {
    const agent = {
      skills: { disabledSkillNames: ['a', 'b'] },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Agent;
    const { provider, posted } = setup(agent);

    await handleToggle(provider, 'b', false);

    expect(vscodeConfigMock.cfgUpdate).toHaveBeenCalledWith(
      'disabledSkills',
      ['a'],
      vscode.ConfigurationTarget.Global,
    );
    expect(notices(posted)).toEqual([
      { type: 'notice', level: 'info', message: '已启用技能「b」' },
    ]);
  });

  it('Agent 未装配（无 skills）→ 拒绝并提示错误，不写配置', async () => {
    const agent = { on: vi.fn(), off: vi.fn() } as unknown as Agent;
    const { provider, posted } = setup(agent);

    await handleToggle(provider, 'b', true);

    expect(vscodeConfigMock.cfgUpdate).not.toHaveBeenCalled();
    expect(notices(posted)).toEqual([
      { type: 'notice', level: 'error', message: 'Agent 未就绪，无法切换技能禁用状态' },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════
// roles_refresh —— 角色包刷新按钮（重扫用户角色包目录对账内核内存池）
// ══════════════════════════════════════════════════════════════

describe('settingsPanel.refreshRolePacks —— 角色包刷新链路', () => {
  const USER_DIR = '/mock/user-packs';

  /** 调私有 refreshRolePacks */
  function refresh(provider: MemoraSettingsViewProvider): Promise<void> {
    return (provider as unknown as { refreshRolePacks(): Promise<void> }).refreshRolePacks();
  }

  /** 取 notice 列表 */
  function notices(posted: { type: string; level?: string; message?: string }[]) {
    return posted.filter((m) => m.type === 'notice');
  }

  /** 构造带 rpm 桩的 provider（resyncUserPacks 返回值可注入；loadRoles 依赖面与幽灵对账测试同构） */
  function setup(resyncResult: {
    added: number;
    removed: string[];
    updated: string[];
    activeFallback: boolean;
  }): {
    provider: MemoraSettingsViewProvider;
    posted: { type: string; level?: string; message?: string }[];
    resync: ReturnType<typeof vi.fn>;
  } {
    const posted: { type: string; level?: string; message?: string }[] = [];
    const resync = vi.fn(async () => resyncResult);
    const agent = {
      on: vi.fn(),
      off: vi.fn(),
      rolePackManager: {
        resyncUserPacks: resync,
        listMeta: () => [{ name: 'memora助手' }],
        get: () => undefined,
        activeName: 'memora助手',
      },
    } as unknown as Agent;
    const provider = new MemoraSettingsViewProvider({} as never, {} as never);
    provider.setAgentFactory(async () => agent);
    provider.setGlobalState({ get: () => undefined, update: vi.fn() } as never);
    provider.setUserRolePacksDir(USER_DIR);
    (provider as unknown as { _view: unknown })._view = {
      webview: {
        postMessage: (msg: never) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
      },
    };
    return { provider, posted, resync };
  }

  it('刷新成功 → resync 以用户目录调用 + notice 净差对账结果 + roles_loaded 下发最新列表', async () => {
    const { provider, posted, resync } = setup({
      added: 1,
      removed: ['旧名包'],
      updated: [],
      activeFallback: false,
    });

    await refresh(provider);

    expect(resync).toHaveBeenCalledWith(USER_DIR);
    expect(notices(posted)).toEqual([
      { type: 'notice', level: 'info', message: '角色包已刷新：新增 1 个；移除 1 个（旧名包）' },
    ]);
    expect(posted.some((m) => m.type === 'roles_loaded')).toBe(true);
  });

  it('同名重注入 → notice 报「更新」不报新增/移除（净差语义，不谎报）', async () => {
    const { provider, posted } = setup({
      added: 0,
      removed: [],
      updated: ['用户打磨'],
      activeFallback: false,
    });

    await refresh(provider);

    expect(notices(posted)).toEqual([
      { type: 'notice', level: 'info', message: '角色包已刷新：更新 1 个（用户打磨）' },
    ]);
  });

  it('零变化 → notice 明示「无变化」（不输出空对账句）', async () => {
    const { provider, posted } = setup({
      added: 0,
      removed: [],
      updated: [],
      activeFallback: false,
    });

    await refresh(provider);

    expect(notices(posted)).toEqual([
      { type: 'notice', level: 'info', message: '角色包已刷新：无变化' },
    ]);
  });

  it('激活悬空 → notice 含兜底回退提示（文案与内核 §4.1 单链行为一致）', async () => {
    const { provider, posted } = setup({
      added: 0,
      removed: ['用户打磨'],
      updated: [],
      activeFallback: true,
    });

    await refresh(provider);

    const msgs = notices(posted);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.message).toContain('回退兜底角色包');
  });

  it('Agent 未装配（无 rolePackManager）→ 错误提示，不调 resync、不下发列表', async () => {
    const posted: { type: string; level?: string; message?: string }[] = [];
    const agent = { on: vi.fn(), off: vi.fn() } as unknown as Agent;
    const provider = new MemoraSettingsViewProvider({} as never, {} as never);
    provider.setAgentFactory(async () => agent);
    provider.setGlobalState({ get: () => undefined, update: vi.fn() } as never);
    provider.setUserRolePacksDir(USER_DIR);
    (provider as unknown as { _view: unknown })._view = {
      webview: {
        postMessage: (msg: never) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
      },
    };

    await refresh(provider);

    expect(notices(posted)).toEqual([
      { type: 'notice', level: 'error', message: '角色包系统未就绪，无法刷新' },
    ]);
    expect(posted.some((m) => m.type === 'roles_loaded')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// roles_save / roles_detail —— 角色策略保存链路（RP-EDIT-1）
// ══════════════════════════════════════════════════════════════

describe('settingsPanel.roles_save / roles_detail —— 角色策略保存链路（RP-EDIT-1）', () => {
  /** 用户角色包目录（来源判定锚：filePath 以此前缀开头 = user，否则 builtin） */
  const USER_DIR = '/mock/user-packs';

  /** 宽类型 posted：需读取 roles_detail_data / roles_loaded 的负载字段 */
  type Posted = { type: string } & Record<string, unknown>;

  /** readFile 读到的原文 fixture：skills + displayName 为「必须保真的其余字段」，strategy 为待替换段 */
  const RAW_MANIFEST = JSON.stringify({
    name: 'writer',
    displayName: '白话方案设计师',
    skills: [{ file: 'skills/write.md' }],
    strategy: { act: { temperature: 0.5 } },
  });

  /**
   * 构造带 rpm 桩的 provider。
   * pack 桩需带 meta/validationIssues/capabilities：保存成功后的 loadRoles 会逐包读取
   * meta.handoffPrompt / validationIssues 等字段（缺 meta 会 TypeError）。
   */
  function setupSave(filePath: string): {
    provider: MemoraSettingsViewProvider;
    posted: Posted[];
    reload: ReturnType<typeof vi.fn>;
  } {
    const posted: Posted[] = [];
    const reload = vi.fn(async () => {});
    // rpm 桩：get 供寻址、listMeta/activeName 供保存成功后的 loadRoles 刷新下发
    const rpm = {
      get: vi.fn(() => ({
        filePath,
        meta: {},
        validationIssues: [],
        capabilities: [],
      })),
      reload,
      listMeta: vi.fn(() => [{ name: 'writer' }]),
      activeName: 'writer',
    };
    const agent = { rolePackManager: rpm, on: vi.fn(), off: vi.fn() } as unknown as Agent;
    const provider = new MemoraSettingsViewProvider({} as never, {} as never);
    provider.setAgentFactory(async () => agent);
    provider.setGlobalState({ get: () => undefined, update: vi.fn() } as never);
    provider.setUserRolePacksDir(USER_DIR);
    (provider as unknown as { _view: unknown })._view = {
      webview: {
        postMessage: (msg: never) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
      },
    };
    return { provider, posted, reload };
  }

  /** 调私有 handleRolesSave */
  function save(
    provider: MemoraSettingsViewProvider,
    name: string,
    strategy: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    return (
      provider as unknown as {
        handleRolesSave(n: string, s: Record<string, Record<string, unknown>>): Promise<void>;
      }
    ).handleRolesSave(name, strategy);
  }

  /** 调私有 handleRolesDetail */
  function detail(provider: MemoraSettingsViewProvider, name: string): Promise<void> {
    return (
      provider as unknown as { handleRolesDetail(n: string): Promise<void> }
    ).handleRolesDetail(name);
  }

  /** 取 notice 列表（宽类型收窄为消息断言面） */
  function saveNotices(posted: Posted[]): { level?: string; message?: string }[] {
    return posted.filter((m) => m.type === 'notice') as { level?: string; message?: string }[];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  it('内置包保存 → extension 侧真拒绝：不读原文、不写盘、不 reload（变异 M1 锁）', async () => {
    const { provider, posted, reload } = setupSave('/mock/builtin/pack-a/manifest.json');

    await save(provider, 'pack-a', { act: { temperature: 0.8 } });

    // 三重拒绝：读原文都不发生（拒绝在链路最前），写盘与 reload 更不可能
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    const msgs = saveNotices(posted);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.level).toBe('error');
    expect(msgs[0]?.message).toContain('不可编辑');
  });

  it('用户包保存 → 全量保真：只换 strategy 段，其余字段保留 + 2 空格尾换行 + reload（变异 M2/M4 锁）', async () => {
    vi.mocked(readFile).mockResolvedValue(RAW_MANIFEST);
    const { provider, posted, reload } = setupSave(`${USER_DIR}/writer/manifest.json`);

    await save(provider, 'writer', { act: { temperature: 0.8 } });

    // 写盘内容：全量保真（skills/displayName 保留）+ strategy 替换 + 标准编排
    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1);
    const [path, text] = vi.mocked(writeFile).mock.calls[0]!;
    expect(path).toBe(`${USER_DIR}/writer/manifest.json`);
    expect(text).toMatch(/\n$/);
    expect(text).toContain('\n  "name"');
    const written = JSON.parse(text as string) as Record<string, unknown>;
    expect(written.displayName).toBe('白话方案设计师');
    expect(written.skills).toEqual([{ file: 'skills/write.md' }]);
    expect(written.strategy).toEqual({ act: { temperature: 0.8 } });

    // 装配缓存失效防线：写盘后必须 reload，下个 turn 才能用新配置
    expect(reload).toHaveBeenCalledTimes(1);

    // 回发链：roles_detail_data（弹窗回显新原文）+ roles_loaded（列表徽章刷新）+ notice info
    const detailMsg = posted.find((m) => m.type === 'roles_detail_data');
    expect(detailMsg).toMatchObject({
      name: 'writer',
      source: 'user',
      strategy: { act: { temperature: 0.8 } },
    });
    expect(posted.some((m) => m.type === 'roles_loaded')).toBe(true);
    expect(saveNotices(posted)).toEqual([
      { type: 'notice', level: 'info', message: '「writer」的策略配置已保存' },
    ]);
  });

  it('策略值越界 → validateManifestText 报 error：不写盘、不 reload（变异 M3 锁）', async () => {
    vi.mocked(readFile).mockResolvedValue(RAW_MANIFEST);
    const { provider, posted, reload } = setupSave(`${USER_DIR}/writer/manifest.json`);

    await save(provider, 'writer', { act: { temperature: 99 } });

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    const msgs = saveNotices(posted);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.level).toBe('error');
    expect(msgs[0]?.message).toContain('保存失败');
  });

  it('空 strategy 保存 → 删除 strategy 键（保持「未声明」语义，不固化空对象），其余字段保留', async () => {
    vi.mocked(readFile).mockResolvedValue(RAW_MANIFEST);
    const { provider, posted } = setupSave(`${USER_DIR}/writer/manifest.json`);

    await save(provider, 'writer', {});

    const [, text] = vi.mocked(writeFile).mock.calls[0]!;
    const written = JSON.parse(text as string) as Record<string, unknown>;
    expect(written.strategy).toBeUndefined();
    expect(written.skills).toEqual([{ file: 'skills/write.md' }]);
    // 回发的 detail 数据 strategy 为 undefined（未声明语义透传给弹窗）
    const detailMsg = posted.find((m) => m.type === 'roles_detail_data');
    expect(detailMsg).toMatchObject({ name: 'writer', source: 'user', strategy: undefined });
  });

  it('roles_detail → 读 manifest 原文回发（初值真源 = 文件，非装配值）', async () => {
    vi.mocked(readFile).mockResolvedValue(RAW_MANIFEST);
    const { provider, posted } = setupSave(`${USER_DIR}/writer/manifest.json`);

    await detail(provider, 'writer');

    expect(vi.mocked(readFile)).toHaveBeenCalledWith(`${USER_DIR}/writer/manifest.json`, 'utf-8');
    const detailMsg = posted.find((m) => m.type === 'roles_detail_data');
    expect(detailMsg).toMatchObject({
      name: 'writer',
      source: 'user',
      strategy: { act: { temperature: 0.5 } },
    });
  });

  it('内置包 roles_detail → 查看放行（source: builtin）；受限的是编辑而非查看', async () => {
    vi.mocked(readFile).mockResolvedValue(RAW_MANIFEST);
    const { provider, posted } = setupSave('/mock/builtin/pack-a/manifest.json');

    await detail(provider, 'pack-a');

    const detailMsg = posted.find((m) => m.type === 'roles_detail_data');
    expect(detailMsg).toMatchObject({
      name: 'pack-a',
      source: 'builtin',
      strategy: { act: { temperature: 0.5 } },
    });
  });
});

describe('settingsPanel.loadRoles —— 读期队伍健康检测（只读标注，不写回）', () => {
  /**
   * 场景：存储残留受损队伍（如内置包收紧删掉「方案设计师」）。
   * 不变量（2026-10-08 语义变更，推翻旧「清理写回」）：
   *   - 存储原样保留（零 update，宿主不静默改用户数据）；
   *   - roles_loaded 下发的 teams 附加检测字段（leaderMissing/missingMembers），
   *     角色页据此持久标注，清理/修复由用户主动触发；
   *   - 健康组不带标记字段（不产生无意义字段）。
   */
  it('存储含幽灵队伍 → 下发检测字段标注 + 零写回（数据原样保留）', async () => {
    // agent 桩：只含 loadRoles 消费面（ensureAgent 的事件绑定 + listMeta/get/activeName）
    const agent = {
      on: vi.fn(),
      off: vi.fn(),
      rolePackManager: {
        listMeta: () => [{ name: 'memora助手' }],
        get: () => undefined,
        activeName: 'memora助手',
      },
    } as unknown as Agent;
    // globalState 桩：get 读当前值；update 必须零调用（只读语义）
    const store = [{ leader: '方案设计师', members: ['memora助手'] }];
    const globalUpdate = vi.fn();
    const posted: { type: string; teams?: unknown }[] = [];
    const provider = new MemoraSettingsViewProvider({} as never, {} as never);
    provider.setAgentFactory(async () => agent);
    provider.setGlobalState({ get: () => store, update: globalUpdate } as never);
    (provider as unknown as { _view: unknown })._view = {
      webview: {
        postMessage: (msg: never) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
      },
    };

    await (provider as unknown as { loadRoles(): Promise<void> }).loadRoles();

    // 不写回：队伍数据保留在存储（删除权交还用户）
    expect(globalUpdate).not.toHaveBeenCalled();
    // 检测字段随载荷下发：组长失效 → 遗留队伍标注
    const rolesLoaded = posted.find((m) => m.type === 'roles_loaded');
    expect(rolesLoaded?.teams).toEqual([
      { leader: '方案设计师', members: ['memora助手'], leaderMissing: true, missingMembers: [] },
    ]);
  });

  it('健康队伍 → 原样下发，不带检测标记字段', async () => {
    const agent = {
      on: vi.fn(),
      off: vi.fn(),
      rolePackManager: {
        listMeta: () => [{ name: 'A' }, { name: 'B' }],
        get: () => undefined,
        activeName: 'A',
      },
    } as unknown as Agent;
    const store = [{ leader: 'A', members: ['B'] }];
    const globalUpdate = vi.fn();
    const posted: { type: string; teams?: unknown }[] = [];
    const provider = new MemoraSettingsViewProvider({} as never, {} as never);
    provider.setAgentFactory(async () => agent);
    provider.setGlobalState({ get: () => store, update: globalUpdate } as never);
    (provider as unknown as { _view: unknown })._view = {
      webview: {
        postMessage: (msg: never) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
      },
    };

    await (provider as unknown as { loadRoles(): Promise<void> }).loadRoles();

    expect(globalUpdate).not.toHaveBeenCalled();
    const rolesLoaded = posted.find((m) => m.type === 'roles_loaded');
    expect(rolesLoaded?.teams).toEqual([{ leader: 'A', members: ['B'] }]);
  });
});
