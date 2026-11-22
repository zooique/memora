/**
 * 角色包展示名单点（宿主侧纯函数）
 *
 * 为什么外置：`chatPanel.ts` 贴 max-lines 上限，而「角色包名 → 展示名」是纯查表，
 * 不持有面板状态；留在面板里只会占行数，外置后面板只留一行调用。
 */
import type { Agent } from '@zooique/memora';

/**
 * 取角色包的展示名（找不到元数据时回落包名本身）
 *
 * @param rolePack 角色包名（空串 = 无激活角色）
 * @param agent 取名单的 Agent（可缺省；缺省按无元数据处理）
 * @returns 展示名；包名为空时返回空串，由调用方决定是否回落「AI」
 */
export function roleDisplayName(rolePack: string, agent: Agent | undefined): string {
  const meta = agent?.rolePackManager?.listMeta().find((m) => m.name === rolePack);
  return meta?.displayName ?? rolePack;
}
