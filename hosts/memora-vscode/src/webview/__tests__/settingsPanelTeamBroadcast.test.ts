/**
 * 设置页组队热更广播 —— 跨会话生效的端到端回归（`TEAM-HOTUPDATE-FANOUT-1`）
 *
 * 被测不变量（用户判据原话：「A 改组 → B 不重开即生效」「单实例异常 → 其余仍生效且有可见提示」）：
 *
 * 1. 组队名单是**用户级全局一份**（`globalState`，装配期注入所有会话）⇒ 写的时候必须广播
 *    **所有已装配实例**。只打「当前显示会话」会造出「读的时候全局、写的时候单实例」的不对称：
 *    会话 A 改组后，会话 B 的实例仍持旧名单，直到重开面板/重启才更新，且用户无从察觉。
 *
 * 2. 失败隔离：任一实例抛错只记入失败汇总，**不中断**其余实例；面板必须给出可见提示
 *    （成功 N / 失败 M + 会话 id + 原因），不许静默吞。
 *
 * 测试形态（刻意不用「方法被调用」当证据）：
 *   - 真实 `RolePackManager`（临时 role-packs 目录，与实际装配同源）+ 真实磁盘角色包；
 *   - 判据 = `rpm.getTeam(组长)` **读回**的组员名单（内核会议消费的同一出口）；
 *   - 面板走真实入口 `handleMessage(roles_team_save)`，注入真实 `broadcastRolePackTeams`。
 *   ⇒ 若生产代码回退为「只打 ensureAgent 的当前实例」，B 的读回仍是旧名单，本文件转红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, RolePackManager } from '@zooique/memora';
// 运行时构造（非类型）：用真实内核角色包管理器，读回名单才能证明「已生效」
import { RolePackManager as RealRolePackManager } from '@zooique/memora';
import { MemoraSettingsPanel } from '../panels/settingsPanel.js';
// 生产同一广播执行面（面板注入的就是它；不在此另写一份循环）
import { broadcastRolePackTeams } from '../../extension/host/rolePackTeams.js';

// mock vscode：面板加载期 / 构造期用到的最小 API（与 settingsPanelRoles.test.ts 同形态）
vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ toString: () => 'mock://uri' }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined), update: vi.fn() })),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    createWebviewPanel: vi.fn(),
  },
  commands: { executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: 1 },
  env: { language: 'zh-cn' },
}));

/** 写一个最小 folder 形态角色包（manifest.json 即可被扫描识别） */
async function writePack(packsDir: string, packName: string): Promise<void> {
  const packDir = join(packsDir, packName);
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, 'manifest.json'),
    JSON.stringify({ name: packName, formatVersion: '1.0.0' }, null, 2),
    'utf-8',
  );
}

/**
 * 构造一个「已装配会话」的 Agent 替身：只含面板消费面
 * （`rolePackManager` + 事件绑定空实现；面板 `ensureAgent` 会幂等重绑角色事件）。
 */
function agentWith(rpm: RolePackManager): Agent {
  return { rolePackManager: rpm, on: vi.fn(), off: vi.fn() } as unknown as Agent;
}

/** 真实角色包管理器：同一临时根目录下写好三包并装载（组员过滤依赖已装载项） */
async function makeManager(root: string): Promise<RolePackManager> {
  const packsDir = join(root, 'role-packs');
  await mkdir(packsDir, { recursive: true });
  await writePack(packsDir, '设计师');
  await writePack(packsDir, '工程师');
  await writePack(packsDir, '数据分析师');
  const rpm = new RealRolePackManager(root);
  // 装载必须发生：getTeam 的组员名单会按「已装载项」过滤（缺员不可参会）
  await rpm.load('设计师');
  return rpm;
}

