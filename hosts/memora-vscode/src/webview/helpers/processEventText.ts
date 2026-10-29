/**
 * 过程事件文案与分型 — 纯函数集（无 DOM 副作用，webview 沙箱内可用）
 *
 * 自 `webview/scripts/chatView.ts` 过程事件渲染区迁出（2026-10-29 纯搬迁，非复制：
 * chatView 侧已删除原体，经本文件 import 引用）。搬迁动机 = chatView.ts 行数闸门
 * （max-lines 只降不升），本批函数零闭包状态、零 DOM 依赖，符合 helpers 落点纪律。
 *
 * 消费方：chatView（webview）—— 过程流渲染（叙述行 / 工具行 / 轮收尾摘要 / 日期分组 /
 * 任务项归组）。行为级覆盖见 `__tests__/chatView.test.ts`（经 DOM 驱动不变），
 * 本文件单测 `__tests__/processEventText.test.ts` 锁纯函数边界。
 *
 * **webview 沙箱约束**（同 toolNameMap）：webview 运行时对内核只有 `import type`、
 * 无运行时依赖（esbuild `platform: 'browser'` / `format: 'iife'` 单独打包）——
 * 本文件引用内核类型一律 `import type`，运行时依赖只有同目录 `toolNameMap`。
 */

import type { ProcessEvent, ProcessThinkingPhase } from '@zooique/memora';
import { getToolDisplayName } from './toolNameMap.js';

/** 本地时区 YYYY-MM-DD 日期键。
 *  ⚠️ **镜像点（刻意为之，勿强行收口）**：内核同语义真源 = `src/utils/time.ts` 的
 *  `formatDateKey`（宿主 Node 侧 chatPanel / sessionStore 即 import 它）。webview 侧**不能**
 *  复用——本文件由 esbuild 以 `platform: 'browser'` / `format: 'iife'` 单独打包
 *  （esbuild.config.mjs 步骤 3），webview 运行时对内核只有 `import type`、无运行时依赖。
 *  故此处为**必要镜像**：改判定口径（换格式 / 改时区）须**两侧同改**。
 *  等价关系：内核 `todayDate()` = 本文件 `toDateKey(new Date())`。
 *  背景：用本地时区（getFullYear/getMonth/getDate）而非 `toISOString().slice(0,10)`（UTC）——
 *  Asia/Shanghai 凌晨 00:00–08:00 期间 UTC 仍是前一天，会导致跨天分组错位。 */
export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** thinking 阶段 → 中文标签（展示面）。相位取值来自内核 **`ProcessThinkingPhase`**
 *  （memory/roundStore.ts，随 ProcessEvent 下发）；勿误引 agent 层类型 `ThinkingPhase`
 *  ——那是 agent/types.ts 的**另一个类型**（当前同值，但非同一符号、非本条数据来源）。 */
export function phaseLabel(phase: ProcessThinkingPhase): string {
  const map: Record<ProcessThinkingPhase, string> = {
    assembling: '装配上下文中…',
    llm_calling: '调用模型中…',
    processing: '处理中…',
    archiving: '归档记忆中…',
  };
  // `?? '思考中…'` 是**有意保留的兜底，不属「类型兜底残留」**——勿按本文件
  // 计划栏状态标签（PLAN_ITEM_STATUS_LABEL，同包枚举）的「枚举固定、无需运行时兜底」原则删掉它：
  // 相位经 postMessage 跨进程到达且**未经运行时校验**，且 replay 会把旧持久化轮的
  // 事件原样重放——历史轮文件可能携带已下线的 `recalling`（现归并为 `assembling`）。
  // 删兜底 → 旧数据渲染出 `undefined`（用户可见的破图）。
  return map[phase] ?? '思考中…';
}

/**
 * 工具 → 行动叙述生成器（SSOT：任务过程文字化）
 *
 * 对齐 Trae「执行过程」的工程侧人话渲染（"调用了 X 技能 / 浏览了 N 个网页"）：
 * 由工具名 + args 关键参数确定性生成「读取文件：path」式叙述，零 LLM 成本。
 * 参数名与 src/agent/builtinTools.ts（ToolDefinition.parameters）一一对应。
 * 兜底纪律：未收录工具 / 参数缺失 / args 非 JSON 均回退中文显示名（toolNameMap 单一真源）；
 * 中文名亦未收录的角色包自定义工具才落到原生英文名（零遗漏）；
 * 原始 args JSON 仍保留在折叠 pre 中（细节不丢）。
 */
