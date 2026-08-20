/**
 * 任务表渲染器（渲染函数）
 *
 * 纯函数，将计划步骤列表和回合日志渲染为 LLM 可读的格式化文本。
 * 输出标「以下为状态/历史信息，非当前指令」防 LLM 误执行。
 *
 * @module taskTableRenderer
 */

import type { PlanStep, RoundOutcome } from './types.js';

/** 回合日志 FIFO 最大条数 */
export const ROUND_LOG_CAP = 12;

/**
 * 渲染任务表（含进度行）
 *
 * 将计划步骤列表渲染为 Markdown 风格表格，供注入 LLM 上下文。
 * 输出以「非当前指令」标记开头，防止 LLM 将状态信息误认为指令。
 *
 * @param plan - 计划步骤列表
 * @param roundLog - 可选回合日志
 * @returns 格式化后的任务表文本（空计划返回空字符串）
 */
export function renderTaskTable(
  plan: PlanStep[],
  roundLog?: RoundOutcome[],
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
    const orderStr = String(step.order).padEnd(3);
    const desc = step.description.length > 38
      ? step.description.slice(0, 35) + '...'
      : step.description;
    const descPadded = desc.padEnd(40);
    const statusLabel = statusToLabel(step.status);
    lines.push(`│ ${orderStr}│ ${descPadded}│ ${statusLabel.padEnd(8)}│`);
  }

  lines.push('└─────┴──────────────────────────────────────────┴──────────┘');

  // 追加回合日志（仅非空时）
  if (roundLog && roundLog.length > 0) {
    lines.push('', '[回合记录]');
    for (const r of roundLog) {
      lines.push(`- ${r.summary}${r.stepId ? ` (步骤 ${r.stepId})` : ''}`);
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