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
import * as l10n from '@vscode/l10n';
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

/** thinking 阶段 → 展示标签。相位取值来自内核 **`ProcessThinkingPhase`**
 *  （memory/roundStore.ts，随 ProcessEvent 下发）；勿误引 agent 层类型 `ThinkingPhase`
 *  ——那是 agent/types.ts 的**另一个类型**（当前同值，但非同一符号、非本条数据来源）。 */
export function phaseLabel(phase: ProcessThinkingPhase): string {
  // 值 = 英文源键（l10n 键面）：本模块在 `initWebviewL10n` 之前即被 import，
  // 表内**不可**预解析成译文（早于 config 的 t() 只会拿到键）——故解析放在调用时
  // @nls-keys
  const map: Record<ProcessThinkingPhase, string> = {
    assembling: 'Assembling context…',
    llm_calling: 'Calling model…',
    processing: 'Processing…',
    archiving: 'Archiving memory…',
  };
  // `?? 'Thinking…'` 是**有意保留的兜底，不属「类型兜底残留」**——勿按本文件
  // 计划栏状态标签（PLAN_ITEM_STATUS_LABEL，同包枚举）的「枚举固定、无需运行时兜底」原则删掉它：
  // 相位经 postMessage 跨进程到达且**未经运行时校验**，且 replay 会把旧持久化轮的
  // 事件原样重放——历史轮文件可能携带已下线的 `recalling`（现归并为 `assembling`）。
  // 删兜底 → 旧数据渲染出 `undefined`（用户可见的破图）。
  const key = map[phase];
  return key ? l10n.t(key) : l10n.t('Thinking…');
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
    return p ? l10n.t('Read file: {0}', p) : undefined;
  },
  // read_image：与 read_file 同参数面（path），叙述里露出图片路径才有可追溯性
  read_image: (a) => {
    const p = argStr(a, 'path');
    return p ? l10n.t('Read image: {0}', p) : undefined;
  },
  write_file: (a) => {
    const p = argStr(a, 'path');
    return p ? l10n.t('Write file: {0}', p) : undefined;
  },
  delete_file: (a) => {
    const p = argStr(a, 'path');
    return p ? l10n.t('Delete file: {0}', p) : undefined;
  },
  list_dir: (a) => {
    const p = argStr(a, 'path');
    return p ? l10n.t('Browse directory: {0}', p) : l10n.t('Browse project directory');
  },
  search_project: (a) => {
    const q = argStr(a, 'query');
    return q ? l10n.t('Search project: {0}', q) : l10n.t('List project files');
  },
  search_memories: (a) => {
    const q = argStr(a, 'query');
    return q ? l10n.t('Search memories: {0}', q) : undefined;
  },
  web_search: (a) => {
    const q = argStr(a, 'query');
    return q ? l10n.t('Web search: {0}', q) : undefined;
  },
  web_fetch: (a) => {
    const u = argStr(a, 'url');
    return u ? l10n.t('Browse page: {0}', u) : undefined;
  },
  // run_code 双模式：script_path（执行脚本） vs code（直接执行代码片段）
  run_code: (a) => {
    const script = argStr(a, 'script_path');
    if (script) return l10n.t('Run script: {0}', script);
    return argStr(a, 'code') ? l10n.t('Run code snippet') : undefined;
  },
  run_skill_script: (a) => {
    const skill = argStr(a, 'skill_name');
    const script = argStr(a, 'script_path');
    return script
      ? l10n.t('Run skill script: {0}', `${skill ? `${skill}/` : ''}${script}`)
      : undefined;
  },
  // run_command：命令原文是唯一可叙述面。后台模式加「后台」标记——
  // 用户看到「Run command (background): npm test」才知道它不会立刻出结果、稍后才有回复，
  // 否则会以为界面卡住了（与本仓「静默空跑 = 比炸更坏」同源纪律：状态必须说出来）。
  run_command: (a) => {
    const cmd = argStr(a, 'command');
    if (!cmd) return undefined;
    return a['background'] === true || a['background'] === 1
      ? l10n.t('Run command (background): {0}', cmd)
      : l10n.t('Run command: {0}', cmd);
  },
  read_skill: (a) => {
    const n = argStr(a, 'name');
    return n ? l10n.t('Read skill: {0}', n) : undefined;
  },
  read_resource: (a) => {
    const p = argStr(a, 'resource_path');
    return p ? l10n.t('Read resource: {0}', p) : undefined;
  },
  trace_summary: (a) => {
    const s = argStr(a, 'sessionId');
    return s ? l10n.t('Trace conversation: {0}', s) : undefined;
  },
  list_sessions: () => l10n.t('List past sessions'),
  list_resources: (a) => {
    const n = argStr(a, 'skill_name');
    return n ? l10n.t('List skill resources: {0}', n) : l10n.t('List skill resources');
  },
  list_skills: () => l10n.t('List available skills'),
  task_table_write: () => l10n.t('Create task plan'),
  task_table_update: () => l10n.t('Update task progress'),
  register_work: (a) => {
    const p = argStr(a, 'path');
    return p ? l10n.t('Register work: {0}', p) : undefined;
  },
  compress_context: () => l10n.t('Compact context'),
  // delegate_task（条件工具）：唯一可叙述面 = 子任务描述（task）。
  // 与 run_command 不同，这里**要截断**：task 常是整段 prompt，不截断会把主行撑满。
  // 只取首行前 60 字做「这次派了什么」的提示；全文仍在展开体「派发」段（args.task 原文）。
  delegate_task: (a) => {
    const task = argStr(a, 'task');
    if (!task) return undefined;
    const firstLine = task.split(/\r?\n/, 1)[0]?.trim() ?? '';
    return firstLine
      ? l10n.t('Delegate task: {0}', firstLine.slice(0, DELEGATE_TASK_LABEL_MAX_CHARS))
      : undefined;
  },
};

