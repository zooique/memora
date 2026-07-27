/**
 * 角色名显示映射 — 纯函数工具
 *
 * 职责：
 * - 将角色内部名（如 ai_agent_role / default / snake_case 命名）映射为用户可读的显示名
 * - 已知内部名返回对应中文，蛇形命名转空格大写格式，其他原样返回
 *
 * 设计原则：
 * - 纯函数，无副作用，无状态
 * - 与 sourceLabel.ts / perceptionLabels.ts 同层，作为 label 相关的共享工具
 * - 消除 personaPanelManager.formatDisplayName 私有方法在消息底部角色标签场景的重复实现
 *
 * 消费点：
 * - personaPanelManager.ts（角色下拉菜单 + 顶栏角色名）
 * - chatPanelManager.ts（消息底部角色标签）
 */

/**
 * 已知内部角色名 → 显示名映射表
 *
 * 内部名约定来自 PersonaManager.createDefaultPersona()（name: 'default'）
 * 与历史兼容名 ai_agent_role / assistant。
 */
const PERSONA_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ai_agent_role: '精灵',
  default: '精灵',
  assistant: '助手',
};

/**
 * 将内部角色名转换为用户友好的显示名
 *
 * 转换规则：
 * 1. 已知内部名（ai_agent_role → 精灵）使用固定映射
 * 2. 蛇形命名（snake_case）转换为空格分隔，每个单词首字母大写
 * 3. 已经是中文或已有友好格式的名称保持不变
 *
 * @param internalName 角色内部名（如文件名 ai_agent_role 或 default）
 * @returns 用户可读的显示名
 */
export function formatPersonaDisplayName(internalName: string): string {
  // 已知内部角色名映射
  if (PERSONA_DISPLAY_NAMES[internalName]) {
    return PERSONA_DISPLAY_NAMES[internalName];
  }
  // 蛇形命名转换（snake_case → "Snake Case"，中文不转换）
  if (/^[a-z][a-z0-9_]*$/.test(internalName)) {
    return internalName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return internalName;
}
