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
import type { RolePackManager } from '@zooique/memora';
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
