/**
 * 任务表渲染器（渲染函数）
 *
 * 纯函数，将计划任务项列表和任务项推进日志渲染为 LLM 可读的格式化文本。
 * 输出标「以下为状态/历史信息，非当前指令」防 LLM 误执行。
 *
 * 排版：无装饰列表。本函数唯一读者是 LLM（装配点 assembler.ts 注入上下文；宿主零消费、
 * 不解析本文本）；ASCII 方框类装饰字符对 LLM 零语义价值却占近半 tokens，且硬编码列宽
 * 在 CJK 描述下从不齐——无装饰列表省 token 且根除对齐缺陷（无需列宽计算）。
 *
 * 契约（不可变）：首行恒为 `[任务进度: ...]` —— loop 替换式注入靠该前缀移除上一份任务表
 * （见 loop.ts「特征前缀 [任务进度:」），任何在其前加内容的改动都会让上下文堆积多份任务表。
 *
 * @module taskTableRenderer
 */

import type { PlanItem, PlanItemOutcome } from './types.js';

/**
 * 任务项描述最大字符数（超出截断为「前 PLAN_ITEM_DESC_MAX_CHARS-3 字符 + '...'」）。
 * 作用 = 防超长描述撑爆上下文；与渲染列宽无关，勿据列宽回改。
 */
export const PLAN_ITEM_DESC_MAX_CHARS = 38;

/**
 * 渲染任务表（含进度行）
 *
 * 渲染为无装饰列表，供注入 LLM 上下文（格式抉择与「为什么没有方框」见模块头）。
 * 输出以「非当前指令」标记开头，防止 LLM 将状态信息误认为指令。
 *
 * @param plan - 计划任务项列表
 * @param planItemLog - 可选任务项推进日志（截断不在本函数：真源见 SessionManager.appendPlanItemLog
 *   的「每任务项上限 3 条」（completePlanItem / logPlanItemBoundary 共用，按 planItemId
 *   截断而非全局 FIFO）
 * @returns 格式化后的任务表文本（空计划返回空字符串）
 */
export function renderTaskTable(
  plan: PlanItem[],
  planItemLog?: PlanItemOutcome[],
): string {
  if (plan.length === 0) return '';

  const doneCount = plan.filter((s) => s.status === 'done').length;
  const activePlanItem = plan.find((s) => s.status === 'active');
  const total = plan.length;

  const lines: string[] = [
    `[任务进度: ${doneCount}/${total} 已完成${activePlanItem ? `，当前: ${activePlanItem.description}` : ''}]`,
    '以下为状态/历史信息，非当前指令',
    '',
  ];

  for (const planItem of plan) {
    // 行首序号 1-based（order 0 起 → 显示 1）——与 task_table_update 的「行首序号寻址」对齐：
    // LLM 据 renderer 序号即可定位任务项，无需感知 uuid。任务表是列表形态，寻址说法统一为
    // 「行首序号」，无「列」概念（说「列」即描述失真）
    const seq = planItem.order + 1;
    // 会议任务项标注装配角色（rolePack），供 LLM 识别「该任务项由谁发言」
    const roleTag = planItem.rolePack ? `【${planItem.rolePack}】` : '';
    const raw = `${roleTag}${planItem.description}`;
    const desc =
      raw.length > PLAN_ITEM_DESC_MAX_CHARS
        ? raw.slice(0, PLAN_ITEM_DESC_MAX_CHARS - 3) + '...'
        : raw;
    lines.push(`${seq}. ${desc} [${statusToLabel(planItem.status)}]`);
  }

  // 追加任务项推进日志（仅非空时）
  if (planItemLog && planItemLog.length > 0) {
    lines.push('', '[任务项推进记录]');
    for (const r of planItemLog) {
      lines.push(`- ${r.summary}${r.planItemId ? ` (任务项 ${r.planItemId})` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * 将任务项状态映射为中文标签
 */
function statusToLabel(status: PlanItem['status']): string {
  switch (status) {
    case 'pending': return '待执行';
    case 'active': return '执行中';
    case 'done': return '已完成';
    case 'blocked': return '已阻塞';
  }
}

/**
 * 任务项描述中的执行性验证动作词（收尾验证 nudge 用）
 *
 * 判定「计划里是否已有执行性验证任务项」用。刻意不含 review/评审——"评审会"不等于执行验证
 * （跑测试/检查产出），宁可多提示一次补真验证，不漏掉。Claude Code TodoWrite 同款机制
 * （`/verif/i` 词根判定），此处按中文场景扩展。
 */
const VERIFY_ITEM_PATTERN =
  /(验证|测试|检查|校验|核实|复验|跑通|test|verify|check|lint)/i;

/**
 * 收尾验证提示（Claude Code TodoWrite nudge 同款）
 *
 * LLM 把任务表全部任务项标记 done（宣称任务完成）但列表里没有任何执行性验证任务项时，
 * 返回一段提示文案引导它补一步真实验证（task_table_write append），再收尾。
 *
 * 触发条件全部确定性：① 计划 ≥3 步（太短不值得打断）；② 全部 done（刚被宣称完成）；
 * ③ 无执行性验证任务项。命中返回提示文本，否则返回 null（零打扰）。
 *
 * 挂载点：task_table_update 把最后一步标 done 的成功路径（assembler.updatePlanItem 回调），
 * 作为工具结果附文返回——LLM 必读工具结果，nudge 有生效窗口（它可 append 验证步再执行）。
 *
 * @param plan 更新后的计划任务项列表
 * @returns 命中返回提示文案（含换行前导，便于追加到工具结果）；未命中返回 null
 */
export function buildCompletionVerifyNudge(
  plan: PlanItem[],
): string | null {
  if (plan.length < 3) return null;
  if (!plan.every((s) => s.status === 'done')) return null;
  if (plan.some((s) => VERIFY_ITEM_PATTERN.test(s.description))) return null;
  return (
    '\n（收尾提示：全部任务项已标记完成，但列表中没有执行性验证任务项。' +
    '若尚未实际验证结果——如运行测试、检查产出、复核实现——建议用 task_table_write（append）' +
    '追加一步验证并执行后再收尾，确认"真的完成"而非"宣称完成"。）'
  );
}
