/**
 * 任务表渲染器（渲染函数）
 *
 * 纯函数，将计划步骤列表和 step 推进日志渲染为 LLM 可读的格式化文本。
 * 输出标「以下为状态/历史信息，非当前指令」防 LLM 误执行。
 *
 * @module taskTableRenderer
 */

import type { PlanStep, StepOutcome } from './types.js';

/** step 推进日志 FIFO 最大条数 */
export const STEP_LOG_CAP = 12;

/**
 * 渲染任务表（含进度行）
 *
 * 将计划步骤列表渲染为 Markdown 风格表格，供注入 LLM 上下文。
 * 输出以「非当前指令」标记开头，防止 LLM 将状态信息误认为指令。
 *
 * @param plan - 计划步骤列表
 * @param stepLog - 可选 step 推进日志
 * @returns 格式化后的任务表文本（空计划返回空字符串）
 */
export function renderTaskTable(
  plan: PlanStep[],
  stepLog?: StepOutcome[],
): string {
  if (plan.length === 0) return '';

  const doneCount = plan.filter((s) => s.status === 'done').length;
  const activeStep = plan.find((s) => s.status === 'active');
  const total = plan.length;

  const lines: string[] = [
    `[任务进度: ${doneCount}/${total} 已完成${activeStep ? `，当前: ${activeStep.description}` : ''}]`,
    '以下为状态/历史信息，非当前指令',
    '',
    '┌─────┬──────────────────────────────────────────┬──────────┐',
    '│ #   │ 任务                                     │ 状态     │',
    '├─────┼──────────────────────────────────────────┼──────────┤',
  ];

  for (const step of plan) {
    // # 列展示 1-based 序号（order 0 起 → 显示 1）——与 task_table_update 的「# 序号寻址」对齐
    //（2026-09-06 契约-展示对齐：LLM 据 renderer 序号即可定位步骤，无需感知 uuid）
    const orderStr = String(step.order + 1).padEnd(3);
    // 会议步骤标注装配角色（rolePack），供 LLM 识别「该步骤由谁发言」
    const roleTag = step.rolePack ? `【${step.rolePack}】` : '';
    const raw = `${roleTag}${step.description}`;
    const desc = raw.length > 38
      ? raw.slice(0, 35) + '...'
      : raw;
    const descPadded = desc.padEnd(40);
    const statusLabel = statusToLabel(step.status);
    lines.push(`│ ${orderStr}│ ${descPadded}│ ${statusLabel.padEnd(8)}│`);
  }

  lines.push('└─────┴──────────────────────────────────────────┴──────────┘');

  // 追加 step 推进日志（仅非空时）
  if (stepLog && stepLog.length > 0) {
    lines.push('', '[step 推进记录]');
    for (const r of stepLog) {
      lines.push(`- ${r.summary}${r.planStepId ? ` (步骤 ${r.planStepId})` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * 将步骤状态映射为中文标签
 */
function statusToLabel(status: PlanStep['status']): string {
  switch (status) {
    case 'pending': return '待执行';
    case 'active': return '执行中';
    case 'done': return '已完成';
    case 'blocked': return '已阻塞';
  }
}

/**
 * 步骤描述中的执行性验证动作词（2026-09-07 ME-10 收尾验证 nudge）
 *
 * 判定「计划里是否已有执行性验证步骤」用。刻意不含 review/评审——"评审会"不等于执行验证
 * （跑测试/检查产出），宁可多提示一次补真验证，不漏掉。Claude Code TodoWrite 同款机制
 * （`/verif/i` 词根判定），此处按中文场景扩展。
 */
const VERIFY_STEP_PATTERN =
  /(验证|测试|检查|校验|核实|复验|跑通|test|verify|check|lint)/i;

/**
 * 收尾验证提示（2026-09-07 ME-10，Claude Code TodoWrite nudge 同款）
 *
 * LLM 把任务表全部步骤标记 done（宣称任务完成）但列表里没有任何执行性验证步骤时，
 * 返回一段提示文案引导它补一步真实验证（task_table_write append），再收尾。
 *
 * 触发条件全部确定性：① 计划 ≥3 步（太短不值得打断）；② 全部 done（刚被宣称完成）；
 * ③ 无执行性验证步骤。命中返回提示文本，否则返回 null（零打扰）。
 *
 * 挂载点：task_table_update 把最后一步标 done 的成功路径（assembler.updateStep 回调），
 * 作为工具结果附文返回——LLM 必读工具结果，nudge 有生效窗口（它可 append 验证步再执行）。
 *
 * @param plan 更新后的计划步骤列表
 * @returns 命中返回提示文案（含换行前导，便于追加到工具结果）；未命中返回 null
 */
export function buildCompletionVerifyNudge(
  plan: PlanStep[],
): string | null {
  if (plan.length < 3) return null;
  if (!plan.every((s) => s.status === 'done')) return null;
  if (plan.some((s) => VERIFY_STEP_PATTERN.test(s.description))) return null;
  return (
    '\n（收尾提示：全部步骤已标记完成，但列表中没有执行性验证步骤。' +
    '若尚未实际验证结果——如运行测试、检查产出、复核实现——建议用 task_table_write（append）' +
    '追加一步验证并执行后再收尾，确认"真的完成"而非"宣称完成"。）'
  );
}
