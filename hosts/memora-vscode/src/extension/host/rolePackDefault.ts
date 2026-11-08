/**
 * 新会话默认角色包 —— 用户级设置的**单点读口**
 *
 * 单一真理源（为什么只允许在这里读配置）：
 *   - 配置键 `memora.defaultRolePack` 只在本模块被 `getConfiguration` 读取。装配链路
 *     （`extension.ts` / `host/assemble.ts`）**禁止**读它——装配只认
 *     `SessionMeta.activeRolePackName` 快照，否则「改全局默认」会追溯改写老会话。
 *   - 「空设置 ⇒ 回落谁」也只在本模块定义，调用方不得各写一份
 *     `|| BUILTIN_FALLBACK_PACK`（那会形成第二份回落真源）。
 *
 * 语义：
 *   - 空串 = 用户未设置 ⇒ 新建会话不写 meta，沿用内核 §4.1 单链兜底（历史行为不变）；
 *   - 非空 = 新建会话的角色名快照来源（仍然只在建会话处落盘一次）。
 */
import * as vscode from 'vscode';
import { BUILTIN_FALLBACK_PACK } from '@zooique/memora';

/**
 * 读取用户级默认角色包名
 *
 * @returns 去空白后的包名；未设置 / 非字符串 / 纯空白一律 `''`（= 未设置）
 */
export function readDefaultRolePackSetting(): string {
  const configured = vscode.workspace.getConfiguration('memora').get<string>('defaultRolePack');
  return typeof configured === 'string' ? configured.trim() : '';
}

/**
 * 新建会话应写入快照的角色包名
 *
 * @returns 未设置时为 `undefined`（**不写 meta**，让内核走兜底链，保持既有行为）
 */
export function resolveNewSessionRolePackName(): string | undefined {
  return readDefaultRolePackSetting() || undefined;
}

/**
 * 草稿页徽章「即将生效」的角色名
 *
 * 未设置时投影内核兜底契约包——与「会话未选角色 ⇒ 装配落兜底」同源，不另造回落值。
 */
export function resolveDraftRolePackName(): string {
  return readDefaultRolePackSetting() || BUILTIN_FALLBACK_PACK;
}
