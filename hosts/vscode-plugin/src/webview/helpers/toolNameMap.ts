/**
 * 工具名中文映射 — 纯函数（webview 运行时脚本直接 import 使用）
 *
 * 阶段 B（对抗评估 P2-1）：原「字符串注入脚本」已由外部脚本 chatView.js + 模块
 * 导入取代，getToolDisplayName 作为纯函数被 toolCard/chatView import，可直接
 * vitest 测试。
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
