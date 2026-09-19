/**
 * 工具名中文映射 — 纯函数（工具中文名的**单一真源**）
 *
 * 消费方（2026-09-19 接入）：
 *   · chatView（webview）—— 工具行叙述兜底 toolActionLabel / 准备中态 renderPendingToolRow /
 *     写入审批卡 renderWriteConfirmCard；
 *   · chatPanel（extension）—— 写入确认描述 bindWriteConfirmation。
 * 接入前本模块**零生产消费**：chatView 兜底直接回退英文原名（内置工具在缺参场景裸露英文名），
 * chatPanel 另自带一张四键 toolMap（三键幽灵、write_file 异名「写文件」）。
 *
 * **键集合对齐约束**：本映射的键须与内核内置工具清单（完整面 = ToolExecutor.builtinDefinitions：
 * 20 常驻 + 4 能力门控 web_search/web_fetch/run_code/search_project）保持一致——webview 沙箱
 * 不可 import 内核，故由本文件显式对齐维护；新增内置工具时须同步补键（否则工具卡片回退英文名），
 * 删除工具时须删幽灵键。守卫：helpers/__tests__/toolNameMap.test.ts 双向闭合断言（读内核源码）。
 * 2026-09-18 排雷对齐：删除幽灵键（memory_search/create_skill/create_rule，内核零存在），
 * 补齐缺失的 17 个内置工具（trace_summary/ask_user/remember_intel/compress_context 等）。
 *
 * **图标立场（2026-09-19）**：本模块**只承载中文名，不承载图标**。原附带的 24 键 emoji 表
 * （getToolIcon）已剪除，两条理由都在实证上：①**零消费**——其 JSDoc 引用的
 * `ui-redesign.md §6.1`（工具卡片加图标）中该文档已归档不在仓库，且 host-overview 记录的工具
 * 卡片落地形态为「状态左边框色 + 胶囊」、无图标位，即该 emoji 方案从未进入实施；②**双图标
 * 语言**——项目唯一的图标语言 = `webview/scripts/icons.ts` 的 Trae 柔和线条 SVG
 * （stroke=currentColor / 1.5 / 圆端），emoji 是彩色像素图，跨平台渲染不一且不跟随主题色。
 * 工具图标若将来要有，正解是往 `icons.ts` 的 ICON_PATHS 补 path（组内已有 `'team'` 等工具
 * 语义语义先例），而非在此另立一套。
 */

/**
 * 工具中文名表（**键集合单源**）
 *
 * 提升为模块级常量：原实现在函数体内建表，每次调用重建一次对象。
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
