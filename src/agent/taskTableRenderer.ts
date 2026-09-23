/**
 * 任务表渲染器（渲染函数）
 *
 * 纯函数，将计划任务项列表和任务项推进日志渲染为 LLM 可读的格式化文本。
 * 输出标「以下为状态/历史信息，非当前指令」防 LLM 误执行。
 *
 * 排版（2026-09-15 去方框收敛）：本函数唯一读者是 LLM（装配点 assembler.ts 注入上下文；
 * 宿主零消费、不解析本文本）。早前用 ASCII 方框（┌─┬┐）排版，装饰字符对 LLM 零语义价值，
 * 却占约 46.5% tokens（4 步表实测 230 → 123），且边框/表头/数据行三处各自硬编码宽度
 * → 列从未对齐（实测三种宽度并存：5/42/10 与 5/40/8 与 4/41/9），CJK 描述更额外溢出。
 * 故改为无装饰列表：省 token 且**根除**对齐类缺陷（不再需要列宽计算）。
 *
 * 契约（不可变）：首行恒为 `[任务进度: ...]` —— loop 替换式注入靠该前缀移除上一份任务表
 * （见 loop.ts「特征前缀 [任务进度:」），任何在其前加内容的改动都会让上下文堆积多份任务表。
 *
 * @module taskTableRenderer
 */

import type { PlanItem, PlanItemOutcome } from './types.js';

/**
 * 任务项描述最大字符数（超出截断为「前 PLAN_ITEM_DESC_MAX_CHARS-3 字符 + '...'」）。
 * 作用 = 防超长描述撑爆上下文（原为方框列宽服务，列宽消失后该理由仍成立）。
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
 *   的「每任务项上限 3 条」（completePlanItem / logPlanItemBoundary 共用）——P-1 2026-09-06 起取代旧全局 FIFO 上限）
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

  for (const step of plan) {
    // 行首序号 1-based（order 0 起 → 显示 1）——与 task_table_update 的「行首序号寻址」对齐
    //（2026-09-06 契约-展示对齐：LLM 据 renderer 序号即可定位任务项，无需感知 uuid）
    // 去方框后任务表是**列表**不是表格，工具描述里的寻址说法须同步为「行首序号」
    // （旧版方框有「#」列，说「# 列」成立；列表版无列概念，再说「列」即描述失真）
    const seq = step.order + 1;
    // 会议任务项标注装配角色（rolePack），供 LLM 识别「该任务项由谁发言」
    const roleTag = step.rolePack ? `【${step.rolePack}】` : '';
    const raw = `${roleTag}${step.description}`;
    const desc =
      raw.length > PLAN_ITEM_DESC_MAX_CHARS
        ? raw.slice(0, PLAN_ITEM_DESC_MAX_CHARS - 3) + '...'
        : raw;
    lines.push(`${seq}. ${desc} [${statusToLabel(step.status)}]`);
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
 * 任务项描述中的执行性验证动作词（2026-09-07 ME-10 收尾验证 nudge）
 *
 * 判定「计划里是否已有执行性验证任务项」用。刻意不含 review/评审——"评审会"不等于执行验证
 * （跑测试/检查产出），宁可多提示一次补真验证，不漏掉。Claude Code TodoWrite 同款机制
 * （`/verif/i` 词根判定），此处按中文场景扩展。
 */
const VERIFY_ITEM_PATTERN =
  /(验证|测试|检查|校验|核实|复验|跑通|test|verify|check|lint)/i;

/**
 * 收尾验证提示（2026-09-07 ME-10，Claude Code TodoWrite nudge 同款）
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
