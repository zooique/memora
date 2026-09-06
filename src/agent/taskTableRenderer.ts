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