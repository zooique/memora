/**
 * 角色包队伍健康检测（幽灵引用标注，只读不写回）
 *
 * 背景（2026-10-03 定案，ADR-028 收敛补记）：组数据是宿主用户级持久化（globalState），
 * 组长/组员角色包可能因内置包收紧、用户删除等**无删除事件**的路径消失，存储残留
 * 「指向已卸载角色包」的幽灵队伍记录。
 *
 * 语义变更（2026-10-08 用户拍板，推翻 2026-10-03 的「清理写回」语义）：
 *   - 原语义（已退役）：组长失效删组 / 组员失效摘除 / 摘空删组，写回 globalState + 热更新内核。
 *     实锤伤例：2026-10-07 构建中窗口（esbuild 先清后拷）包池扫描为 0，对账把「扫描失败」
 *     当成「全部卸载」，将用户所有队伍静默物理删除（见 ADR-028 收敛补记 §语义变更）。
 *   - 新语义（本文件）：**只检测不删除**——受损队伍保留在存储中，检测结果（组长失效 =
 *     遗留队伍 / 组员失效 = 缺员名单）随 roles_loaded 下发，由角色页持久标注，
 *     「清理遗留队伍 / 修复缺员名单」由用户主动触发（复用 roles_team_delete / roles_team_save）。
 *   - 空池护栏：包池为空 = 扫描失败（构建中窗口 / 安装损坏），跳过检测防误报——
 *     把瞬时状态当成永久事实正是上一次事故的根因。
 *
 * 幽灵数据留存的安全性：内核会议消费端已兜底（activeTeamMembers 缺员过滤 +
 * resolveRoundAssemblyRole 越界跳过 + 组长失效组自然不生效），受损数据只影响展示标注，
 * 不影响会议正确性。
 *
 * 单接线点（SSOT）：settingsPanel.loadRoles（读期检测）——不写回则无需启动接线点，
 * 检测视图随每次下发实时计算，天然覆盖装配竞态窗口。
 */
import type { Agent, RolePackManager } from '@zooique/memora';
// 组员上限（保存校验用；内核常量单点，宿主不复制 5 字面量）
import { MAX_TEAM_MEMBERS } from '@zooique/memora';
import type { Memento } from 'vscode';
import { ROLE_PACK_TEAMS_KEY } from '../../shared/constants.js';

/** 队伍快照（globalState 存储形态，与内核 RolePackTeam 同构；宿主不 import 内核类型，保持类型层独立） */
export interface RolePackTeamSnapshot {
  /** 组长角色包名 */
  leader: string;
  /** 组员角色包名列表 */
  members: string[];
}

/** 单支队伍的健康检测结果（读期派生视图，不落盘——存储形态始终为 RolePackTeamSnapshot） */
export interface TeamHealth {
  /** 组长角色包已卸载 → 遗留队伍（组以组长为定义者，整组不可用，UI 给「清理」入口） */
  leaderMissing: boolean;
  /** 已卸载的组员名单（缺员标注；空数组 = 组员全部健康） */
  missingMembers: string[];
}

/** 组队广播目标（会话 id + 实例；只要求 `rolePackManager` 这一面，便于测试替身注入） */
export interface TeamBroadcastTarget {
  /** 会话标识（失败汇总用它指明「哪条会话没生效」） */
  sessionId: string;
  /** 该会话的实例（只需角色包管理器） */
  agent: Pick<Agent, 'rolePackManager'>;
}

/** 组队广播结果（成功会话 id + 失败原因；调用方必须明示，不许静默吞） */
export interface TeamBroadcastResult {
  /** 热更成功的会话 id */
  updated: string[];
  /** 热更失败的会话（含原因） */
  failed: { sessionId: string; reason: string }[];
}

/**
 * 组队热更广播（**作用域必须与数据归属一致**）
 *
 * 组队名单是**全局一份**（`globalState` 用户级，装配期注入所有会话）⇒ 写的时候**必须**打所有
 * 已装配实例。只打「当前显示会话」会造出「读的时候全局、写的时候单实例」的不对称：会话 A 改完、
 * 会话 B 开会仍用旧名单，且用户无从察觉（本仓 `TEAM-HOTUPDATE-FANOUT-1` 即此伤）。
 *
 * 失败隔离：单实例抛错只记入 `failed`，**不中断**其余实例（一次坏连接不该让整批广播失败）；
 * 返回值供 UI 明示「成功 N / 失败 M + 原因」。
 *
 * @param targets 已装配实例快照（生产真源 = `AgentRegistry.listEntries()`）
 * @param teams 新组队名单（globalState 存储形态）
 */
