/**
 * taskTableRenderer.test.ts — 任务表渲染器测试
 *
 * 覆盖范围：
 *   1. renderTaskTable — 空计划、单步骤、多步骤、状态渲染
 *   2. step 推进日志渲染 — 有/无推进日志、推进日志截断
 *   3. 边界场景 — 长描述截断、特殊字符、最大条数限制
 *
 * 注：纯函数测试，无副作用。
 */
import { describe, it, expect } from 'vitest';
import { renderTaskTable, STEP_DESC_MAX_CHARS, buildCompletionVerifyNudge } from '../taskTableRenderer.js';
import type { PlanStep, StepOutcome } from '../types.js';

/** 创建测试用 PlanStep */
function createStep(
  order: number,
  description: string,
  status: PlanStep['status'] = 'pending',
  id?: string,
): PlanStep {
  return { id: id ?? `step-${order}`, order, description, status };
}

/** 创建测试用 StepOutcome */
function createStepLog(summary: string, planStepId?: string): StepOutcome {
  return { summary, planStepId, completedAt: Date.now() };
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

  it('会议步骤（rolePack）标注装配角色（v0.13 S5）', () => {
    const plan: PlanStep[] = [
      { id: 's1', order: 0, description: '从编辑视角审稿', status: 'active', rolePack: '编辑' },
      { id: 's2', order: 1, description: '从评论家视角点评', status: 'pending', rolePack: '评论家' },
      { id: 's3', order: 2, description: '汇总会议结论', status: 'pending' },
    ];
    const result = renderTaskTable(plan);

    // 声明 rolePack 的步骤带【角色】标注，供 LLM 识别「该步骤由谁发言」
    expect(result).toContain('【编辑】从编辑视角审稿');
    expect(result).toContain('【评论家】从评论家视角点评');
    // 未声明 rolePack 的步骤（汇总）无标注
    expect(result).toContain('汇总会议结论');
    expect(result).not.toContain('【】');
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
// 3. step 推进日志渲染
// ══════════════════════════════════════════════════════════════

describe('taskTableRenderer — step 推进日志渲染', () => {

  it('有 step 推进日志时追加 step 推进记录', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const stepLog: StepOutcome[] = [
      createStepLog('完成了需求分析', 'step-0'),
      createStepLog('发现一个 bug', 'step-1'),
    ];
    const result = renderTaskTable(plan, stepLog);

    expect(result).toContain('[step 推进记录]');
    expect(result).toContain('完成了需求分析 (步骤 step-0)');
    expect(result).toContain('发现一个 bug (步骤 step-1)');
  });

  it('step 推进日志无 planStepId 时不显示步骤编号', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const stepLog: StepOutcome[] = [
      createStepLog('自由对话迭代'),
    ];
    const result = renderTaskTable(plan, stepLog);

    expect(result).toContain('自由对话迭代');
    // 不应包含 (步骤 ...)
    expect(result).not.toContain('(步骤');
  });

  it('step 推进日志为空数组时不追加推进记录', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const result = renderTaskTable(plan, []);

    expect(result).not.toContain('[step 推进记录]');
  });

  it('step 推进日志全部渲染（本函数不做截断；真源为 SessionManager.appendStepLog 每 step 3 条）', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const stepLog: StepOutcome[] = [];
    for (let i = 0; i < 5; i++) {
      stepLog.push(createStepLog(`step ${i}`));
    }
    const result = renderTaskTable(plan, stepLog);

    // 验证所有 step 推进记录都被渲染
    for (let i = 0; i < 5; i++) {
      expect(result).toContain(`step ${i}`);
    }
  });

  it('不传 step 推进日志时不追加推进记录', () => {
    const plan = [createStep(0, '步骤一', 'active')];
    const result = renderTaskTable(plan);

    expect(result).not.toContain('[step 推进记录]');
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

  it('顺序号正确格式化（1-based，2026-09-06 与 task_table_update 序号寻址对齐）', () => {
    const plan = [
      createStep(0, '第一', 'pending'),
      createStep(10, '第十一', 'pending'),
      createStep(100, '第一百零一', 'pending'),
    ];
    const result = renderTaskTable(plan);

    // 行首序号为 order+1：LLM 据序号即可定位步骤（task_table_update step_id="1" = 第一个步骤）
    // 断言「行首序号」这一业务不变量，不锁定空格填充等排版细节（padEnd 宽度是排版细节，非契约）
    const seqs = result
      .split('\n')
      .filter((l) => /^\d+\./.test(l))
      .map((l) => l.match(/^(\d+)\./)![1]);
    expect(seqs).toEqual(['1', '11', '101']);
    // 不再出现 0-based 序号（行首无 0. 起头）
    expect(seqs).not.toContain('0');
  });

  it('任务表行首序号与 task_table_update 寻址对齐（1-based 可见即传）', () => {
    const plan: PlanStep[] = [
      createStep(0, '文档设计师发言', 'done', 's1'),
      createStep(1, '小说助手发言', 'active', 's2'),
      createStep(2, '方案设计师汇总', 'pending', 's3'),
    ];
    const result = renderTaskTable(plan);
    // 行首序号为 1/2/3，与「step_id 传行首序号」契约一致（LLM 无需感知 uuid s1/s2/s3）
    const lines = result.split('\n');
    const stepLine1 = lines.find((l) => l.includes('文档设计师发言'))!;
    const stepLine3 = lines.find((l) => l.includes('方案设计师汇总'))!;
    expect(stepLine1.startsWith('1. ')).toBe(true);
    expect(stepLine3.startsWith('3. ')).toBe(true);
  });

  it('STEP_DESC_MAX_CHARS 常量存在且合理（截断阈值，防超长描述撑爆上下文）', () => {
    expect(STEP_DESC_MAX_CHARS).toBe(38);
    expect(STEP_DESC_MAX_CHARS).toBeGreaterThan(0);
  });

  it('输出以「非当前指令」标记开头区域', () => {
    const plan = [createStep(0, '测试', 'pending')];
    const result = renderTaskTable(plan);

    // 验证防误执行标记存在
    expect(result).toContain('以下为状态/历史信息，非当前指令');
  });
});

// ══════════════════════════════════════════════════════════════
// 5. 排版契约（2026-09-15 去方框收敛后的守卫）
// ══════════════════════════════════════════════════════════════
describe('taskTableRenderer — 排版契约', () => {

  it('首行恒为 [任务进度: 前缀（loop 替换式注入的识别契约）', () => {
    // 契约来源：loop.ts 按 startsWith('[任务进度:') 移除上一份任务表；
    // 前缀一旦变更/被前导内容挤掉 → 一个 turn 内每迭代各堆一份任务表
    const plan = [createStep(0, '步骤一', 'active')];
    expect(renderTaskTable(plan).startsWith('[任务进度:')).toBe(true);
  });

  it('输出无 ASCII 方框装饰字符（去方框收敛，防回退）', () => {
    const plan: PlanStep[] = [
      { id: 's1', order: 0, description: '组长开场', status: 'active' },
      { id: 's2', order: 1, description: '组员发言', status: 'pending', rolePack: '组员A' },
    ];
    // 装饰字符对 LLM 零语义价值，却占约 46.5% tokens（4 步表实测 230 → 123）
    expect(renderTaskTable(plan)).not.toMatch(/[┌┬┐├┼┤└┴┘│─]/);
  });

  it('步骤行结构 = 「序号. 【角色】描述 [状态]」', () => {
    const plan: PlanStep[] = [
      { id: 's1', order: 0, description: '组长开场', status: 'active' },
      { id: 's2', order: 1, description: '组员发言', status: 'pending', rolePack: '组员A' },
    ];
    const lines = renderTaskTable(plan).split('\n');
    // 行首序号 1-based；状态标签以方括号收尾；rolePack 以【】标注
    expect(lines).toContain('1. 组长开场 [执行中]');
    expect(lines).toContain('2. 【组员A】组员发言 [待执行]');
  });

  it('四态标签齐备且可区分（[已完成]/[执行中]/[待执行]/[已阻塞]）', () => {
    const mixed: PlanStep[] = [
      createStep(0, 'A', 'done'),
      createStep(1, 'B', 'active'),
      createStep(2, 'C', 'pending'),
      createStep(3, 'D', 'blocked'),
    ];
    const result = renderTaskTable(mixed);
    for (const label of ['已完成', '执行中', '待执行', '已阻塞']) {
      expect(result).toContain(`[${label}]`);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 收尾验证 nudge（ME-10，2026-09-07）
// ══════════════════════════════════════════════════════════════
describe('buildCompletionVerifyNudge — 收尾验证提示', () => {
  it('全 done 且 ≥3 步、无验证步骤 → 命中返回提示', () => {
    const plan = [
      createStep(0, '实现 A', 'done'),
      createStep(1, '实现 B', 'done'),
      createStep(2, '接入 C', 'done'),
    ];
    const nudge = buildCompletionVerifyNudge(plan);
    expect(nudge).not.toBeNull();
    expect(nudge).toContain('收尾提示');
    expect(nudge).toContain('task_table_write');
  });

  it('步骤不足 3 个 → 不打扰（返回 null）', () => {
    const plan = [createStep(0, '干一件小事', 'done'), createStep(1, '再来一件', 'done')];
    expect(buildCompletionVerifyNudge(plan)).toBeNull();
  });

  it('未全部 done → 不触发（还在推进中）', () => {
    const plan = [
      createStep(0, '实现 A', 'done'),
      createStep(1, '实现 B', 'done'),
      createStep(2, '接入 C', 'pending'),
    ];
    expect(buildCompletionVerifyNudge(plan)).toBeNull();
  });

  it('已有执行性验证步骤（中文"验证"）→ 不再提示', () => {
    const plan = [
      createStep(0, '实现 A', 'done'),
      createStep(1, '实现 B', 'done'),
      createStep(2, '验证整体流程', 'done'),
    ];
    expect(buildCompletionVerifyNudge(plan)).toBeNull();
  });

  it('已有执行性验证步骤（英文 test / check / lint）→ 不再提示', () => {
    const plan = [
      createStep(0, '实现 A', 'done'),
      createStep(1, '实现 B', 'done'),
      createStep(2, 'run tests', 'done'),
    ];
    expect(buildCompletionVerifyNudge(plan)).toBeNull();
  });

  it('含 blocked 步骤不算全 done → 不触发', () => {
    const plan = [
      createStep(0, '实现 A', 'done'),
      createStep(1, '方案 B', 'blocked'),
      createStep(2, '接入 C', 'done'),
    ];
    expect(buildCompletionVerifyNudge(plan)).toBeNull();
  });
});
