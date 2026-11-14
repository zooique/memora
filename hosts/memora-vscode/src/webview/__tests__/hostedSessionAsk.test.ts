/**
 * 主控代答子会话提问 · 实现域单测
 *
 * 钉住四件事（与工具定义的承诺一一对应）：
 *   ① 读题形态回带题面 / 选项 / 位次（代理必须知道在问什么、有几个选项）；
 *   ② 题数不等 ⇒ 整批拒收（E_ARGS），回执带当前题目；
 *   ③ 没有在途提问 / 没有已装配实例 ⇒ answered:false，不伪造成功、不装配；
 *   ④ 非托管调用方 ⇒ E_DENIED，且不读题、不交付。
 */
import { describe, expect, it, vi } from 'vitest';
import type { PendingQuestionDto } from '../../shared/protocol.js';
import {
  answerHostedQuestionsWith,
  toPendingQuestionBriefs,
  type HostedSessionAskDeps,
} from '../helpers/hostedSessionAsk.js';

/** 调用方会话 id（托管） */
const CALLER = '2026-11-14-orchestrator';
/** 目标会话 id */
const TARGET = '2026-11-14-child';

/**
 * 造一条在途提问（只补本用例消费的字段）
 *
 * @param question 题面
 * @param options 候选选项（缺省 = 自由作答）
 */
function pending(question: string, options?: string[]): PendingQuestionDto {
  return {
    slot: 'q',
    question,
    ...(options ? { options } : {}),
  };
}

/**
 * 造一套依赖替身（默认：托管调用方、两道题、有实例可答）
 *
 * @param overrides 按用例覆盖的字段
 */
function makeDeps(overrides: Partial<HostedSessionAskDeps> = {}): {
  deps: HostedSessionAskDeps;
  deliver: ReturnType<typeof vi.fn>;
} {
  const deliver = vi.fn(() => true);
  const questions = [pending('用哪个库？', ['A', 'B']), pending('写多长？')];
  const deps: HostedSessionAskDeps = {
    isManaged: (sid) => sid === CALLER,
    readQuestions: () => questions,
    // 与 AskCoordinator.checkAnswerCount 同语义：无题恒 ok，等长才 ok
    checkAnswerCount: (_sid, answers) =>
      answers.length === questions.length
        ? { ok: true }
        : { ok: false, expected: questions.length, got: answers.length },
    deliverAnswers: deliver,
    ...overrides,
  };
  return { deps, deliver };
}

describe('toPendingQuestionBriefs', () => {
  it('按原顺序编号，只透出题面 / 选项 / 自定义位，不带 slot 等内部身份', () => {
    expect(toPendingQuestionBriefs([pending('问一', ['x']), pending('问二')])).toEqual([
      { index: 0, question: '问一', options: ['x'] },
      { index: 1, question: '问二' },
    ]);
  });
});

describe('answerHostedQuestionsWith — 读题形态（answers 省略）', () => {
  it('回带题面 / 选项 / 位次，且不交付任何答案', () => {
    const { deps, deliver } = makeDeps();
    const result = answerHostedQuestionsWith(deps, CALLER, TARGET);
    expect(result).toEqual({
      ok: true,
      sid: TARGET,
      answered: false,
      questions: [
        { index: 0, question: '用哪个库？', options: ['A', 'B'] },
        { index: 1, question: '写多长？' },
      ],
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('没有在途提问：仍回 ok（不是错误），但说清「此刻没什么可答」', () => {
    const { deps } = makeDeps({ readQuestions: () => [] });
    const result = answerHostedQuestionsWith(deps, CALLER, TARGET);
    expect(result).toMatchObject({ ok: true, answered: false, questions: [] });
    expect((result as { note?: string }).note).toContain('没有待答提问');
  });
});

describe('answerHostedQuestionsWith — 作答形态', () => {
  it('题数不等：整批拒收（E_ARGS），回执带当前题目，且不交付', () => {
    const { deps, deliver } = makeDeps();
    const result = answerHostedQuestionsWith(deps, CALLER, TARGET, ['只答一题']);
    expect(result).toMatchObject({ ok: false, code: 'E_ARGS' });
    // 回执必须说清当前有几道题（模型据此补齐答案，而不是反复试错）
    expect((result as { message: string }).message).toContain('1 条');
    expect((result as { message: string }).message).toContain('2 道题');
    expect((result as { questions: unknown[] }).questions).toHaveLength(2);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('等长同序：原样交付（空串位保留，不压缩位次）', () => {
    const { deps, deliver } = makeDeps();
    const answers = ['选 A', ''];
    const result = answerHostedQuestionsWith(deps, CALLER, TARGET, answers);
    expect(result).toEqual({ ok: true, sid: TARGET, answered: true, answeredCount: 2 });
    expect(deliver).toHaveBeenCalledWith(TARGET, answers);
  });

  it('等长但没有已装配实例：如实回没答（answered:false），不伪造成功', () => {
    const { deps } = makeDeps({ deliverAnswers: () => false });
    const result = answerHostedQuestionsWith(deps, CALLER, TARGET, ['A', '短']);
    expect(result).toMatchObject({ ok: true, answered: false });
    expect((result as { note?: string }).note).toContain('没有已装配的实例');
  });

  it('没有在途提问却提交答案：回 answered:false，不交付', () => {
    const { deps, deliver } = makeDeps({ readQuestions: () => [] });
    const result = answerHostedQuestionsWith(deps, CALLER, TARGET, ['A']);
    expect(result).toMatchObject({ ok: true, answered: false, questions: [] });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('answerHostedQuestionsWith — 身份门禁', () => {
  it('非托管调用方：E_DENIED，且不读题、不交付', () => {
    const readQuestions = vi.fn(() => [pending('问一')]);
    const { deps, deliver } = makeDeps({ readQuestions });
    const result = answerHostedQuestionsWith(deps, '2026-11-14-user', TARGET, ['A']);
    expect(result).toMatchObject({ ok: false, code: 'E_DENIED' });
    expect(readQuestions).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