type ToolActionFn = (args: Readonly<Record<string, unknown>>) => string | undefined;

/** 工具 → 行动叙述映射（未收录键 → 回退原生工具名） */
const TOOL_ACTION_LABELS: Record<string, ToolActionFn> = {
  read_file: (a) => {
    const p = argStr(a, 'path');
    return p ? `读取文件：${p}` : undefined;
  },
  write_file: (a) => {
    const p = argStr(a, 'path');
    return p ? `写入文件：${p}` : undefined;
  },
  delete_file: (a) => {
    const p = argStr(a, 'path');
    return p ? `删除文件：${p}` : undefined;
  },
  list_dir: (a) => {
    const p = argStr(a, 'path');
    return p ? `浏览目录：${p}` : '浏览项目目录';
  },
  search_project: (a) => {
    const q = argStr(a, 'query');
    return q ? `搜索项目：${q}` : '列出项目文件';
  },
  search_memories: (a) => {
    const q = argStr(a, 'query');
    return q ? `检索记忆：${q}` : undefined;
  },
  web_search: (a) => {
    const q = argStr(a, 'query');
    return q ? `联网搜索：${q}` : undefined;
  },
  web_fetch: (a) => {
    const u = argStr(a, 'url');
    return u ? `浏览网页：${u}` : undefined;
  },
  // run_code 双模式：script_path（执行脚本） vs code（直接执行代码片段）
  run_code: (a) => {
    const script = argStr(a, 'script_path');
    if (script) return `运行脚本：${script}`;
    return argStr(a, 'code') ? '运行代码片段' : undefined;
  },
  run_skill_script: (a) => {
    const skill = argStr(a, 'skill_name');
    const script = argStr(a, 'script_path');
    return script ? `执行技能脚本：${skill ? `${skill}/` : ''}${script}` : undefined;
  },
  // run_command：命令原文是唯一可叙述面。后台模式加「（后台）」标记——
  // 用户看到「执行命令：npm test（后台）」才知道它不会立刻出结果、稍后才有回复，
  // 否则会以为界面卡住了（与本仓「静默空跑 = 比炸更坏」同源纪律：状态必须说出来）。
  run_command: (a) => {
    const cmd = argStr(a, 'command');
    if (!cmd) return undefined;
    return a['background'] === true || a['background'] === 1
      ? `执行命令（后台）：${cmd}`
      : `执行命令：${cmd}`;
  },
  read_skill: (a) => {
    const n = argStr(a, 'name');
    return n ? `读取技能：${n}` : undefined;
  },
  read_resource: (a) => {
    const p = argStr(a, 'resource_path');
    return p ? `读取资源：${p}` : undefined;
  },
  trace_summary: (a) => {
    const s = argStr(a, 'sessionId');
    return s ? `追溯对话记录：${s}` : undefined;
  },
  list_sessions: () => '列出历史会话',
  list_resources: (a) => {
    const n = argStr(a, 'skill_name');
    return n ? `列出技能资源：${n}` : '列出技能资源';
  },
  list_skills: () => '列出可用技能',
  task_table_write: () => '建立任务计划',
  task_table_update: () => '更新任务进度',
  register_work: (a) => {
    const p = argStr(a, 'path');
    return p ? `登记作品：${p}` : undefined;
  },
  compress_context: () => '整理上下文空间',
};

