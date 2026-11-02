/**
 * 用户资产（技能 / 角色包）重扫刷新 —— 设置页两个「刷新」按钮的执行面。
 *
 * 为什么外置：settingsPanel.ts 已贴 `max-lines` 上限（只降不升），而「摘除旧注入项 →
 * 内核重扫 → 净差对账 notice → 列表回推」这段逻辑技能与角色包**同构**。留在面板里
 * 只会有两份漂移的净差文案与两条不同的回推顺序；外置后两个刷新按钮共用同一套对账表述。
 *
 * 判据归属：重扫本身归内核（`resyncUserSkills` / `resyncUserPacks`），本模块只负责
 * 「怎么把结果讲给用户」与「刷新后推哪条列表」，不碰磁盘、不做扫描。
 */

import type { Agent } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 面板投递通道（窄接口：只传消息，不暴露 webview 实例） */
export type PostFn = (msg: ExtensionToWebviewMessage) => void;

/** 技能重扫净差（内核 `SkillManager.resyncUserSkills` 的返回形状） */
export interface SkillResyncDiff {
  added: number;
  removed: string[];
  updated: string[];
}

/** 角色包重扫净差（内核 `RolePackManager.resyncUserPacks` 的返回形状） */
export interface RolePackResyncDiff extends SkillResyncDiff {
  activeFallback?: boolean;
}

/**
 * 对账结果 → 用户可读文案（技能与角色包共用，保证同一件事只有一种表述）
 *
 * 只报「新增 / 移除」与角色包回退：内核的 `updated` 仅表示**重扫后仍存在的同名项**，
 * 不代表内容变化，故**不渲染、不计数**（渲染成「更新 N 个」会把未变化项谎报成更新）。
 *
 * @param label 资产名（「技能」/「角色包」）
 * @param diff 内核返回的对账结果
 */
export function formatResyncNotice(label: string, diff: RolePackResyncDiff): string {
  const parts: string[] = [];
  if (diff.added > 0) parts.push(`新增 ${diff.added} 个`);
  if (diff.removed.length > 0)
    parts.push(`移除 ${diff.removed.length} 个（${diff.removed.join('、')}）`);
  // 角色包独有：原激活包被删/改名后内核已回退兜底包，必须告知用户
  if (diff.activeFallback) parts.push('原激活包已不在，已回退兜底角色包');
  return parts.length > 0 ? `${label}已刷新：${parts.join('；')}` : `${label}已刷新：无变化`;
}

/**
 * 技能刷新执行面（`skills_refresh` 消息的落点）
 *
 * @param deps.agent 当前 Agent（未就绪 = 明确报错，不静默）
 * @param deps.post 面板投递通道
 * @param deps.reloadList 重扫后重推列表（复用面板既有 loadSkills）
 * @param deps.refreshChatSkills 对话侧技能下拉的同源刷新
 */
export async function refreshUserSkillsFlow(deps: {
  agent: Agent | undefined;
  post: PostFn;
  reloadList: () => Promise<void>;
  refreshChatSkills: () => void;
}): Promise<void> {
  const sm = deps.agent?.skills;
  if (!sm) {
    deps.post({ type: 'notice', level: 'error', message: '技能系统未就绪，无法刷新' });
    return;
  }
  const diff = await sm.resyncUserSkills();
  deps.post({ type: 'notice', level: 'info', message: formatResyncNotice('技能', diff) });
  await deps.reloadList();
  deps.refreshChatSkills();
}

/**
 * 角色包刷新执行面（`roles_refresh` 消息的落点）
 *
 * @param deps.agent 当前 Agent（未就绪 = 明确报错，不静默）
 * @param deps.userRolePacksDir 用户角色包目录（未配置则无法重扫）
 * @param deps.post 面板投递通道
 * @param deps.reloadList 重扫后重推列表（复用面板既有 loadRoles）
 */
export async function refreshUserRolePacksFlow(deps: {
  agent: Agent | undefined;
  userRolePacksDir: string | undefined;
  post: PostFn;
  reloadList: () => Promise<void>;
}): Promise<void> {
  const rpm = deps.agent?.rolePackManager;
  if (!rpm || !deps.userRolePacksDir) {
    deps.post({ type: 'notice', level: 'error', message: '角色包系统未就绪，无法刷新' });
    return;
  }
  const diff = await rpm.resyncUserPacks(deps.userRolePacksDir);
  deps.post({ type: 'notice', level: 'info', message: formatResyncNotice('角色包', diff) });
  await deps.reloadList();
}
