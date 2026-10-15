/**
 * 折叠边界命名守卫（loop.ts 契约显化 · 从注释断言搬进机器）
 *
 * 契约真源 = `_maybeEmitPlanItemBoundary` 头注释（ADR-034 定案锚）：
 * 「产出的是 plan_item_boundary，**不是** step_boundary——方法名与产出事件名必须同阵营，
 * 勿据「step」误读为迭代边界」。
 *
 * 为什么值得机器锁：两个边界事件语义不同（任务项推进 vs 迭代原子落盘），宿主消费面
 * 按 type 分流；若产出点互串（方法名说 A、体内产 B），注释喊话拦不住——读者信了，
 * 测试不会红（措辞折叠纪律：跨阵营错位无行为测试必然捕获）。
 *
 * 判据（只锁静态可判定的事实，扫描面 = loop.ts 剥注释代码）：
 * 1. `type: 'plan_item_boundary'` 恰 1 处，且落在 _maybeEmitPlanItemBoundary 方法体内；
 * 2. `type: 'step_boundary'` 恰 1 处，且落在 _emitStepBoundary 方法体内。
 *
 * 判据边界（诚实声明）：types.ts 的类型联合、roundStore.ts 的重放映射不在扫描面
 * （它们是消费/重放面，非产出点）；本守卫只锁 loop.ts 产出点的方法名 ↔ 事件名对账，
 * 不锁事件时序（迭代开始 vs 迭代尾）——时序由 loop.test.ts 行为用例覆盖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 被扫文件：本测试在 `src/agent/__tests__/`，loop.ts 在上两级 */
const LOOP_TS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent', 'loop.ts');

/** 行级剥注释：trim 后以行注释符、块注释起符、星号、块注释止符开头的行剔除
 *  （⚠️ 本注释不得写出那四个记号的字面量——注释正文含块注释止符会提前终止 JSDoc，
 *  把后续代码吞进模板字符串，实测连环 parse error，本仓「注释写词法记号」活案例） */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
}

/** 取方法体文本范围（定义起点 → 下一个同类私有方法定义起点；无下一个则到文件尾）
 *  判据要求产出点落在方法体内，需按文本切片定位而非全文件搜索 */
function methodBody(src: string, defMarker: string): string {
  const start = src.indexOf(defMarker);
  if (start < 0) return '';
  const next = src.indexOf('\n  private ', start + defMarker.length);
  return next < 0 ? src.slice(start) : src.slice(start, next);
}

describe('折叠边界命名守卫：方法名 ↔ 产出事件名同阵营（loop.ts）', () => {
  const code = stripCommentLines(readFileSync(LOOP_TS, 'utf8'));

  it('plan_item_boundary：唯一产出点在 _maybeEmitPlanItemBoundary 方法体内', () => {
    const hits = code.match(/type: 'plan_item_boundary'/g) ?? [];
    expect(
      hits,
      'plan_item_boundary 产出点必须恰 1 处：多点 = 任务项边界语义分叉（宿主重复/错位分组）。' +
        '若确需扩产出点，先回 ADR-034 定案，再同步改本守卫与方法头注释。',
    ).toHaveLength(1);
    const body = methodBody(code, 'private *_maybeEmitPlanItemBoundary(');
    expect(
      body,
      '_maybeEmitPlanItemBoundary 定义未找到（方法名被改？同步本守卫与头注释）',
    ).not.toBe('');
    expect(
      body.match(/type: 'plan_item_boundary'/g) ?? [],
      'plan_item_boundary 产出点不在 _maybeEmitPlanItemBoundary 体内——方法名与产出事件名失去对账，' +
        '「勿据 step 字样误读」防线失效（本守卫锁的正是这条注释断言）。',
    ).toHaveLength(1);
  });

  it('step_boundary：唯一产出点在 _emitStepBoundary 方法体内', () => {
    const hits = code.match(/type: 'step_boundary'/g) ?? [];
    expect(hits, 'step_boundary 产出点必须恰 1 处：多点 = 落盘触发语义分叉').toHaveLength(1);
    const body = methodBody(code, 'private *_emitStepBoundary(');
    expect(body, '_emitStepBoundary 定义未找到（方法名被改？同步本守卫与头注释）').not.toBe('');
    expect(
      body.match(/type: 'step_boundary'/g) ?? [],
      'step_boundary 产出点不在 _emitStepBoundary 体内——方法名与产出事件名失去对账。',
    ).toHaveLength(1);
  });
});
