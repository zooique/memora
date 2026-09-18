/**
 * 工具名中文/图标映射 — 纯函数（webview 运行时脚本直接 import 使用）
 *
 * 阶段 B（对抗评估 P2-1）：原「字符串注入脚本」已由外部脚本 chatView.js + 模块
 * 导入取代，getToolDisplayName 作为纯函数被 chatView import（round-block § 工具调用
 * 中文名来源），可直接 vitest 测试。
 *
 * **键集合对齐约束**：本映射的键须与内核内置工具清单（src/agent/builtinTools.ts 的
 * 工具 name）保持一致——webview 沙箱不可 import 内核，故由本文件显式对齐维护；
 * 新增内置工具时须同步补键（否则工具卡片回退英文名/通用图标），删除工具时须删幽灵键。
 * 2026-09-18 排雷对齐：删除幽灵键（memory_search/create_skill/create_rule，内核零存在），
 * 补齐缺失的 17 个内置工具（trace_summary/ask_user/remember_intel/compress_context 等）。
 */

/**
 * 工具英文名 → 中文显示名；未知工具回退原值
 *
 * @param name 工具原始英文名（snake_case）
 * @returns 中文标签或原值
 */
export function getToolDisplayName(name: string): string {
  const map: Record<string, string> = {
    ask_user: '询问用户',
    compress_context: '压缩上下文',
    delete_file: '删除文件',
    list_dir: '列出目录',
    list_resources: '列出资源',
    list_sessions: '列出会话',
    list_skills: '列出技能',
    read_file: '读取文件',
    read_resource: '读取资源',
    read_skill: '读取技能',
    register_work: '登记作品',
    remember_intel: '记住情报',
    run_code: '运行代码',
    run_project_script: '运行项目脚本',
    run_skill_script: '运行技能脚本',
    run_team_meeting: '团队会议',
    search_memories: '搜索记忆',
    search_project: '项目搜索',
    task_table_update: '更新任务表',
    task_table_write: '写入任务表',
    trace_summary: '追溯摘要',
    web_fetch: '抓取网页',
    web_search: '网络搜索',
    write_file: '写入文件',
  };
  return map[name] || name;
}

/**
 * 工具英文名 → 图标（emoji）；未知工具回退通用齿轮
 *
 * 供工具调用卡片 header 前缀展示（ui-redesign.md §6.1 工具卡片加图标），
 * 提升扫读与「谁在做什么」的视觉识别。纯函数，可 vitest 测试。键集合同
 * getToolDisplayName 对齐内核内置工具清单。
 *
 * @param name 工具原始英文名（snake_case）
 * @returns 图标 emoji 或通用 ⚙️
 */
export function getToolIcon(name: string): string {
  const iconMap: Record<string, string> = {
    ask_user: '❓',
    compress_context: '🗜️',
    delete_file: '🗑️',
    list_dir: '📁',
    list_resources: '🗃️',
    list_sessions: '📇',
    list_skills: '📚',
    read_file: '📄',
    read_resource: '📂',
    read_skill: '📘',
    register_work: '🏷️',
    remember_intel: '💡',
    run_code: '💻',
    run_project_script: '🚀',
    run_skill_script: '🔧',
    run_team_meeting: '👥',
    search_memories: '🔍',
    search_project: '🗂️',
    task_table_update: '📝',
    task_table_write: '📋',
    trace_summary: '🧾',
    web_fetch: '🌍',
    web_search: '🌐',
    write_file: '✏️',
  };
  return iconMap[name] || '⚙️';
}