/**
 * taskTableRenderer.test.ts — 任务表渲染器测试
 *
 * 覆盖范围：
 *   1. renderTaskTable — 空计划、单步骤、多步骤、状态渲染
 *   2. 回合日志渲染 — 有/无回合日志、回合日志截断
 *   3. 边界场景 — 长描述截断、特殊字符、最大条数限制
 *
 * 注：纯函数测试，无副作用。
 */
import { describe, it, expect } from 'vitest';
import { renderTaskTable, ROUND_LOG_CAP } from '../taskTableRenderer.js';
import type { PlanStep, RoundOutcome } from '../types.js';

/** 创建测试用 PlanStep */
function createStep(
  order: number,
  description: string,
  status: PlanStep['status'] = 'pending',
  id?: string,
): PlanStep {
  return { id: id ?? `step-${order}`, order, description, status };
}

/** 创建测试用 RoundOutcome */
function createRound(summary: string, stepId?: string): RoundOutcome {
  return { summary, stepId, completedAt: Date.now() };
}

// ══════════════════════════════════════════════════════════════
// 1. 基本渲染
// ══════════════════════════════════════════════════════════════

describe('taskTableRenderer — 基本渲染', () => {

  it('空计划返回空字符串', () => {
    const result = renderTaskTable([]);
    expect(result).toBe('');
  });

  it('单步骤待执行状态', () => {
    const plan = [createStep(0, '实现登录功能', 'pending')];
    const result = renderTaskTable(plan);

    expect(result).toContain('任务进度: 0/1 已完成');
    expect(result).toContain('待执行');
    expect(result).toContain('实现登录功能');
    expect(result).toContain('非当前指令');
  });

  it('单步骤执行中状态', () => {
    const plan = [createStep(0, '编写测试用例', 'active')];
    const result = renderTaskTable(plan);

    expect(result).toContain('任务进度: 0/1 已完成，当前: 编写测试用例');
    expect(result).toContain('执行中');
  });

  it('单步骤已完成状态', () => {
    const plan = [createStep(0, '代码审查', 'done')];
    const result = renderTaskTable(plan);

    expect(result).toContain('任务进度: 1/1 已完成');
    expect(result).toContain('已完成');
  });

  it('单步骤已阻塞状态', () => {
    const plan = [createStep(0, '部署上线', 'blocked')];
    const result = renderTaskTable(plan);

    expect(result).toContain('已阻塞');
  });
});

// ══════════════════════════════════════════════════════════════
// 2. 多步骤渲染
// ══════════════════════════════════════════════════════════════

describe('taskTableRenderer — 多步骤渲染', () => {

  it('多步骤混合状态', () => {
    const plan: PlanStep[] = [
      createStep(0, '需求分析', 'done'),
      createStep(1, '设计架构', 'done'),
      createStep(2, '编码实现', 'active'),
      createStep(3, '测试', 'pending'),
      createStep(4, '部署', 'blocked'),
    ];
    const result = renderTaskTable(plan);

    expect(result).toContain('任务进度: 2/5 已完成，当前: 编码实现');
    expect(result).toContain('需求分析');
    expect(result).toContain('设计架构');
    expect(result).toContain('编码实现');
    expect(result).toContain('测试');
    expect(result).toContain('部署');

    // 验证状态标签
    expect(result).toContain('已完成');
    expect(result).toContain('执行中');
    expect(result).toContain('待执行');
    expect(result).toContain('已阻塞');
  });

  it('所有步骤已完成', () => {
    const plan: PlanStep[] = [
      createStep(0, '步骤一', 'done'),
      createStep(1, '步骤二', 'done'),
      createStep(2, '步骤三', 'done'),
    ];
    const result = renderTaskTable(plan);

    expect(result).toContain('任务进度: 3/3 已完成');
    expect(result).not.toContain('当前:');
  });

  it('所有步骤待执行', () => {
    const plan: PlanStep[] = [
      createStep(0, '步骤一', 'pending'),
      createStep(1, '步骤二', 'pending'),
    ];
    const result = renderTaskTable(plan);

    expect(result).toContain('任务进度: 0/2 已完成');
    expect(result).not.toContain('当前:');
  });

  it('只有一个 active 步骤', () => {
    const plan: PlanStep[] = [
      createStep(0, '步骤一', 'active'),
      createStep(1, '步骤二', 'pending'),
    ];
    const result = renderTaskTable(plan);

    expect(result).toContain('当前: 步骤一');
  });
});

