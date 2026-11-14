/**
 * 主控代答子会话提问（工具 `answer_session_question` 的实现域）
 *
 * 为什么外置：面板已贴 `max-lines` 基线，这段「取题快照 → 校验题数 → 受理作答」是完整闭环，
 * 留在面板只会挤掉既有注释；按 B9-D 的既有拆法收进 helpers，面板只留注入依赖的薄壳。
 *
 * 事实边界（与工具定义同口径）：
 *   - 题面与选项**只能**来自目标会话既有的在途快照（`AskCoordinator.pendingQuestions`），
 *     本模块不推导、不补全、不编题；
 *   - 题数判据复用 `AskCoordinator.checkAnswerCount`（与面板作答入口同一真源）：
 *     条数不等 ⇒ 整批拒收，回执带当前题目供重答；
 *   - 目标没有已装配实例 ⇒ 如实回「没答」（answered:false），**不为回答问题凭空装配**。
 */
import type { PendingQuestionDto } from '../../shared/protocol.js';
import type {
  HostedAnswerResult,
  PendingQuestionBrief,
} from '../../extension/host/answerSessionQuestionTool.js';

/**
 * 代答依赖（全部由面板注入，本模块不持有任何实例）
 *
 * 三个读口刻意都返回「已有事实」而不是「取或建」：代答是附加能力，不许因为
 * 代理问了一句就把一个已收场的会话重新装起来。
 */
export interface HostedSessionAskDeps {
  /** 调用方是否托管（纵深防守：不只靠工具面缺席） */
  isManaged: (sessionId: string) => boolean;
  /** 目标会话的**在途提问快照**（只读已建的 ask 协调器；取不到 = 空，不新建） */
  readQuestions: (sessionId: string) => readonly PendingQuestionDto[];
  /** 题数校验（真源 = `AskCoordinator.checkAnswerCount`；无协调器时按「没有题」语义） */
  checkAnswerCount: (
    sessionId: string,
    answers: readonly string[],
  ) => { ok: true } | { ok: false; expected: number; got: number };
  /** 受理作答并起续跑（实现必须只取已装配实例；返回 false = 没有实例可答） */
  deliverAnswers: (sessionId: string, answers: readonly string[]) => boolean;
}

/** 没有在途提问时的说明（读题与作答共用同一句话，避免两处措辞漂移） */
const NO_PENDING_NOTE = '该会话当前没有待答提问（可能已作答、已超时或不在等待问答）。';

/** 没有已装配实例时的说明（取不到就如实说，不装配） */
const NO_INSTANCE_NOTE = '该会话当前没有已装配的实例，无法作答（可能已收场）；没有为它重新装配。';

/**
 * 把在途快照投影成对外事实（纯函数）
 *
 * 只保留「代理答得准」所需的四件事：位次、题面、选项、是否允许自定义；
 * 不透传 slot / askCallId 这类宿主内部身份（代理不需要，也没有用它做寻址的能力）。
 *
 * @param questions 目标会话的在途提问快照
 * @returns 按原顺序编号的题目清单
 */
export function toPendingQuestionBriefs(
  questions: readonly PendingQuestionDto[],
): PendingQuestionBrief[] {
  return questions.map((question, index) => ({
    index,
    question: question.question,
    ...(question.options ? { options: [...question.options] } : {}),
    ...(question.allowCustom === undefined ? {} : { allowCustom: question.allowCustom }),
  }));
}

/**
 * 读题 / 代答的统一入口
 *
 * 两种形态共用一次快照：`answers` 省略 = 只读题（必须先让代理知道问什么、有几个选项）；
 * 传入 = 按位提交（条数必须等于**这一次**快照里的题数）。
 *
 * @param deps 面板注入的窄依赖
 * @param callingSessionId 调用方（非托管一律 E_DENIED）
 * @param targetSessionId 目标会话（提问所属会话）
 * @param answers 与题目等长同序的答案；undefined = 只读题
 * @returns 代答回执（成功 / 没答 / 拒收三种形态，不 throw）
 */
export function answerHostedQuestionsWith(
  deps: HostedSessionAskDeps,
  callingSessionId: string,
  targetSessionId: string,
  answers?: readonly string[],
): HostedAnswerResult {
  if (!deps.isManaged(callingSessionId)) {
    return {
      ok: false,
      code: 'E_DENIED',
      message: '只有托管会话才能代答子会话的提问。',
      questions: [],
    };
  }
  const questions = toPendingQuestionBriefs(deps.readQuestions(targetSessionId));
  // 读题形态：无论有没有题都回 ok（没题不是错误，是「此刻没什么可答」）
  if (answers === undefined) {
    return {
      ok: true,
      sid: targetSessionId,
      answered: false,
      questions,
      ...(questions.length === 0 ? { note: NO_PENDING_NOTE } : {}),
    };
  }
  // 作答形态：没有在途提问 ⇒ 没有批次可答，如实回没答（不伪造 answered:true）
  if (questions.length === 0) {
    return {
      ok: true,
      sid: targetSessionId,
      answered: false,
      questions: [],
      note: NO_PENDING_NOTE,
    };
  }
  // 题数判据复用 ask 域单点：条数不等 ⇒ 整批拒收（按位回填必错位，宁可不写坏盘面）
  const count = deps.checkAnswerCount(targetSessionId, answers);
  if (!count.ok) {
    return {
      ok: false,
      code: 'E_ARGS',
      message:
        `答案条数必须等于当前在途题数（本次提交 ${count.got} 条 / 当前 ${count.expected} 道题），` +
        '整批未提交。请按回执里的 questions 顺序重新作答（空串 = 该题不答）。',
      questions,
    };
  }
  // 只取已装配实例：取不到就回没答，绝不为代答重新装配一个会话
  if (!deps.deliverAnswers(targetSessionId, answers)) {
    return {
      ok: true,
      sid: targetSessionId,
      answered: false,
      questions,
      note: NO_INSTANCE_NOTE,
    };
  }
  return { ok: true, sid: targetSessionId, answered: true, answeredCount: answers.length };
}
