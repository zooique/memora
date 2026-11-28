/**
 * 远程桥的角色包列表投影（手机「＋」建会话前取）
 *
 * 为什么单独成文件而不写在装配点（`extension.ts`）：装配链有守卫
 * （`chatPanelSessionAgents.test.ts` · 「新建会话默认角色包 · 读口单一性守卫」）
 * 禁止直接引用全局默认角色包，防的是「把装配改成引用语义、追溯改写老会话」。
 * 本文件只服务远程桥的**建会话预选**，不参与装配、不写任何会话 meta。
 */

import type { Agent } from '@zooique/memora';
// 与 PC 输入区下拉共用同一份投影（工作包过滤 / 排序 / 展示名回落都在那里）
import { buildChatRolePacks } from '../../../webview/helpers/rolePackListView.js';
// 全局默认角色包的唯一读口（`memora.defaultRolePack`）
import { resolveNewSessionRolePackName } from '../rolePackDefault.js';
import type { BridgeRolePackMeta } from './remoteBridgeProtocol.js';

/**
 * 构造角色包列表应答体（`role_list_ok` 的载荷）
 *
 * @param rpm 当前装配实例的角色包管理器；`undefined` = 冷启动尚未装配 ⇒ 空列表
 *            （手机据此按「不指定角色」建会话，不为读一次目录去装配会话）
 * @returns `packs` 原样来自 PC 输入区下拉投影；`defaultName` 缺省 = 用户没设过默认
 */
export function buildRemoteRolePackList(rpm: Agent['rolePackManager'] | undefined): {
  packs: readonly BridgeRolePackMeta[];
  defaultName?: string;
} {
  const { packs } = buildChatRolePacks(rpm, undefined);
  const defaultName = resolveNewSessionRolePackName();
  return { packs, ...(defaultName ? { defaultName } : {}) };
}
