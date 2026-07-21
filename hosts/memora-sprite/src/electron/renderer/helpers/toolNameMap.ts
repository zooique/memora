/**
 * 工具名中文映射（P1-5 用户体验打磨）
 *
 * 职责：
 *   将工具原始英文名（如 read_file）映射为用户可理解的中文标签（如"读取文件"）。
 *   让工具调用卡片显示中文工具名，而非英文 snake_case 原值。
 *
 * 设计原则：
 *   - 纯函数 + 只读映射表，无副作用
 *   - 未知工具降级为原值（不破坏显示）
 *   - 内核 4 个内置工具 + sprite 4 个自定义工具，共 8 项
 *
 * 来源：
 *   - 内核工具：memora/src/agent/builtinTools.ts（read_file/write_file/list_dir/search_memories）
 *   - 精灵工具：memora-sprite/src/sprite/tools.ts（web_search/memory_search/create_persona/create_skill）
 */

/**
 * 工具名中文映射表（只读，禁止运行时修改）
 *
 * key 为工具原始名（snake_case），value 为用户可理解的中文标签。
 * 未知工具降级为原值（getToolDisplayName 内 ?? name 兜底）。
 */
const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  // ─── 内核内置工具（memora/src/agent/builtinTools.ts） ───
  read_file: '读取文件',
  write_file: '写入文件',
  list_dir: '列出目录',
  search_memories: '搜索记忆',
  // ─── 精灵自定义工具（memora-sprite/src/sprite/tools.ts） ───
  web_search: '网络搜索',
  memory_search: '记忆搜索',
  create_persona: '创建角色',
  create_skill: '创建技能',
};

/**
 * 获取工具的中文显示名（P1-5 用户体验打磨）
 *
 * 未知工具降级为原值，保证显示不中断。
 *
 * @param name 工具原始名（如 read_file）
 * @returns 中文显示名（如"读取文件"），未知工具返回原值
 */
export function getToolDisplayName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}
