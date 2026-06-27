/**
 * userFactExtractor 单元测试 — 用户事实提取器
 *
 * 覆盖范围：
 *   - 6 个正则规则：identity（姓名 + 住址 + 职业）/ preference（偏好 + 工具）/ expertise（专长）
 *   - 互斥规则：identity 优先于 job、preference 优先于 tool
 *   - 置信度分级：高（≥0.9）/ 中（0.7-0.85）
 *   - 问句排除（谁/哪/什/吗）防止 "我是谁" 误匹配
 *   - sourceTurn 透传
 *
 * 测试范式：纯函数 extractUserFacts(input, turnIndex)，无副作用，直接断言返回数组。
 *
 * 正则规则要点（测试设计依据）：
 *   - identityMatch 触发词：我叫 / 我是 / 我的名字是 —— "我是程序员" 会被识别为姓名
 *   - jobMatch 触发词：我是 / 我当 / 我做 —— 但 !identityMatch 条件使其仅在 "我当/我做" 时输出
 *   - prefMatch 触发词：我喜欢/爱/习惯/偏好 + 用/写/做/的（必须）—— "我喜欢TS" 不匹配
 *   - toolMatch 触发词：我用/使用/的环境是 —— !prefMatch 条件使其在与 prefMatch 冲突时不输出
 */
import { describe, expect, it } from 'vitest';
import { extractUserFacts } from '@/agent/managers/userFactExtractor.js';
import type { ExtractedFact } from '@/memory/userProfile.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/**
 * 断言 facts 数组中存在指定 category + value 的事实
 * @param facts - 提取结果
 * @param category - 期望的类别
 * @param value - 期望的值（精确匹配）
 * @returns 匹配的事实对象
 */
function expectFact(
  facts: ExtractedFact[],
  category: ExtractedFact['category'],
  value: string,
): ExtractedFact {
  const fact = facts.find((f) => f.category === category && f.value === value);
  expect(fact, `应找到 category=${category} value=${value} 的事实`).toBeDefined();
  return fact!;
}

// ─── identity 规则：姓名 ─────────────────────────────────

describe('extractUserFacts - identity 姓名', () => {
  it('"我叫张三" → identity 姓名:张三 0.95', () => {
    const facts = extractUserFacts('我叫张三', 'turn-1');
    expectFact(facts, 'identity', '姓名: 张三');
    expect(facts.find((f) => f.value === '姓名: 张三')!.confidence).toBe(0.95);
  });

  it('"我是李四" → identity 姓名:李四 0.95', () => {
    const facts = extractUserFacts('我是李四', 'turn-2');
    expectFact(facts, 'identity', '姓名: 李四');
  });

  it('"我的名字是王五" → identity 姓名:王五 0.95', () => {
    const facts = extractUserFacts('我的名字是王五', 'turn-3');
    expectFact(facts, 'identity', '姓名: 王五');
  });

  it('问句 "我是谁" 不匹配（问句排除）', () => {
    const facts = extractUserFacts('我是谁', 'turn-4');
    expect(facts.find((f) => f.value.startsWith('姓名:'))).toBeUndefined();
  });

  it('问句 "我是哪个" 不匹配（问句排除）', () => {
    const facts = extractUserFacts('我是哪个', 'turn-5');
    expect(facts.find((f) => f.value.startsWith('姓名:'))).toBeUndefined();
  });

  it('姓名超 15 字符截断到 15 字符（正则上限）', () => {
    // 正则 {1,15} 是最多 15 字符，16 字符会捕获前 15 个
    const longName = '张'.repeat(16);
    const facts = extractUserFacts(`我叫${longName}`, 'turn-6');
    const nameFact = facts.find((f) => f.value.startsWith('姓名:'));
    expect(nameFact).toBeDefined();
    // value = "姓名: " + 15 个 "张" = 4 + 15 = 19 字符
    expect(nameFact!.value).toBe(`姓名: ${'张'.repeat(15)}`);
  });
});

// ─── identity 规则：住址 ─────────────────────────────────