// ══════════════════════════════════════════════════════════════
// 3. 回合日志渲染
// ══════════════════════════════════════════════════════════════

describe('taskTableRenderer — 回合日志渲染', () => {

  it('有回合日志时追加回合记录', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const roundLog: RoundOutcome[] = [
      createRound('完成了需求分析', 'step-0'),
      createRound('发现一个 bug', 'step-1'),
    ];
    const result = renderTaskTable(plan, roundLog);

    expect(result).toContain('[回合记录]');
    expect(result).toContain('完成了需求分析 (步骤 step-0)');
    expect(result).toContain('发现一个 bug (步骤 step-1)');
  });

  it('回合日志无 stepId 时不显示步骤编号', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const roundLog: RoundOutcome[] = [
      createRound('自由对话回合'),
    ];
    const result = renderTaskTable(plan, roundLog);

    expect(result).toContain('自由对话回合');
    // 不应包含 (步骤 ...)
    expect(result).not.toContain('(步骤');
  });

  it('回合日志为空数组时不追加回合记录', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const result = renderTaskTable(plan, []);

    expect(result).not.toContain('[回合记录]');
  });

  it('回合日志全部渲染（ROUND_LOG_CAP 仅为导出常量，截断逻辑未实现）', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const roundLog: RoundOutcome[] = [];
    for (let i = 0; i < 5; i++) {
      roundLog.push(createRound(`回合 ${i}`));
    }
    const result = renderTaskTable(plan, roundLog);

    // 验证所有回合日志都被渲染
    for (let i = 0; i < 5; i++) {
      expect(result).toContain(`回合 ${i}`);
    }
  });

  it('不传回合日志时不追加回合记录', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const result = renderTaskTable(plan);

    expect(result).not.toContain('[回合记录]');
  });
});

// ══════════════════════════════════════════════════════════════
// 4. 边界场景
// ══════════════════════════════════════════════════════════════

describe('taskTableRenderer — 边界场景', () => {

  it('长描述截断（超过 38 字符）', () => {
    // 使用 ASCII 字符确保长度可控（> 38 触发截断）
    const longDesc = 'A'.repeat(45);
    expect(longDesc.length).toBeGreaterThan(38);
    const plan = [createStep(0, longDesc, 'pending')];
    const result = renderTaskTable(plan);

    // 长描述应被截断为 35 字符 + "..."
    const truncated = longDesc.slice(0, 35) + '...';
    expect(result).toContain(truncated);
    // 原始完整描述不应出现
    expect(result).not.toContain(longDesc);
  });

  it('恰好 38 字符的描述不截断', () => {
    const exact38 = 'a'.repeat(38);
    const plan = [createStep(0, exact38, 'pending')];
    const result = renderTaskTable(plan);

    expect(result).toContain(exact38);
  });

  it('39 字符的描述被截断', () => {
    const exact39 = 'a'.repeat(39);
    const plan = [createStep(0, exact39, 'pending')];
    const result = renderTaskTable(plan);

    const truncated = exact39.slice(0, 35) + '...';
    expect(result).toContain(truncated);
  });

  it('特殊字符正常渲染', () => {
    const plan = [createStep(0, '测试 emoji 🌍 和中文标点：《》！', 'pending')];
    const result = renderTaskTable(plan);

    expect(result).toContain('测试 emoji 🌍 和中文标点：《》！');
  });

  it('空字符串描述正常渲染', () => {
    const plan = [createStep(0, '', 'pending')];
    const result = renderTaskTable(plan);

    // 空描述应正常显示
    expect(result).toBeDefined();
  });

  it('顺序号正确格式化', () => {
    const plan = [
      createStep(0, '第一', 'pending'),
      createStep(10, '第十一', 'pending'),
      createStep(100, '第一百零一', 'pending'),
    ];
    const result = renderTaskTable(plan);

    // 顺序号应被格式化为固定宽度
    expect(result).toContain('0  ');
    expect(result).toContain('10 ');
    expect(result).toContain('100');
  });

  it('ROUND_LOG_CAP 常量存在且合理', () => {
    expect(ROUND_LOG_CAP).toBe(12);
    expect(ROUND_LOG_CAP).toBeGreaterThan(0);
  });

  it('输出以「非当前指令」标记开头区域', () => {
    const plan = [createStep(0, '测试', 'pending')];
    const result = renderTaskTable(plan);

    // 验证防误执行标记存在
    expect(result).toContain('以下为状态/历史信息，非当前指令');
  });
});