export function broadcastRolePackTeams(
  targets: readonly TeamBroadcastTarget[],
  teams: RolePackTeamSnapshot[],
): TeamBroadcastResult {
  const updated: string[] = [];
  const failed: { sessionId: string; reason: string }[] = [];
  for (const { sessionId, agent } of targets) {
    try {
      const rpm = agent.rolePackManager;
      // 内核未就绪不算「已生效」：记失败，避免汇总数虚高
      if (!rpm) {
        failed.push({ sessionId, reason: '内核未就绪（无 rolePackManager）' });
        continue;
      }
      rpm.setRolePackTeams(teams);
      updated.push(sessionId);
    } catch (err) {
      failed.push({ sessionId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { updated, failed };
}

/** 组队写操作依赖（由面板注入：用户级存储 + 当前会话内核 + 广播器） */
export interface TeamWriteDeps {
  /** 用户级存储（组队名单的持久化真源） */
  globalState?: Memento;
  /** 当前显示会话的角色包管理器（未注入广播器时的降级目标） */
  rpm?: Pick<RolePackManager, 'listMeta' | 'setRolePackTeams'>;
  /** 热更广播器（生产真源 = `AgentRegistry.listEntries()`） */
  broadcast?: (teams: RolePackTeamSnapshot[]) => TeamBroadcastResult;
}

/** 热更落点（广播优先；未注入广播器时退回单实例——降级路径，非目标行为） */
function applyTeams(
  next: RolePackTeamSnapshot[],
  deps: TeamWriteDeps,
): TeamBroadcastResult | undefined {
  if (!deps.broadcast) {
    deps.rpm?.setRolePackTeams(next);
    return undefined;
  }
  return deps.broadcast(next);
}

/**
 * 保存角色包组（会议名单）：校验 → 持久化用户级存储 → 广播热更所有已装配实例。
 *
 * 组 = 组长角色包的会议名单（非选择对象）；组员仅作小组会议参与者，不用于日常。
 * 校验：组长/组员须为存在的角色包、名单非空、组长身份唯一（一个角色包只能是一个组的组长）、
 * 组员数量不超上限。全部失败分支在此收口（原因可直接展示，调用方不猜测）。
 */
export async function saveRolePackTeam(
  deps: TeamWriteDeps,
  leader: string,
  members: string[],
): Promise<{ ok: true; broadcast?: TeamBroadcastResult } | { ok: false; reason: string }> {
  const rpm = deps.rpm;
  if (!rpm || !leader) return { ok: false, reason: '小组保存失败：内核未就绪' };
  const validPacks = new Set(rpm.listMeta().map((m) => m.name));
  const deduped = [...new Set(members)];
  if (!validPacks.has(leader))
    return { ok: false, reason: `小组保存失败：组长「${leader}」不存在` };
  if (deduped.length === 0) return { ok: false, reason: '小组保存失败：至少选择 1 名组员' };
  if (deduped.some((m) => !validPacks.has(m))) {
    return { ok: false, reason: '小组保存失败：存在不存在的组员角色包' };
  }
  if (deduped.includes(leader))
    return { ok: false, reason: '小组保存失败：组长不能同时是自己的组员' };
  // 5 人组上限（队长 1 + 组员 ≤ MAX_TEAM_MEMBERS，组队功能用户约定）：超限拒绝保存
  if (deduped.length > MAX_TEAM_MEMBERS) {
    return {
      ok: false,
      reason: `小组保存失败：组员最多 ${MAX_TEAM_MEMBERS} 名（队长 1 + 组员 ≤ ${MAX_TEAM_MEMBERS} = ${MAX_TEAM_MEMBERS + 1} 人组上限）`,
    };
  }
  // 组长身份唯一：同一组长不允许两处建组
  const teams = deps.globalState?.get<RolePackTeamSnapshot[]>(ROLE_PACK_TEAMS_KEY) ?? [];
  const next = [...teams.filter((t) => t.leader !== leader), { leader, members: deduped }];
  await deps.globalState?.update(ROLE_PACK_TEAMS_KEY, next);
  return { ok: true, broadcast: applyTeams(next, deps) };
}

/** 删除角色包组（会议名单）：持久化移除 + 广播热更所有已装配实例。 */
export async function deleteRolePackTeam(
  deps: TeamWriteDeps,
  leader: string,
): Promise<TeamBroadcastResult | undefined> {
  const teams = deps.globalState?.get<RolePackTeamSnapshot[]>(ROLE_PACK_TEAMS_KEY) ?? [];
  const next = teams.filter((t) => t.leader !== leader);
  await deps.globalState?.update(ROLE_PACK_TEAMS_KEY, next);
  return applyTeams(next, deps);
}

/** 组队热更结果的用户可见措辞（保存/删除共用，禁两套口径） */
export function describeTeamBroadcast(
  actionLabel: string,
  result: TeamBroadcastResult | undefined,
): string {
  if (!result) return `小组已${actionLabel}`;
  if (result.failed.length > 0) {
    const detail = result.failed.map((f) => `${f.sessionId}：${f.reason}`).join('；');
    return `小组已${actionLabel}；热更成功 ${result.updated.length} 个会话，失败 ${result.failed.length} 个（${detail}）——失败会话需重开面板或重启后生效`;
  }
  // 零已装配会话不是失败：下次装配本就按新名单注入，说清楚免得用户以为没生效
  if (result.updated.length === 0) {
    return `小组已${actionLabel}（当前无已装配会话，下次打开即按新名单生效）`;
  }
  return `小组已${actionLabel}`;
}

/**
 * 检测纯函数：对照当前包池，算出每支队伍的受损状态（零副作用，不修改输入）。
 *
 * @param teams 存储中的队伍列表（原样输入，不做去重/互斥等额外归一——存储由保存校验写入）
 * @param existingNames 当前实际存在的角色包名集合（真源 = rolePackManager.listMeta()）
 * @returns 按组长名索引的健康状态；健康组 leaderMissing=false 且 missingMembers 为空
 */
export function inspectTeamsHealth(
  teams: readonly RolePackTeamSnapshot[],
  existingNames: ReadonlySet<string>,
): Map<string, TeamHealth> {
  // 空池护栏：包池为空 = 扫描失败窗口（构建中/安装损坏），不是「所有包都被卸载」。
  // 此时全部按健康处理跳过检测——把瞬时状态当成永久事实正是 2026-10-07 事故的根因。
  if (existingNames.size === 0) {
    return new Map(teams.map((t) => [t.leader, { leaderMissing: false, missingMembers: [] }]));
  }
  const health = new Map<string, TeamHealth>();
  for (const team of teams) {
    health.set(team.leader, {
      leaderMissing: !existingNames.has(team.leader),
      missingMembers: team.members.filter((m) => !existingNames.has(m)),
    });
  }
  return health;
}

/**
 * 检测入口（唯一接线点 settingsPanel.loadRoles 消费）：读存储 → 对照包池 → 健康状态。
 * 只读不写：零 globalState.update、零内核调用（不热更新 setRolePackTeams——存储即真源，
 * 内核持有原样数据，消费端缺员过滤已在内核生效）。
 *
 * @param rolePackManager 内核角色包管理器（Agent.rolePackManager 可空；空 = 内核未就绪，返回空表）
 * @param globalState 宿主用户级存储（undefined = 不可读取，返回空表）
 */
export function inspectRolePackTeams(
  rolePackManager: Pick<RolePackManager, 'listMeta'> | null | undefined,
  globalState: Memento | undefined,
): Map<string, TeamHealth> {
  if (!rolePackManager || !globalState) return new Map();
  try {
    const current = globalState.get<RolePackTeamSnapshot[]>(ROLE_PACK_TEAMS_KEY) ?? [];
    const existingNames = new Set(rolePackManager.listMeta().map((m) => m.name));
    return inspectTeamsHealth(current, existingNames);
  } catch (err) {
    // 检测失败不影响日常：不下发检测字段（UI 不标注），存储保留原样
    console.warn('[memora] 队伍健康检测失败（本次不标注，不影响日常使用）', err);
    return new Map();
  }
}