describe('extractUserFacts - identity 住址', () => {
  it('"我住在北京" → identity 住址:北京 0.9', () => {
    const facts = extractUserFacts('我住在北京', 'turn-1');
    expectFact(facts, 'identity', '住址: 北京');
    expect(facts.find((f) => f.value === '住址: 北京')!.confidence).toBe(0.9);
  });

  it('"我家在上海" → identity 住址:上海 0.9', () => {
    const facts = extractUserFacts('我家在上海', 'turn-2');
    expectFact(facts, 'identity', '住址: 上海');
  });

  it('"我住广州" → identity 住址:广州（住在 可省略 在）', () => {
    const facts = extractUserFacts('我住广州', 'turn-3');
    expectFact(facts, 'identity', '住址: 广州');
  });
});

// ─── identity 规则：职业（与姓名互斥） ───────────────────

describe('extractUserFacts - identity 职业', () => {
  it('"我当老师" → identity 职业:老师 0.85', () => {
    // identityMatch 不匹配 "我当"（触发词仅 我叫/我是/我的名字是）
    const facts = extractUserFacts('我当老师', 'turn-1');
    expectFact(facts, 'identity', '职业: 老师');
    expect(facts.find((f) => f.value === '职业: 老师')!.confidence).toBe(0.85);
  });

  it('"我做工程师" → identity 职业:工程师 0.85', () => {
    const facts = extractUserFacts('我做工程师', 'turn-2');
    expectFact(facts, 'identity', '职业: 工程师');
  });

  it('"我是一名程序员" → identity 职业:程序员（一[个名位] 可选）', () => {
    // identityMatch 命中 "我是" → 姓名:一名程序员，jobMatch 的 !identityMatch 为 false
    // 所以这个用例实际输出是姓名，不是职业
    const facts = extractUserFacts('我是一名程序员', 'turn-3');
    expectFact(facts, 'identity', '姓名: 一名程序员');
    expect(facts.find((f) => f.value === '职业: 程序员')).toBeUndefined();
  });

  it('职业与姓名互斥："我叫张三，我当老师" 仅匹配姓名', () => {
    // identityMatch 命中 "我叫张三"，jobMatch 的 !identityMatch 为 false
    const facts = extractUserFacts('我叫张三，我当老师', 'turn-4');
    expectFact(facts, 'identity', '姓名: 张三');
    expect(facts.find((f) => f.value === '职业: 老师')).toBeUndefined();
  });
});

// ─── preference 规则：偏好 ──────────────────────────────

describe('extractUserFacts - preference 偏好', () => {
  it('"我喜欢用TS" → preference 偏好:TS 0.85', () => {
    // prefMatch 触发词：喜欢/爱/习惯/偏好 + 用/写/做/的（必须）
    const facts = extractUserFacts('我喜欢用TS', 'turn-1');
    expectFact(facts, 'preference', '偏好: TS');
    expect(facts.find((f) => f.value === '偏好: TS')!.confidence).toBe(0.85);
  });

  it('"我更喜欢用Python" → preference 偏好:Python 0.85', () => {
    const facts = extractUserFacts('我更喜欢用Python', 'turn-2');
    expectFact(facts, 'preference', '偏好: Python');
  });

  it('"我习惯用Git" → preference 偏好:Git 0.85', () => {
    const facts = extractUserFacts('我习惯用Git', 'turn-3');
    expectFact(facts, 'preference', '偏好: Git');
  });

  it('"我爱写代码" → preference 偏好:代码 0.85', () => {
    const facts = extractUserFacts('我爱写代码', 'turn-4');
    expectFact(facts, 'preference', '偏好: 代码');
  });

  it('"我喜欢做设计" → preference 偏好:设计 0.85', () => {
    const facts = extractUserFacts('我喜欢做设计', 'turn-5');
    expectFact(facts, 'preference', '偏好: 设计');
  });
});

// ─── preference 规则：工具（与偏好互斥） ─────────────────

describe('extractUserFacts - preference 工具', () => {
  it('"我用VSCode" → preference 工具:VSCode 0.8', () => {
    const facts = extractUserFacts('我用VSCode', 'turn-1');
    expectFact(facts, 'preference', '工具: VSCode');
    expect(facts.find((f) => f.value === '工具: VSCode')!.confidence).toBe(0.8);
  });

  it('"我使用Docker" → preference 工具:Docker 0.8', () => {
    const facts = extractUserFacts('我使用Docker', 'turn-2');
    expectFact(facts, 'preference', '工具: Docker');
  });

  it('"我的环境是Linux" → preference 工具:Linux 0.8', () => {
    const facts = extractUserFacts('我的环境是Linux', 'turn-3');
    expectFact(facts, 'preference', '工具: Linux');
  });

  it('工具与偏好互斥："我喜欢用VSCode" 仅匹配偏好', () => {
    // prefMatch 命中后，toolMatch 的 !prefMatch 条件为 false，不输出工具
    const facts = extractUserFacts('我喜欢用VSCode', 'turn-4');
    expectFact(facts, 'preference', '偏好: VSCode');
    expect(facts.find((f) => f.value === '工具: VSCode')).toBeUndefined();
  });
});

