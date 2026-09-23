/**
 * 工具名中文映射 — 纯函数（工具中文名的**单一真源**）
 *
 * 消费方：
 *   · chatView（webview）—— 工具行叙述兜底 toolActionLabel / 准备中态 renderPendingToolRow /
 *     写入审批卡 renderWriteConfirmCard；
 *   · chatPanel（extension）—— 写入确认描述 bindWriteConfirmation。
 *
 * **键集合对齐约束**：本映射的键须与内核内置工具清单（完整面 = ToolExecutor.builtinDefinitions：
 * 20 常驻 + 4 能力门控 web_search/web_fetch/run_code/search_project）保持一致——webview 沙箱
 * 不可 import 内核，故由本文件显式对齐维护；新增内置工具时须同步补键（否则工具卡片回退英文名），
 * 删除工具时须删幽灵键。守卫：helpers/__tests__/toolNameMap.test.ts 双向闭合断言（读内核源码）。
 *
 * **图标立场**：本模块**只承载中文名，不承载图标**。项目唯一的图标语言 =
 * `webview/scripts/icons.ts` 的 Trae 柔和线条 SVG（stroke=currentColor / 1.5 / 圆端），
 * emoji 是彩色像素图，跨平台渲染不一且不跟随主题色。工具图标若要补，正解是往 `icons.ts`
 * 的 ICON_PATHS 补 path（组内已有 `'team'` 等工具语义先例），而非在此另立一套。
 */

/**
 * 工具中文名表（**键集合单源**）
 *
 * 模块级常量建表一次，避免每次调用重建一次对象（坑：建在函数体内则每次调用都重建）。
 */
const TOOL_LABELS: Record<string, string> = {
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

/**
 * 工具英文名 → 中文显示名；未知工具回退原值
 *
 * @param name 工具原始英文名（snake_case）
 * @returns 中文标签或原值
 */
export function getToolDisplayName(name: string): string {
  return TOOL_LABELS[name] || name;
}
