/**
 * strategyKeyMeta — 策略键中文元数据（SSOT）+ 详情值本地化（纯数据 / 纯函数）
 *
 * 从 `scripts/rolesView.ts` 抽出（2026-10-26）。抽出理由有二：
 *   ① rolesView 顶到 1149 行闸门，而这三块零闭包依赖、纯数据纯函数；
 *   ② 与 `capabilityLabels.ts` 同类（「领域无关的展示映射表」），落点有一致先例。
 * 渲染 chip / 详情行的逻辑仍在 rolesView（依赖 document），本文件只提供数据与格式化。
 *
 * 为什么在 webview 而非内核：内核领域无关，不背中文文案（四层分工，方案 §2）。
 * 降级保护：内核新键宿主未配标签 → 格子照常出现（数据来自键面），标签/提示兜底显示键名原文。
 * 守卫：`__tests__/rolesKeyface.test.ts` 双向锁定本映射键集 ↔ 内核 describeStrategyKeys() 键集，
 * 内核加键漏翻译 / 本表拼错键名都会红（防「键名拼错静默失败」，内核对未知键只 warning）。
 */

/** 单键中文元数据（STRATEGY_KEY_META 值类型）：标签 + 悬停含义 + 可选值中文映射 */
export interface StrategyKeyMetaEntry {
  /** 中文名（格子标签） */
  label: string;
  /** 悬停含义（一句话：这个键管什么 + 留空行为） */
  tip: string;
  /** 枚举值中文映射（enum 键用；缺省显示原文） */
  valueLabels?: Record<string, string>;
  /** 多选选项中文映射（multi 键用；缺省显示原文） */
  optionLabels?: Record<string, string>;
  /** 控件形态覆盖（缺省按键面 kind 渲染）：selfReview 是布尔数字语义（0=关/正整数归一 1），用开关而非数字框呈现 */
  control?: 'switch';
}

/**
 * 策略键中文标签映射（键名 → 中文标签 + 悬停含义）。
 *
 * 键集必须与内核 `describeStrategyKeys()` 的键集双向相等（守卫见文件头）。
 * 加键顺序 = 键面出现序，供阅读参考，不作判据。
 */
export const STRATEGY_KEY_META: Record<string, StrategyKeyMetaEntry> = {
  summaryFocus: {
    label: '提炼视角',
    tip: '告诉记忆摘要往哪个方向提炼（如 code、creative），最长 500 字符；留空用通用摘要',
  },
  toolMode: {
    label: '工具模式',
    tip: 'allow = 允许使用工具；block = 纯对话不执行任何工具',
    valueLabels: { allow: '允许工具', block: '禁止工具' },
  },
  temperature: {
    label: '生成温度',
    tip: '越高越有创意、越低越稳定（0.0~2.0）；留空用默认 0.7',
  },
  outputLimit: {
    label: '输出上限',
    tip: '单轮回答的最大 token 数；0 或留空 = 不干预（交给模型/服务商默认）',
  },
  toolStepLimit: {
    label: '工具步数上限',
    tip: '单轮最多执行多少步工具（0 = 不限制）；留空用默认',
  },
  providerRouting: {
    label: '模型路由',
    tip: 'auto = 按任务自动选模型；fixed = 固定当前模型',
    valueLabels: { auto: '自动路由', fixed: '固定模型' },
  },
  multiStepReasoning: {
    label: '多步推理',
    tip: 'auto = 复杂任务自动深入思考；manual = 快速直接回答',
    valueLabels: { auto: '自动推理', manual: '手动推理' },
  },
  toolReadonly: {
    label: '工具权限',
    tip: 'full = 完整读写；readonly = 仅只读操作（更安全）',
    valueLabels: { full: '完整权限', readonly: '只读模式' },
  },
  summary: {
    label: '记忆摘要',
    tip: 'on = 每轮对话后生成记忆摘要；off = 不生成',
    valueLabels: { on: '开启', off: '关闭' },
  },
  selfReview: {
    label: '完成自审',
    tip: '开启后回答完成前先自查一次再交付；关闭 = 不自查',
    control: 'switch',
  },
  userFollowup: {
    label: '追问策略',
    tip: 'ask = 任务说不清时主动反问；silent = 只等用户输入',
    valueLabels: { ask: '主动追问', silent: '静默等待' },
  },
  askOn: {
    label: '主动提问时机',
    tip: '允许角色向你提问的情形，可多选组合；全部不勾 = 不主动提问',
    optionLabels: {
      ambiguity: '任务有歧义时',
      decision: '要做决定时',
      missing_info: '信息不足时',
      confirm: '执行前确认',
    },
  },
  askLimit: {
    label: '提问次数上限',
    tip: '单轮回答最多主动提问几次（1~10）',
  },
  webSearchLimit: {
    label: '联网搜索上限',
    tip: '单轮回答最多联网搜索几次（1~20，超限自动停止搜索）；留空用默认 6',
  },
  errorHandling: {
    label: '出错处理',
    tip: '工具/模型出错时怎么办：retry=重试，degrade=降级继续，stop=终止本轮',
    valueLabels: { retry: '重试', degrade: '降级继续', stop: '终止' },
  },
  contextLimit: {
    label: '上下文上限',
    tip: '角色自设的上下文规模（token），与模型窗口取小值；0 或留空 = 跟随模型窗口',
  },
  stepBudget: {
    label: '步数预算',
    tip: '这轮对话最多跑多少次「思考+用工具」（10~500）；0 或留空 = 用默认 50',
  },
};

/** 详情值渲染：数组（askOn 多选）走选项中文映射，枚举走值中文映射，其余原样字符串化（对象 JSON 兜底） */
export function formatDetailValue(meta: StrategyKeyMetaEntry | undefined, value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => meta?.optionLabels?.[String(v)] ?? String(v)).join(' / ');
  }
  const s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  return meta?.valueLabels?.[s] ?? s;
}