/** 安全取工具 args 的字符串参数（args 为 JSON 解析后的对象；类型不符 / 空返回 undefined） */
export function argStr(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 解析工具 args JSON → 对象；非 JSON / 空返回空对象（叙述按缺参回退原生工具名） */
export function parseToolArgs(raw: string | undefined): Readonly<Record<string, unknown>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 工具行动叙述：命中映射且参数齐备 → 人话描述；否则回退中文显示名（再回退原生工具名）
 *
 * 兜底走 toolNameMap.getToolDisplayName（**工具中文名的唯一真源**）——两类场景在 UI 上
 * 不裸露英文工具名：①未收录工具——ask_user /
 * remember_intel / run_project_script / run_team_meeting（均无可叙述参数，故不入
 * TOOL_ACTION_LABELS）；②已收录但本次 args 缺参（如 read_file 无 path）。
 */
export function toolActionLabel(name: string, argsRaw: string | undefined): string {
  return TOOL_ACTION_LABELS[name]?.(parseToolArgs(argsRaw)) ?? getToolDisplayName(name);
}

/** 工具动作分型（收尾叙述句的分组依据，语义与 TOOL_ACTION_LABELS 对齐） */
export type ToolActionType = 'read' | 'search' | 'write' | 'run' | 'other';

/** 工具名 → 动作分型（未收录归 other） */
export function toolActionType(name: string): ToolActionType {
  if (
    name === 'read_file' ||
    name === 'read_skill' ||
    name === 'read_resource' ||
    name === 'trace_summary' ||
    name === 'web_fetch'
  )
    return 'read';
  if (
    name === 'web_search' ||
    name === 'search_project' ||
    name === 'search_memories' ||
    name === 'list_dir' ||
    name === 'list_sessions' ||
    name === 'list_resources' ||
    name === 'list_skills'
  )
    return 'search';
  if (
    name === 'write_file' ||
    name === 'delete_file' ||
    name === 'register_work' ||
    name === 'task_table_write' ||
    name === 'task_table_update'
  )
    return 'write';
  if (
    name === 'run_code' ||
    name === 'run_skill_script' ||
    name === 'run_command' ||
    name === 'kill_command'
  )
    return 'run';
  return 'other';
}

/** 耗时格式化：≥60s 显示「x m y s」，否则「x.x s」 */
export function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 100) / 10;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

/** 轮事件流里全部工具名（按 tool_start 序）——工具叙述的唯一取材点 */
export function toolStartNames(events: ProcessEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'tool_start' ? [e.payload.name] : []));
}

/**
 * 工具叙述句（**唯一形成点**）：「工具×N（读取文件 2 · 网络搜索 1）」
 *
 * **词表单一**：句内一律用工具显示名（`getToolDisplayName` = 中文名唯一真源），与工具行叙述
 * （`toolActionLabel`）同词表。轮摘要若另按类别粗分（「读取 2 · 搜索 1」）会形成第二套词汇
 * ——同一次调用在屏上被叫成两种名字，且两套映射表可按不同节奏更新。
 * **不参与成句的工具**：`toolActionType === 'other'`（未知 / 自定义 / 空间整理类）只计入 N、
 * 不占一段，避免用无法辨识的名撑长句子误导读者。
 * **段序**：按工具首次出场序（Map 插入序），与过程流的发生顺序一致，便于回看。
 *
 * 消费方二：轮收尾摘要（整轮）与工具批标题（单批）——同一函数、同一词表，只有取材范围不同。
 *
 * @param names 工具英文名序列（按出场序）
 * @returns 叙述句；无工具返回空串（调用方据此省略整段）
 */
export function toolSummaryText(names: readonly string[]): string {
  if (names.length === 0) return '';
  const counts = new Map<string, number>();
  for (const name of names) {
    if (toolActionType(name) === 'other') continue;
    const label = getToolDisplayName(name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([label, n]) => `${label} ${n}`);
  return parts.length > 0
    ? `工具×${names.length}（${parts.join(' · ')}）`
    : `工具×${names.length}`;
}

/**
 * 审查次数（运行时与重放同一函数）
 *
 * 原 `countEvents` 还兼算工具分型（reads/searches/writes/runs），随着工具叙述改由
 * `toolSummaryText` 承担，那些字段全部清零消费者 → 一并按「不用就删」清掉，避免僵尸结构。
 */
export function countReviews(events: ProcessEvent[]): number {
  return events.filter((e) => e.type === 'self_review').length;
}

/**
 * 任务项级折叠容器：把 narrate/tool 按 plan_item_boundary 归组。
 * 先在清除式重建时清理旧任务项容器，再按事件 seq 定位应归入的任务项组：
 *   - 无任何 plan_item_boundary → 返回 details 本身（整轮一组，退回扁平现状）；
 *   - 有 plan_item_boundary → 返回最近一条任务项级边界（seq ≤ 目标 seq）所属的任务项折叠块容器，
 *     懒创建（summary 显示「任务项 N · 标题」），保证边界后的过程事件归入对应任务项分组。
 * 调用方用返回值替换 details 作为节点插入目标，实现「边界切组、任务项内平铺」。
 */
export function isPlanItemBoundaryEvent(
  e: ProcessEvent,
): e is Extract<ProcessEvent, { type: 'plan_item_boundary' }> {
  return e.type === 'plan_item_boundary';
}