/** delegate_task 主行任务描述上限（字符）：只取首行并截断，避免整段 prompt 撑满主行 */
const DELEGATE_TASK_LABEL_MAX_CHARS = 60;

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
 * 工具行动叙述：命中映射且参数齐备 → 人话描述；否则回退工具显示名（再回退原生工具名）
 *
 * 兜底走 toolNameMap.getToolDisplayName（**工具展示名的唯一真源**，值为英文源键）——
 * 两类场景在 UI 上不裸露英文工具名：①未收录工具——ask_user /
 * remember_intel / run_project_script / run_team_meeting（均无可叙述参数，故不入
 * TOOL_ACTION_LABELS）；②已收录但本次 args 缺参（如 read_file 无 path）。
 * 显示名本身是 l10n 键，故这里再过一次 `l10n.t`（表值不预解析，见 phaseLabel 同注）。
 */
export function toolActionLabel(name: string, argsRaw: string | undefined): string {
  return TOOL_ACTION_LABELS[name]?.(parseToolArgs(argsRaw)) ?? l10n.t(getToolDisplayName(name));
}

/** 工具动作分型（收尾叙述句的分组依据，语义与 TOOL_ACTION_LABELS 对齐） */
export type ToolActionType = 'read' | 'search' | 'write' | 'run' | 'other';

