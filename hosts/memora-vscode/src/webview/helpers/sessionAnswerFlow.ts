/**
 * 按会话作答的执行链（用户作答与主控代答共用）
 *
 * 为什么外置：面板已贴 `max-lines` 基线，而「清超时 → 上屏 → 清空 → 续跑」这段顺序契约
 * 必须只有一份（顺序一旦分叉，盘面与屏上就会各说一套）。调用方只给两个既有入口。
 *
 * ⚠️ 顺序不可调换：上屏要读该会话的 `_pending`（题目来自 ask 域），清空必须在**其后**——
 * 先清后 post 会让每题都拿不到 question/options，屏上只剩一行干瘪的「你答」。
 */
import type { Agent, AgentChunk } from '@zooique/memora';
import type { AskCoordinator } from '../../extension/host/askCoordinator.js';

/** 执行链依赖（均为面板既有入口，本模块不新造流控制） */
export interface SessionAnswerFlowDeps {
  /** 取（或建）该会话的 ask 协调器 */
  askFor: (sessionId: string) => AskCoordinator;
  /** 起续跑（面板 runFlow；会话归属显式传入） */
  runFlow: (
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
    sessionId: string,
  ) => Promise<void>;
}

/**
 * 把一批答案交给指定会话，并续跑该会话
 *
 * @param deps      面板注入的两个既有入口
 * @param sessionId 提问所属会话（也是本轮流归属）
 * @param agent     该会话自己的实例（内核 pendingAsk 在这个实例里）
 * @param answers   与在途提问等长同序的答案（空串 = 该题未答，不压缩位次）
 */
export async function runSessionAnswerFlow(
  deps: SessionAnswerFlowDeps,
  sessionId: string,
  agent: Agent,
  answers: string[],
): Promise<void> {
  const ask = deps.askFor(sessionId);
  ask.clearAskTimeout(); // 提问被回答：关闭超时保底
  // 逐题按有无答案分派 question-answer / unanswered：屏上 N 条与内核 `runResume` 落盘同构
  ask.postAnswerRows(answers);
  ask.clearPending();
  await deps.runFlow((signal) => {
    // 按位一对一：空串位由内核归一为「该题未答」，故不得压缩位次；
    // join 全文作持续输入注入（空答案不参与，避免空行噪声）。
    agent.answerQuestion(answers);
    return agent.resumeExecution(
      answers.filter((a) => a.trim()).join('\n'),
      signal,
      'question-answer',
    );
  }, sessionId);
}
