/**
 * 工具名中文映射 — 纯函数 + webview 注入脚本（单一真源）
 *
 * 阶段 A（对抗评估 P2-1）：逻辑以可测试的 TS 纯函数为单一真理源，注入脚本由
 * 函数源码序列化生成。webview 仍以内联字符串注入（CSP: script-src 'unsafe-inline'），
 * 把工具原始英文名（如 read_file）映射为用户可理解的中文标签；未知工具降级为原值。
 * 纯函数可被 vitest 直接测试。
 */

/**
 * 工具英文名 → 中文显示名；未知工具回退原值
 *
 * @param name 工具原始英文名（snake_case）
 * @returns 中文标签或原值
 */
export function getToolDisplayName(name: string): string {
  const map: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
    list_dir: '列出目录',
    search_memories: '搜索记忆',
    web_search: '网络搜索',
    memory_search: '记忆搜索',
    web_fetch: '抓取网页',
    create_persona: '创建角色',
    create_skill: '创建技能',
    create_rule: '创建规则',
  };
  return map[name] || name;
}

/** webview 注入脚本：由纯函数源码序列化，与 getToolDisplayName 保持单一真源（P2-1 阶段 A） */
export const toolNameMapScript = `
${getToolDisplayName}`;