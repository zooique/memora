/**
 * 任务表是否需要启动的确定性判定（触发确定性化）。
 *
 * 背景：任务表触发不能凭 LLM 自觉——软提示「多步推进时使用任务表」实测不生效，
 * 故「多步任务」采用确定性判定（代码判）而非语义匹配（靠模型猜），为真时在首迭代
 * 注入命令式强引导（配合 loop 的 needsPlanning nudge）。
 *
 * 判定口径（保守方向，对齐 Codex「简单任务不灌 padding」）：宁漏判不打扰——
 * 只有强信号（显式多步结构 / 强工程创建重构命令）才触发，简单问答一律 false。
 *
 * SSOT：本文件的 detectNeedsPlanning 是判定唯一真源；loop 默认调用它，host 可经
 * AgentLoopOptions.needsPlanningOverride 覆盖。
 */

/** 强工程创建/重构命令词表（命中即判定为需要规划，独立于结构信号） */
const STRONG_COMMAND_KEYWORDS = [
  '重构',
  '迁移',
  '搭建',
  '从零',
  '完整实现',
  '升级改造',
  '多步',
  '拆解',
  '子任务',
  '分步骤',
  '逐步',
  '步骤规划',
  '连续修复',
  '批量',
  // 改动类动词（覆盖「基于结论，执行更新/修改」这类承接自规划轮的明确改动指令）：
  // 注意：放宽是刻意取舍——「更新/修改/修复」会让带这些词的简单问答多注入一次任务表引导，
  // 但那是软提示、LLM 可忽略误触发的表；换来的是让承接性改动任务正确进入规划闭环。
  '更新',
  '修改',
  '修复',
];

/** 多步结构信号：出现「然后/再/步骤/首先/其次」等承接词，或 ≥2 个顿号/功能分隔的并列动作 */
const MULTI_STEP_PATTERNS = [
  /(先|首先|第一步).{0,12}(再|然后|接着|随后)/,
  /(然后|接着|随后|其次).{0,12}(再|并且|还)/,
  /(步骤|拆成|分为|需要).{0,12}(步|阶段|部分)/,
  /、.{0,8}、/, // 连续顿号 = 并列多动作（如「刷新界面、修接口、补测试」）
];

/**
 * 判断一次用户输入是否需要启动任务表规划。
 *
 * @param text 用户输入（turn 起始的原始指令）
 * @returns true = 需规划（loop 首迭代注入命令式强引导）；false = 直接执行/直接回答
 */
export function detectNeedsPlanning(text: string): boolean {
  if (!text) return false;
  // 1) 强命令词表：命中即判规划（工程创建/重构类任务几乎必然多步）
  if (STRONG_COMMAND_KEYWORDS.some((kw) => text.includes(kw))) return true;
  // 2) 多步结构信号：承接词或并列动作 → 判规划
  return MULTI_STEP_PATTERNS.some((re) => re.test(text));
}

/**
 * 命令式强引导文案（needsPlanning 为真时由 loop 在首迭代一次性注入 executionTemp）。
 *
 * 与 TURN_START_STRATEGY_PROMPT（assembler 软提示）区分：本文案只在确定性判定命中后才注入，
 * 语气是命令式而非建议式（对齐 Claude Code「必须维护任务表」引导强度）；且仅首迭代一次、不污染后续轮。
 */
export const PLAN_NUDGE_PROMPT = `## 任务表强制提示（本任务需多步推进）
这是一个多步任务：必须先用 task_table_write 将任务拆解为子步骤写入任务表，再按任务表逐步推进并逐项标记状态，禁止跳过拆解一次性盲目执行。
（任务表的具体操作与状态标记方法见 task_table_write / task_table_update 的工具描述。）`;