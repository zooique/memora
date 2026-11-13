/**
 * strategyKeyMeta — 策略键展示元数据（SSOT）+ 详情值本地化（纯数据 / 纯函数）
 *
 * 从 `webview/scripts/rolesView.ts` 抽出（2026-10-26）。抽出理由有二：
 *   ① rolesView 顶到 1149 行闸门，而这三块零闭包依赖、纯数据纯函数；
 *   ② 与 `capabilityLabels.ts` 同类（「领域无关的展示映射表」），落点有一致先例。
 * 渲染 chip / 详情行的逻辑仍在 rolesView（依赖 document），本文件只提供数据与格式化。
 *
 * 为什么在 webview 而非内核：内核领域无关，不背任何自然语言文案（四层分工，方案 §2）。
 * **值全为英文源键**（B3 起）：渲染/格式化时统一过 `@vscode/l10n` 的 `t()`；默认语言下
 * 原样返回英文即用户看到的文案，zh-cn 由 `l10n/bundle.l10n.zh-cn.json` 提供译文。
 * 降级保护：内核新键宿主未配标签 → 格子照常出现（数据来自键面），标签/提示兜底显示键名原文。
 * 守卫：`__tests__/rolesKeyface.test.ts` 双向锁定本映射键集 ↔ 内核 describeStrategyKeys() 键集，
 * 内核加键漏翻译 / 本表拼错键名都会红（防「键名拼错静默失败」，内核对未知键只 warning）。
 */
import * as l10n from '@vscode/l10n';

/** 单键元数据（STRATEGY_KEY_META 值类型）：标签 + 悬停含义 + 可选值映射 */
export interface StrategyKeyMetaEntry {
  /** 名称（格子标签；英文源键） */
  label: string;
  /** 悬停含义（一句话：这个键管什么 + 留空行为；英文源键） */
  tip: string;
  /** 枚举值映射（enum 键用；缺省显示原文） */
  valueLabels?: Record<string, string>;
  /** 多选选项映射（multi 键用；缺省显示原文） */
  optionLabels?: Record<string, string>;
}

/**
 * 策略键展示元数据（键名 → 标签 + 悬停含义）。
 *
 * 键集必须与内核 `describeStrategyKeys()` 的键集双向相等（守卫见文件头）。
 * 加键顺序 = 键面出现序，供阅读参考，不作判据。
 * `@nls-keys` 标记让 `scripts/verify-nls.mjs` 判据⑨ 把本表所有字符串值纳入键面。
 */
// @nls-keys
export const STRATEGY_KEY_META: Record<string, StrategyKeyMetaEntry> = {
  summaryFocus: {
    label: 'Summary focus',
    tip: 'Tells the memory summary which direction to distill (e.g. code, creative); up to 500 characters. Leave blank for a general summary.',
  },
  toolMode: {
    label: 'Tool mode',
    tip: 'allow = tools may be used; block = pure conversation with no tool execution',
    valueLabels: { allow: 'Allow tools', block: 'Block tools' },
  },
  temperature: {
    label: 'Temperature',
    tip: 'Higher is more creative, lower is more stable (0.0–2.0). Leave blank for the default 0.7.',
  },
  outputLimit: {
    label: 'Output limit',
    tip: 'Maximum tokens for a single-turn answer; 0 or blank = no intervention (use the model or provider default)',
  },
  toolStepLimit: {
    label: 'Tool step limit',
    tip: 'Maximum tool steps per turn (0 = unlimited). Leave blank for the default.',
  },
  subagentConcurrency: {
    label: 'Subagent concurrency',
    // 刻意不写数字：合法区间由 rolesView 追加键面 range（内核同源），缺省语义用「blank = kernel default」
    tip: 'Maximum subagents running in parallel within one tool-call batch (0 = disable delegation; blank = kernel default). Out-of-range values are rejected, not silently clamped. This quota never makes the model parallelize on its own.',
  },
  providerRouting: {
    label: 'Model routing',
    tip: 'auto = choose a model by task; fixed = pin the current model',
    valueLabels: { auto: 'Automatic routing', fixed: 'Fixed model' },
  },
  multiStepReasoning: {
    label: 'Multi-step reasoning',
    tip: 'auto = think deeper on complex tasks; manual = answer quickly and directly',
    valueLabels: { auto: 'Automatic reasoning', manual: 'Manual reasoning' },
  },
  toolReadonly: {
    label: 'Tool permissions',
    tip: 'full = full read and write; readonly = read-only operations only (safer)',
    valueLabels: { full: 'Full permissions', readonly: 'Read-only mode' },
  },
  summary: {
    label: 'Memory summary',
    tip: 'on = generate a memory summary after each turn; off = do not generate',
    valueLabels: { on: 'On', off: 'Off' },
  },
  selfReview: {
    label: 'Self-review',
    tip: 'When on, review the answer once before delivering it; off = no self-review',
  },
  userFollowup: {
    label: 'Follow-up strategy',
    tip: 'ask = ask back proactively when the task is unclear; silent = only wait for user input',
    valueLabels: { ask: 'Ask proactively', silent: 'Wait silently' },
  },
  askOn: {
    label: 'When to ask',
    tip: 'Situations where the role may ask you questions; multiple choices allowed. None checked = never ask proactively.',
    optionLabels: {
      ambiguity: 'When the task is ambiguous',
      decision: 'When a decision is needed',
      missing_info: 'When information is missing',
      confirm: 'Confirm before executing',
    },
  },
  askLimit: {
    label: 'Question limit',
    tip: 'How many proactive questions per turn (1–10)',
  },
  webSearchLimit: {
    label: 'Web search limit',
    tip: 'How many web searches per turn (1–20; searching stops when exceeded). Leave blank for the default 6.',
  },
  errorHandling: {
    label: 'Error handling',
    tip: 'What to do when a tool or model fails: retry = try again, degrade = continue degraded, stop = end this turn',
    valueLabels: { retry: 'Retry', degrade: 'Continue degraded', stop: 'Stop' },
  },
  contextLimit: {
    label: 'Context limit',
    tip: 'Context size in tokens set by the role; the smaller of this and the model window is used. 0 or blank = follow the model window.',
  },
  stepBudget: {
    label: 'Step budget',
    tip: 'Maximum "think + use tools" iterations in this turn (10–500); 0 or blank = the default 50',
  },
};

/**
 * 用开关（而非数字框）呈现的策略键
 *
 * 为什么不放进 {@link STRATEGY_KEY_META}：`@nls-keys` 标记声明「本块内所有字符串值都是文案键」，
 * 守卫会把块内任意 `x: '字符串'` 都当键采集。把非文案的控件形态塞进同一张表，会让 `'switch'`
 * 变成 bundle 里的假键（孤儿键判据反过来又会报它）。故单列于此。
 *
 * 语义：selfReview 是布尔数字语义（0 = 关 / 正整数归一为 1），用开关比数字框更贴切。
 */
export const SWITCH_CONTROL_KEYS: ReadonlySet<string> = new Set(['selfReview']);

/** 详情值渲染：数组（askOn 多选）逐项走选项映射，命中 optionLabels 才过 l10n、未命中项原样返回；标量命中 valueLabels 才过 l10n，未命中原样返回；对象走 JSON 兜底 */
export function formatDetailValue(meta: StrategyKeyMetaEntry | undefined, value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        const label = meta?.optionLabels?.[String(v)];
        return label ? l10n.t(label) : String(v);
      })
      .join(' / ');
  }
  const s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  const label = meta?.valueLabels?.[s];
  return label ? l10n.t(label) : s;
}
