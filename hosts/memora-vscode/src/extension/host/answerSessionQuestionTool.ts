/**
 * 代答子会话提问的工具面（定义 + 参数解析 + 回执类型）
 *
 * 为什么单独成文件：`workSessionTools.ts` 已贴 `max-lines` 上限，而本工具是独立闭环
 * （读题 / 按位作答 / 题数不符整批拒收），按既有拆法外置；注册仍在 `workSessionTools`
 * （与其它会话工具同一注册面），本文件不持有 sessionStore / 面板依赖。
 */
import type { ToolDefinition } from '@zooique/memora';

/**
 * 代答子会话提问工具名
 *
 * 为什么需要它：子会话 `ask_user` 的提问只在它自己的界面上，后台会话的提问代理看不见、
 * 也答不了 ⇒ 代理只能干等 30 分钟超时（超时 = 自动继续，等于让模型替用户拍板）。
 *
 * 与 `send_to_session` 的分界：本工具只回答**已经挂起的提问**，不投递新输入、不建轮；
 * 题面与选项必须由宿主如实带回，代理不能凭空编答案。
 */
export const ANSWER_SESSION_QUESTION_TOOL_NAME = 'answer_session_question';

/**
 * 一条待答提问的对外事实（题面 + 选项）
 *
 * `index` = 提交答案时的位次（与 `answers` 同序同长）：内核按位回填，
 * 代理必须按这个顺序给答案，压缩位次即错位。
 */
export interface PendingQuestionBrief {
  /** 位次（0 起，与 `answers` 数组下标一一对应） */
  index: number;
  /** 提问原文 */
  question: string;
  /** 候选选项（LLM 提供时；空/缺省 = 只能自由作答） */
  options?: string[];
  /** 是否允许自定义输入（非选项作答） */
  allowCustom?: boolean;
}

/**
 * 代答结果（业务失败一律 `{ ok:false }`，不 throw）
 *
 * 码集按**产生位置**分：
 *   - 工具层：`E_ARGS`（参数形态不对）、`E_NOT_FOUND`（会话不存在）、`E_HOST`（宿主异常）；
 *   - 宿主层：`E_DENIED`（调用方非托管）、`E_ARGS`（**答案条数与在途题数不等** ⇒ 整批拒收，
 *     与面板既有 `AskCoordinator.checkAnswerCount` 同一判据）。
 *
 * `answered:false` **不是错误**：目标不在等待问答（已作答 / 已超时 / 已收场），
 * 或没有已装配实例可答——如实说「没有答」，不伪造成功。
 */
export type HostedAnswerResult =
  | { ok: true; sid: string; answered: true; answeredCount: number }
  | {
      ok: true;
      sid: string;
      answered: false;
      /** 此刻的题目快照（为空数组 = 没有在途提问） */
      questions: PendingQuestionBrief[];
      /** 为什么没答（没有在途提问 / 没有可答实例） */
      note?: string;
    }
  | {
      ok: false;
      code: 'E_DENIED' | 'E_ARGS';
      message: string;
      /** 数量不符时回带当前题目，代理据此重答（不是新错误码，是既有码 + 可执行信息） */
      questions: PendingQuestionBrief[];
    };

/**
 * 代答回调（面板实现；工具 handler 不持有面板实例）
 *
 * 实现必须**按 sid 取目标会话既有实例与既有 ask 协调器**（只取不建）：
 * 取不到就如实回 `answered:false`，不许为回答问题凭空装配一个实例。
 */
export type HostedQuestionAnswerer = (
  callingSessionId: string,
  targetSessionId: string,
  /** 省略 = 只读题目；传入 = 按位提交答案（长度必须等于在途题数） */
  answers?: readonly string[],
) => HostedAnswerResult;

/**
 * 代答子会话提问工具定义（声明面）
 *
 * - `readonly: false`：作答会让目标会话继续跑（可能写文件），只读模式应拦住；
 * - `diskWrite: 'none'`：本工具不直接写项目磁盘（落盘发生在目标会话自己的续跑里）；
 * - `confirmPolicy: 'audit'`：与本组其它会话工具同档；
 * - 参数封闭：只有 sid / answers；`answers` 省略 = 只读题目（必须先读到题面与选项，
 *   否则代理只能瞎猜）；未知键在 handler 判 `E_ARGS`。
 *
 * 为什么不拆成「读题」+「作答」两个工具：题面与答案必须来自**同一份在途快照**，
 * 拆两个工具会让模型在两次调用之间被超时/重答替换题目；一次入口 + 省略即读，
 * 判据只有一处。
 */
export const ANSWER_SESSION_QUESTION_DEFINITION: ToolDefinition = {
  name: ANSWER_SESSION_QUESTION_TOOL_NAME,
  description:
    '回答指定会话正在等待的提问（ask_user）。' +
    '先省略 answers 调用一次：回执带 questions（每题的 index / question / options），按 index 顺序作答。' +
    '再提交 answers：必须与当前题目**等长同序**（空串 = 该题不答）；' +
    '条数不等于当前题数时整批拒收（E_ARGS），回执同样带 questions 供你重答。' +
    '目标不在等待问答（已答 / 已超时 / 已收场）时回 answered=false，这不是错误。' +
    'sid 必须来自 list_work_sessions；本工具不投递新任务，投递请用 send_to_session。',
  parameters: {
    type: 'object',
    properties: {
      sid: { type: 'string', description: '目标会话标识（list_work_sessions 返回的 sid）' },
      answers: {
        type: 'array',
        // 内核 ToolDefinition 的 items 形参要求带 properties / required（历史形态），照填空壳
        items: { type: 'string', properties: {}, required: [] },
        description:
          '与当前题目等长同序的答案（空串 = 该题不答）。省略整个键 = 只查看题面与选项，不提交回答。',
      },
    },
    // sid 必填；answers 省略即「读题」，不能写进 required（否则读题形态被 schema 拦掉）
    required: ['sid'],
  },
  readonly: false,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 校验 `answer_session_question` 的参数（只接受 { sid, answers? }）
 *
 * 位次纪律与面板作答入口一致：`answers` **只 trim、不过滤**——空串是「该题不答」的合法占位，
 * 过滤掉会把后面的答案整体前移（内核按位回填，压缩位次即错位）。
 *
 * @param args 工具执行器传入的已解析参数
 * @returns 合法载荷（`answers` 缺省 = 只读题）；undefined = 未知键 / 缺键 / 类型不对
 */
export function parseAnswerQuestionArgs(
  args: Record<string, unknown>,
): { sid: string; answers?: string[] } | undefined {
  const keys = Object.keys(args);
  // 键集只允许 sid / answers；多一个未知键就拒（不忽略、不透传）
  if (keys.some((key) => key !== 'sid' && key !== 'answers')) return undefined;
  const { sid, answers } = args;
  if (typeof sid !== 'string' || sid.trim() === '') return undefined;
  // 省略 answers = 只读题目（不是「提交空批次」）
  if (answers === undefined) return { sid };
  if (!Array.isArray(answers)) return undefined;
  if (answers.some((item) => typeof item !== 'string')) return undefined;
  return { sid, answers: (answers as string[]).map((answer) => answer.trim()) };
}