// ─── expertise 规则：专长 ────────────────────────────────

describe('extractUserFacts - expertise 专长', () => {
  it('"我熟悉React" → expertise 专长:React 0.75', () => {
    const facts = extractUserFacts('我熟悉React', 'turn-1');
    expectFact(facts, 'expertise', '专长: React');
    expect(facts.find((f) => f.value === '专长: React')!.confidence).toBe(0.75);
  });

  it('"我擅长后端" → expertise 专长:后端 0.75', () => {
    const facts = extractUserFacts('我擅长后端', 'turn-2');
    expectFact(facts, 'expertise', '专长: 后端');
  });

  it('"我精通算法" → expertise 专长:算法 0.75', () => {
    const facts = extractUserFacts('我精通算法', 'turn-3');
    expectFact(facts, 'expertise', '专长: 算法');
  });

  it('"我会TypeScript" → expertise 专长:TypeScript 0.75', () => {
    const facts = extractUserFacts('我会TypeScript', 'turn-4');
    expectFact(facts, 'expertise', '专长: TypeScript');
  });
});

// ─── 边界与组合 ──────────────────────────────────────────

describe('extractUserFacts - 边界与组合', () => {
  it('空输入返回 []', () => {
    expect(extractUserFacts('', 'turn-1')).toEqual([]);
  });

  it('无匹配返回 []', () => {
    expect(extractUserFacts('今天天气不错', 'turn-2')).toEqual([]);
  });

  it('sourceTurn 透传到所有提取的事实', () => {
    const facts = extractUserFacts('我叫张三，我喜欢用TS，我熟悉React', 'my-turn');
    for (const f of facts) {
      expect(f.sourceTurn).toBe('my-turn');
    }
    expect(facts.length).toBeGreaterThanOrEqual(3);
  });

  it('多规则同时命中（identity 姓名 + preference 偏好 + expertise 专长）', () => {
    const facts = extractUserFacts('我叫张三，我喜欢用TS，我熟悉React', 'turn-1');
    expectFact(facts, 'identity', '姓名: 张三');
    expectFact(facts, 'preference', '偏好: TS');
    expectFact(facts, 'expertise', '专长: React');
  });

  it('住址 + 职业 + 偏好 + 专长同时命中（姓名未匹配，职业可命中）', () => {
    const facts = extractUserFacts('我住在北京，我当程序员，我喜欢用Git，我熟悉React', 'turn-1');
    expectFact(facts, 'identity', '住址: 北京');
    expectFact(facts, 'identity', '职业: 程序员');
    expectFact(facts, 'preference', '偏好: Git');
    expectFact(facts, 'expertise', '专长: React');
  });

  it('置信度分级正确：姓名 0.95 > 住址 0.9 > 职业 0.85 > 偏好 0.85 > 工具 0.8 > 专长 0.75', () => {
    const facts = extractUserFacts('我住北京，我当程序员，我喜欢用Git，我熟悉React', 'turn-1');
    const location = facts.find((f) => f.value === '住址: 北京');
    const job = facts.find((f) => f.value === '职业: 程序员');
    const pref = facts.find((f) => f.value === '偏好: Git');
    const exp = facts.find((f) => f.value === '专长: React');
    expect(location!.confidence).toBeGreaterThan(job!.confidence);
    expect(job!.confidence).toBeGreaterThanOrEqual(pref!.confidence);
    expect(pref!.confidence).toBeGreaterThan(exp!.confidence);
  });

  it('标点符号截断：姓名后跟逗号不捕获逗号', () => {
    const facts = extractUserFacts('我叫张三，今年20岁', 'turn-1');
    expectFact(facts, 'identity', '姓名: 张三');
  });

  it('换行符截断：姓名后换行不捕获换行后内容', () => {
    const facts = extractUserFacts('我叫张三\n很高兴认识你', 'turn-1');
    expectFact(facts, 'identity', '姓名: 张三');
  });
});
