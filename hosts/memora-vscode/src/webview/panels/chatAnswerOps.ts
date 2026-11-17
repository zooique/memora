/**
 * 会话作答域（用户作答 + 主控代答）
 *
 * 为什么外置成 op 模块：面板已贴 `max-lines` 基线，而这两条入口必须共用**同一条执行链**
 * （清超时 → 上屏 → 清空 → 续跑）——分两处写就迟早顺序分叉、盘面与屏上各说一套。
 *
 * 事实边界：
 *   - 用户作答：会话与实例取面板当前事实（`currentSession`），与路由守卫同一口径；
 *   - 主控代答：题面只读目标会话**已建**的 ask 协调器、实例只取**已装配**的，
 *     取不到就如实回「没答」，不为回答问题凭空装配（判据与回执形态在 `hostedSessionAsk`）。
 */
import type { Agent, AgentChunk } from '@zooique/memora';
import type { AskCoordinator } from '../../extension/host/askCoordinator.js';
import type { HostedQuestionAnswerer } from '../../extension/host/answerSessionQuestionTool.js';
import { answerHostedQuestionsWith } from '../helpers/hostedSessionAsk.js';
import { runSessionAnswerFlow } from '../helpers/sessionAnswerFlow.js';

/** 作答域依赖（全部是面板既有入口 / 只读事实，本模块不新造流控制） */
export interface ChatAnswerOpsDeps {
  /** 用户作答的目标（与面板路由同一事实：当前会话 + 当前实例） */
  currentSession: () => { sessionId: string; agent: Agent | undefined };
  /** 调用方是否托管（代答的纵深门禁） */
  isManaged: (sessionId: string) => boolean;
  /** 只读已建 ask 协调器（不新建：没建 = 没有在途提问） */
  getAsk: (sessionId: string) => AskCoordinator | undefined;
  /** 只取已装配实例（不装配） */
  getAgent: (sessionId: string) => Agent | undefined;
  /** 取（或建）当前会话协调器（用户流程既有入口） */
  askFor: (sessionId: string) => AskCoordinator;
  /** 面板 runFlow（会话归属显式传入） */
  runFlow: (
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
    sessionId: string,
  ) => Promise<void>;
}

/** 作答域对外面（面板原样转出） */
export interface ChatAnswerOps {
  /**
   * 用户作答（面板 `answer` 意图的唯一入口）
   *
   * 处理用户对主动提问的回答：`answerQuestion` 结构化回填 + `resumeExecution` 续跑。
   *   - 内核提问由 `ask_user` 工具承载——先 `answerQuestion` 以 tool result 回填
   *     （与 `assistant.tool_calls` 配对，结构合法），再由 `resumeExecution` 续跑
   *     （回答 text 作为新 user 输入注入并记录交互归属 `question-answer`，round 不分裂）；
   *   - 回答落盘由内核 `runResume` 按交互归属写入同闭环节点，宿主不双写；
   *   - 多 ask 聚合回答（`clarify_answers`）传入数组，answers 与提问按序一对一：
   *     逐条 post 透出「你答」交互行 + `answerQuestion(answers)` 数组回填 +
   *     `resumeExecution` 以 join 全文注入（内核 `answerQuestion` 原生支持数组）；
   *   - 守卫（Agent 就绪 / 会话存在）与错位拦截收归面板 `handleInput` 相位路由
   *     （单一判据），提问原文读 `turn_update` 投影（按会话分片的 turn 状态单点真源，
   *     ask 域的在途提问仅事件写入源，非消费式 splice）。
   *
   * @param answers 归一后的回答数组（单问 = 单元素，answer 意图恒数组）
   * @param sessionId 目标会话（缺省 = 当前显示会话；助手窗显式传助手会话）
   */
  answerInput: (answers: string[], sessionId?: string) => Promise<void>;
  /** 主控代答（工具 `answer_session_question` 的宿主回调） */
  answerHostedQuestions: HostedQuestionAnswerer;
}

/**
 * 建作答域
 *
 * @param deps 面板注入的既有入口与只读事实
 * @returns 两条入口（共用同一条按会话作答执行链）
 */
export function createChatAnswerOps(deps: ChatAnswerOpsDeps): ChatAnswerOps {
  // 两条入口共用：会话、实例、答案均由调用方显式给出（不读隐式当前态）
  const answerForSession = (sessionId: string, agent: Agent, answers: string[]) =>
    runSessionAnswerFlow({ askFor: deps.askFor, runFlow: deps.runFlow }, sessionId, agent, answers);
  return {
    answerInput: async (answers, sessionId) => {
      // 目标会话显式给出时用它（助手窗）：实例取已装配的那台，不读侧栏的当前实例
      const current = deps.currentSession();
      const targetId = sessionId ?? current.sessionId;
      const agent = sessionId ? deps.getAgent(sessionId) : current.agent;
      // 路由层已保证有实例；共享入口放宽为可空，防御装配中途被回收
      if (!agent) return;
      await answerForSession(targetId, agent, answers);
    },
    answerHostedQuestions: (calling, target, answers) =>
      answerHostedQuestionsWith(
        {
          isManaged: deps.isManaged,
          // 只读已建协调器：`_pending` 是提问的宿主侧唯一快照
          readQuestions: (sid) => deps.getAsk(sid)?.pendingQuestions() ?? [],
          // 题数判据复用 ask 域单点（helper 已先判空，无协调器不会被走到）
          checkAnswerCount: (sid, submitted) =>
            deps.getAsk(sid)?.checkAnswerCount(submitted) ?? { ok: true },
          // 只取已装配实例；`void` 不等待整轮跑完（与派发同口径：要的是已受理）
          deliverAnswers: (sid, submitted) => {
            const agent = deps.getAgent(sid);
            if (!agent) return false;
            void answerForSession(sid, agent, [...submitted]);
            return true;
          },
        },
        calling,
        target,
        answers,
      ),
  };
}
