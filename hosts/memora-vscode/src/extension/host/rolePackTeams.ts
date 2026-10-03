/**
 * 角色包队伍对账（幽灵引用清理）
 *
 * 背景（2026-10-03 定案，ADR-028 收敛补记）：组数据是宿主用户级持久化（globalState），
 * 组长/组员角色包可能因内置包收紧、用户删除等**无删除事件**的路径消失，存储残留
 * 「指向已卸载角色包」的幽灵队伍记录。
 *
 * 对账语义（用户拍板）：
 *   - 组长包已不存在 → 整组删除（组以组长为定义者）；
 *   - 组员包已不存在 → 从名单摘除；摘后名单为空 → 删组（对齐保存校验「至少 1 名组员」不变式）；
 *   - 修复结果写回 globalState + 热更新内核组数据。
 *
 * 双接线点共用本模块单实现（SSOT，禁各自写 filter 副本）：
 *   1. extension.ts agent 装配完成后（「启动时」语义）；
 *   2. settingsPanel.loadRoles（面板读期兜底，覆盖装配完成的竞态窗口）。
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

/**
 * 对账纯函数：清除指向已卸载角色包的幽灵引用（组长失效删组 / 组员失效摘除 / 摘空删组）。
 *
 * @param teams 存储中的队伍列表（原样输入，不做去重/互斥等额外归一——存储由保存校验写入）
 * @param existingNames 当前实际存在的角色包名集合（真源 = rolePackManager.listMeta()）
 * @returns teams=对账后的队伍列表（未受损组保留原引用，受损组换新对象）；changed=是否发生清理
 */
export function reconcileTeams(
  teams: readonly RolePackTeamSnapshot[],
  existingNames: ReadonlySet<string>,
): { teams: RolePackTeamSnapshot[]; changed: boolean } {
  const next: RolePackTeamSnapshot[] = [];
  let changed = false;
  for (const team of teams) {
    // 组长已卸载 → 整组删除
    if (!existingNames.has(team.leader)) {
      changed = true;
      continue;
    }
    // 组员已卸载 → 从名单摘除
    const members = team.members.filter((m) => existingNames.has(m));
    if (members.length !== team.members.length) changed = true;
    // 摘后名单为空（含存储里本就为空的存量）→ 组不成立，删除该组
    if (members.length === 0) {
      changed = true;
      continue;
    }
    next.push(members.length !== team.members.length ? { leader: team.leader, members } : team);
  }
  return { teams: next, changed };
}

/**
 * 对账入口（双接线点共用）：读存储 → 对账 → 有清理才写回 + 热更新内核。
 *
 * 内核热更新不可省：装配期已把幽灵队伍注入内核（AgentOptions.rolePackTeams），
 * 仅写存储不更新内核的话，本次会话的会议消费端仍见幽灵引用。
 *
 * @param rolePackManager 内核角色包管理器（Agent.rolePackManager 可空；空 = 内核未就绪，安全跳过）
 * @param globalState 宿主用户级存储（undefined = 不可持久化，安全跳过）
 */
export async function reconcileRolePackTeams(
  rolePackManager: Pick<RolePackManager, 'listMeta' | 'setRolePackTeams'> | null | undefined,
  globalState: Memento | undefined,
): Promise<void> {
  if (!rolePackManager || !globalState) return;
  try {
    const current = globalState.get<RolePackTeamSnapshot[]>(ROLE_PACK_TEAMS_KEY) ?? [];
    const existingNames = new Set(rolePackManager.listMeta().map((m) => m.name));
    const { teams: next, changed } = reconcileTeams(current, existingNames);
    if (!changed) return;
    // 先写存储后更内核：内核更新是同步 setter，不会失败；存储写入失败则双方保持旧态（可下轮重试）
    await globalState.update(ROLE_PACK_TEAMS_KEY, next);
    rolePackManager.setRolePackTeams(next);
    console.warn('[memora] 队伍对账：发现指向已卸载角色包的引用，已清理写回');
  } catch (err) {
    // 对账失败不影响日常：存储保留原样，幽灵引用由内核会议消费端「缺员跳过/组长失效组失效」兜底
    console.warn('[memora] 队伍对账失败（保留原数据，不影响日常使用）', err);
  }
}