/** 工具名 → 动作分型（未收录归 other） */
export function toolActionType(name: string): ToolActionType {
  if (
    name === 'read_file' ||
    name === 'read_image' ||
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
    name === 'kill_command' ||
    // delegate_task：派发子会话执行独立任务，归「执行」类；现有枚举无更贴合的组名，
    // 且不新造组名（组名是收尾叙述的机器键面，扩容需两侧同改）
    name === 'delegate_task'
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
 * **词表单一**：句内一律用工具显示名（`getToolDisplayName` = 展示名唯一真源，值为英文源键），与工具行叙述
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
    // 显示名是英文源键（toolNameMap 单一真源），此处解析为当前语言的译文
    const label = l10n.t(getToolDisplayName(name));
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([label, n]) => `${label} ${n}`);
  return parts.length > 0
    ? l10n.t('Tools ×{0} ({1})', String(names.length), parts.join(' · '))
    : l10n.t('Tools ×{0}', String(names.length));
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

/* ------------------------------------------------------------------ *
 * 轮块（round-block）文案构建器（HOST-I18N-2 C-1）
 *
 * 迁出动机与上批同源：chatView.ts 行数闸贴死上限 + 文案集中一处才不会出现
 * 「同一小节名两份字面量、改一处漏一处」。全部纯函数，无 DOM 依赖。
 * ------------------------------------------------------------------ */

/** 轮块小节标识（**语言无关的机器键**：`data-section` 的取值面，不是可见文案） */
export type ProcessSectionKind =
  'trace' | 'memoryAdded' | 'background' | 'selfReview' | 'stopped' | 'metrics';

/**
 * 轮块小节标题（可见名）
 *
 * 键/值分离：`data-section` 落 `ProcessSectionKind`（机器键），屏上才吃译文。
 * 若把译文当 DOM 键，语言一变键就变——跨语言的重放/快照将对不上同一小节
 * （同 `data-status` 纪律：机器键与展示标签不共用一套字符串）。
 *
 * @param kind 小节标识
 */
export function processSectionTitle(kind: ProcessSectionKind): string {
  // 值 = 英文源键；解析在调用时（本模块早于 initWebviewL10n 被 import，表内不可预解析）
  // @nls-keys
  const map: Record<ProcessSectionKind, string> = {
    trace: 'Process trace',
    memoryAdded: 'Memories added',
    background: 'Background wrap-up',
    selfReview: 'Self-review output',
    stopped: 'Stopped',
    metrics: 'Run metrics',
  };
  return l10n.t(map[kind]);
}

/**
 * 轮收起态摘要（`耗时 · 工具叙述 · 审查次数`；三者皆无回退「任务过程」）
 *
 * @param input.toolNames  本轮工具名序列（按出场序）
 * @param input.reviews    自审查次数（0 不显示该段）
 * @param input.durationMs 本轮耗时（undefined 不显示该段）
 */
export function buildRoundSummaryText(input: {
  toolNames: readonly string[];
  reviews: number;
  durationMs?: number;
}): string {
  const parts: string[] = [];
  const toolSentence = toolSummaryText(input.toolNames);
  if (toolSentence) parts.push(toolSentence);
  if (input.reviews > 0) parts.push(l10n.t('Reviews: {0}', String(input.reviews)));
  // 耗时置最前：阅读顺序「多久 → 做了什么 → 审查几次」
  if (input.durationMs !== undefined) {
    parts.unshift(l10n.t('Duration: {0}', fmtDuration(input.durationMs)));
  }
  return parts.length > 0 ? parts.join(' · ') : l10n.t('Task process');
}

/**
 * § 执行指标（metrics）小节的多行文案
 *
 * 口径注释随迁（原 chatView 内联注释）：入/出均为**估算值**，「入」是**本轮全部 LLM
 * 调用输入的累加**（每步重发全量上下文，故可远超单轮窗口，**不是**窗口占用率）；
 * 「出」只计正文（不含思考与工具轮叙述）。
 *
 * @param input.finalSuccess              完成判据（success 且无未解析意图、无空响应兜底）
 * @param input.effectiveLimit            本轮**生效**输出上限；undefined = 回服务端默认
 * @param input.unparsedToolIntentCount   >0 才显示（诚实信号：想调工具却未走原生协议）
 * @param input.emptyResponseCount        >0 才显示（末段正文是兜底文案）
 * @param input.truncationRecoveryCount   >0 才显示（曾截断但被换策略重试救回）
 */
export function buildMetricsLines(input: {
  durationMs: number;
  tokenIn: number;
  tokenOut: number;
  effectiveLimit?: number;
  toolFailureCount: number;
  unparsedToolIntentCount: number;
  emptyResponseCount: number;
  truncationRecoveryCount: number;
  finalSuccess: boolean;
}): string[] {
  return [
    l10n.t('Duration: {0}', fmtDuration(input.durationMs)),
    l10n.t(
      'Tokens (estimated): {0} in cumulative / {1} out (excludes thinking)',
      String(input.tokenIn),
      String(input.tokenOut),
    ),
    l10n.t(
      'Output limit (effective): {0}',
      input.effectiveLimit === undefined ? l10n.t('Server default') : String(input.effectiveLimit),
    ),
    l10n.t('{0} tool failures', String(input.toolFailureCount)),
    ...(input.unparsedToolIntentCount > 0
      ? [l10n.t('{0} unparsed tool intents', String(input.unparsedToolIntentCount))]
      : []),
    ...(input.emptyResponseCount > 0
      ? [l10n.t('Empty-response fallbacks: {0}', String(input.emptyResponseCount))]
      : []),
    ...(input.truncationRecoveryCount > 0
      ? [l10n.t('Truncation retries recovered: {0}', String(input.truncationRecoveryCount))]
      : []),
    l10n.t(
      'Complete: {0}',
      input.finalSuccess ? l10n.t('Yes') : l10n.t('No (interrupted or failed)'),
    ),
  ];
}

/** 交互输入种类（问答回顾行的 tag 语义面；与内核 interactiveInputs[].kind 同值域） */
export type QaKind = 'question-answer' | 'supplement' | 'timeout' | 'unanswered';

/**
 * 交互输入 tag 文案（**唯一形成点**）
 *
 * 消费方二：① `qaRowView` 渲染行 tag；② `chatView` 收起态统计 `<tag>×N`。
 * 两处必须同源——曾各自写字面量，「统计」与「行 tag」靠肉眼保持一致。
 */
export function qaKindTag(kind: QaKind): string {
  if (kind === 'supplement') return l10n.t('You added');
  if (kind === 'question-answer') return l10n.t('You answered');
  return l10n.t('Unanswered');
}

/**
 * round-block 任务项标签（summary 上方的「执行任务项 N: 标题」）
 *
 * @param order 任务项序号（**已 +1 的展示序号**；0 基序号由调用方换算，避免在文案层藏算术）
 * @param brief 任务项标题（LLM 产出 → 调用方走 textContent 防注入）
 */
export function planTagText(order: number, brief: string): string {
  return l10n.t('Executing task item {0}: {1}', String(order), brief);
}

/** 进行中工具的行动叙述行（「正在执行：读取文件 xxx」） */
export function runningToolText(name: string, argsRaw: string | undefined): string {
  return l10n.t('Running: {0}', toolActionLabel(name, argsRaw));
}

/**
 * 过程叙述行显示文本：结尾已有标点则原样，否则补冒号
 *
 * 「AI 说什么：」后接工具块是既有形态；冒号字符的中文版式（全角）由 zh 译文给，
 * 代码只持 `{0}:` 这一条英文源键——禁止在代码里判断语言再选标点。
 *
 * @param raw 叙述原文（模型产出，调用方以 textContent 上屏）
 */
export function narrateDisplayText(raw: string): string {
  const text = raw.trim();
  return /[:：。!！?？；;]$/.test(text) ? text : l10n.t('{0}:', text);
}
