/**
 * 工具名展示映射 — 纯函数（工具展示名的**单一真源**）
 *
 * 消费方（**跨平面，两侧各用本地化器**）：
 *   · chatView（webview）—— 准备中态 renderPendingToolRow 及过程流取名；
 *   · helpers/processEventText（webview）—— 工具行叙述兜底 toolActionLabel 与轮收尾
 *     叙述句 toolSummaryText（2026-10-29 自 chatView.ts 迁出）；
 *   · extension/host/confirmCoordinator（宿主）—— 确认卡描述与决策记录 logLabel。
 *
 * **键集合对齐约束**：本映射的键须与内核内置工具清单（完整面 = ToolExecutor.allToolDefinitions：
 * 23 常驻 + 5 能力门控 web_search/web_fetch/run_code/search_project/delegate_task，合计 28）
 * 保持一致——webview 沙箱
 * 不可 import 内核，故由本文件显式对齐维护；新增内置工具时须同步补键（否则工具卡片回退英文名），
 * 删除工具时须删幽灵键。守卫：helpers/__tests__/toolNameMap.test.ts 双向闭合断言（读内核源码）。
 *
 * **图标立场**：本模块**只承载展示名（英文源键），不承载图标**。项目唯一的图标语言 =
 * `webview/scripts/icons.ts` 的 Trae 柔和线条 SVG（stroke=currentColor / 1.5 / 圆端），
 * emoji 是彩色像素图，跨平台渲染不一且不跟随主题色。工具图标若要补，正解是往 `icons.ts`
 * 的 ICON_PATHS 补 path（组内已有 `'team'` 等工具语义先例），而非在此另立一套。
 */

/**
 * 工具英文名 → 展示名（**键集合单源**）
 *
 * 模块级常量建表一次，避免每次调用重建一次对象（坑：建在函数体内则每次调用都重建）。
 *
 * **值 = 英文源文案（即 l10n 键），不是最终显示文本**（B9-A 起）：本表被 webview 与
 * extension host **两侧共用**（见文件头消费方），两侧的本地化器不同（webview 是
 * `@vscode/l10n` 的 namespace `t()`，宿主是 `vscode.l10n.t()`）——在表内写死任一个都会让
 * 另一侧失效。故本表只存键、由**消费侧**过各自 `t()`（范式同 helpers/capabilityLabels）。
 * `// @nls-keys` 标记让 verify-nls 判据⑮ 把这些值收进 bundle 键面（否则动态 `t(值)` 脱管）。
 */
// @nls-keys
const TOOL_LABELS: Record<string, string> = {
  ask_user: 'Ask user',
  compress_context: 'Compress context',
  delete_file: 'Delete file',
  delegate_task: 'Delegate task',
  kill_command: 'Stop background command',
  list_dir: 'List directory',
  list_resources: 'List resources',
  list_sessions: 'List sessions',
  list_skills: 'List skills',
  read_file: 'Read file',
  read_image: 'Read image',
  read_resource: 'Read resource',
  read_skill: 'Read skill',
  register_work: 'Register work',
  remember_intel: 'Remember intel',
  run_code: 'Run code',
  run_command: 'Run command',
  run_project_script: 'Run project script',
  run_skill_script: 'Run skill script',
  run_team_meeting: 'Team meeting',
  search_memories: 'Search memories',
  search_project: 'Search project',
  task_table_update: 'Update task table',
  task_table_write: 'Write task table',
  trace_summary: 'Trace summary',
  web_fetch: 'Fetch web page',
  web_search: 'Web search',
  write_file: 'Write file',
};

/**
 * 工具英文名 → 展示名（英文源键）；未知工具回退原值
 *
 * @param name 工具原始英文名（snake_case）
 * @returns l10n 键（英文源文案）或原值——**调用方负责过各自本地化器**
 */
export function getToolDisplayName(name: string): string {
  return TOOL_LABELS[name] || name;
}