describe('settingsPanel.roles_team_save —— 组队热更广播到所有已装配会话', () => {
  let rootA: string;
  let rootB: string;
  let rpmA: RolePackManager;
  let rpmB: RolePackManager;
  /** 面板推送消息收集（notice / roles_loaded） */
  let posted: { type: string; level?: string; message?: string }[];
  /** globalState.update 记录（组数据落盘） */
  let globalUpdate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    posted = [];
    globalUpdate = vi.fn();
    rootA = await mkdtemp(join(tmpdir(), 'team-broadcast-a-'));
    rootB = await mkdtemp(join(tmpdir(), 'team-broadcast-b-'));
    rpmA = await makeManager(rootA);
    rpmB = await makeManager(rootB);
    // 两个会话都从「旧名单」起步：组长 设计师，组员 工程师
    rpmA.setRolePackTeams([{ leader: '设计师', members: ['工程师'] }]);
    rpmB.setRolePackTeams([{ leader: '设计师', members: ['工程师'] }]);
  });

  afterEach(async () => {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  });

  /**
   * 构造面板：当前显示会话 = A（`ensureAgent` 返回 A），广播真源 = 两条已装配会话。
   * 注入的 broadcaster 与生产同源（`broadcastRolePackTeams`），不是测试自造循环。
   */
  function setup(): MemoraSettingsPanel {
    const agentA = agentWith(rpmA);
    const agentB = agentWith(rpmB);
    const provider = new MemoraSettingsPanel({} as never, {} as never);
    provider.setAgentFactory(async () => agentA);
    provider.setGlobalState({ get: () => [], update: globalUpdate } as never);
    provider.setTeamBroadcaster((teams) =>
      broadcastRolePackTeams(
        [
          { sessionId: 'A', agent: agentA },
          { sessionId: 'B', agent: agentB },
        ],
        teams,
      ),
    );
    (provider as unknown as { _panel: unknown })._panel = {
      webview: {
        postMessage: (msg: never) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
      },
    };
    return provider;
  }

  /** 走面板真实入口保存小组（不直调私有方法，钉的是用户动作） */
  function save(provider: MemoraSettingsPanel, leader: string, members: string[]): Promise<void> {
    return (provider as unknown as { handleMessage(msg: unknown): Promise<void> }).handleMessage({
      type: 'roles_team_save',
      leader,
      members,
    });
  }

  it('A 改组 → B 不重开即生效：B 读回名单已是新组员（变异：只打当前实例即红）', async () => {
    const provider = setup();

    await save(provider, '设计师', ['数据分析师']);

    // 判据 = 内核会议消费的同一出口（getTeam 读回），不是「方法被调用」
    expect(rpmA.getTeam('设计师')?.members).toEqual(['数据分析师']);
    expect(rpmB.getTeam('设计师')?.members).toEqual(['数据分析师']);
    // 落盘（全局一份）+ 用户可见的成功提示
    expect(globalUpdate).toHaveBeenCalledWith('memora.rolePackTeams', [
      { leader: '设计师', members: ['数据分析师'] },
    ]);
    expect(posted.filter((m) => m.type === 'notice')).toEqual([
      { type: 'notice', level: 'info', message: '小组已保存' },
    ]);
  });

  it('广播中单实例异常 → 其余实例仍生效 + 可见提示含失败会话与原因（不静默吞）', async () => {
    // B 实例的角色包管理器在热更时抛错（模拟旧实例内核未就绪 / 内部异常）
    const throwingB = {
      get rolePackManager(): RolePackManager {
        return {
          setRolePackTeams: () => {
            throw new Error('实例已释放');
          },
        } as unknown as RolePackManager;
      },
    } as unknown as Agent;
    const agentA = agentWith(rpmA);
    const provider = new MemoraSettingsPanel({} as never, {} as never);
    provider.setAgentFactory(async () => agentA);
    provider.setGlobalState({ get: () => [], update: globalUpdate } as never);
    provider.setTeamBroadcaster((teams) =>
      broadcastRolePackTeams(
        [
          { sessionId: 'A', agent: agentA },
          { sessionId: 'B', agent: throwingB },
        ],
        teams,
      ),
    );
    (provider as unknown as { _panel: unknown })._panel = {
      webview: {
        postMessage: (msg: never) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
      },
    };

    await save(provider, '设计师', ['数据分析师']);

    // 失败隔离：A 仍完成热更（读回新名单）
    expect(rpmA.getTeam('设计师')?.members).toEqual(['数据分析师']);
    // 汇总可见：成功 1 / 失败 1 + 失败会话 id 与原因
    const notices = posted.filter((m) => m.type === 'notice') as {
      level?: string;
      message?: string;
    }[];
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe('error');
    expect(notices[0]?.message).toContain('热更成功 1 个会话，失败 1 个');
    expect(notices[0]?.message).toContain('B：实例已释放');
  });
});
