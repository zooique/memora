/**
 * 会话投影纯函数（R0-b）—— 任意会话素材 → `{ state, rounds }`
 *
 * 设计源：docs/方案-手机远程控制-20261110.md §「B2 桥必须自己持有 per-session 投影」
 *
 * 为什么要有本文件：`chatPanel.postTurnUpdate` 的投影逻辑（合并 live 轮 + 折叠 TurnState）
 * 原本内联在**当前显示会话**的方法里，只能投影前台会话。远程/桥需要「给定任意 sid 的素材
 * 也能取到同一份投影」，因此把这两步抽成与宿主焦点无关的纯函数：
 *   - 输入只有「该会话自己的素材」（落盘轮 + live 轮 + 相位信号），**不含任何显示态**；
 *   - 输出形状与 `turn_update` 载荷的 `{ state, rounds }` 同形，任何会话按同一规则投影。
 *
 * 同源复用（不复制判据）：
 *   - live 轮合并 → `mergeLiveRound`（turnProjection.ts）
 *   - 状态折叠 → `deriveTurnState`（turnProjection.ts）
 * 本文件不新增任何取舍规则，只做「把两步串起来」这一件编排——判据仍各归其源。
 *
 * 边界：不含 postMessage / DOM / vscode / 内核调用；附件 URL 盖章等**宿主专属**后处理
 * （依赖 `toWebviewUri`）不在此处，由调用方在拿到 `rounds` 后自行施做。
 */

import type { PendingQuestionDto, RoundView, TurnState } from './protocol.js';
import { deriveTurnState, mergeLiveRound, type PendingLiveRound } from './turnProjection.js';

/**
 * 单个会话的投影素材（调用方保证「同一会话」——本函数不做会话归属校验）
 *
 * 之所以不接收 sid：素材本身已经是按 sid 取出来的（历史轮、live 缓冲、相位信号同属一会话）；
 * 再传一个 sid 只会制造「第二个会话身份来源」，且本函数无法校验它，属假防御。
 */
export interface SessionProjectionInput {
  /** 该会话的落盘历史轮（持久化渲染真相源） */
  history: readonly RoundView[];
  /** 该会话的运行时当前轮（无流在跑时缺省） */
  live?: PendingLiveRound;
  /** 该会话是否有流在运行 */
  streaming: boolean;
  /** 该会话是否已真正挂起（`sessionManager.status === 'paused'`） */
  paused: boolean;
  /** 该会话的暂停申请是否在途（step 边界未到） */
  pausePending?: boolean;
  /** 该会话的在途提问（非空即 ask 挂起） */
  pendingQuestions?: readonly PendingQuestionDto[];
}

/** 会话投影结果（与 `turn_update` 的 `state` / `rounds` 同形） */
export interface SessionProjection {
  /** 折叠后的单一轮次相位 */
  state: TurnState;
  /** 合并 live 轮后的渲染轮序列（未盖章附件 URL） */
  rounds: RoundView[];
}

/**
 * 投影任意会话：合并 live 轮 + 折叠 TurnState
 *
 * @param input 单会话素材（见 `SessionProjectionInput`）
 */
export function deriveSessionProjection(input: SessionProjectionInput): SessionProjection {
  // 先合并：live 轮按 roundId 原位替换历史轮。
  // 元素原样返回（不深拷贝轮对象），但数组每次新建（浅拷贝）——目的是不改写调用方传入的历史数组
  const rounds = mergeLiveRound([...input.history], input.live);
  const last = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;
  // 再折叠：判据全在 deriveTurnState 内（ask > pause > pausePending > running > settled > idle）
  const state = deriveTurnState({
    streaming: input.streaming,
    paused: input.paused,
    pausePending: input.pausePending,
    pendingQuestions: input.pendingQuestions,
    liveRoundId: input.live?.roundId,
    lastRound: last ? { id: last.id, status: last.status } : undefined,
  });
  return { state, rounds };
}
