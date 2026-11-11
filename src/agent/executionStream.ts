/**
 * 执行流消费的纯逻辑（正文累积 + 中止/失败分类）
 *
 * 为什么单独成文件：同一套「消费 loop 的执行流」逻辑有两个消费者——
 *   1. `Agent.consumeExecutionStream`（父会话：要透传给宿主、要写 SessionManager 暂停态）；
 *   2. 子会话（`assembler.runSubagent`：同步跑完只要最终正文与终态，不能写父的暂停态）。
 * 两份手抄必然漂移（尤其是 AbortError 的三种去向），故把**与 Agent 状态无关的部分**
 * 抽到这里；父侧的 `sessionManager.pause()` / `cancelPendingPause()` 仍留在 Agent 内。
 *
 * 边界：本模块不依赖 Agent / SessionManager 等会话对象（只依赖 chunk 类型、错误判据与日志），
 * 因此子会话可直接复用而不继承父的任何可变状态。
 */

import type { AgentChunk } from '@/agent/types.js';
import { isAbortError, isTimeoutAbortSignal, isTimeoutError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';

/**
 * 执行流累积态（纯数据，不含任何会话引用）
 *
 * `content` = 供持久化/回传的正文；`aborted` / `paused` 是 loop 的终态标志。
 */
export interface ExecutionStreamState {
  /** 累积的正常回答正文（不含 self_review 自审查文本） */
  content: string;
  /** 是否已收到 aborted 终态（loop 判定中断或外层归纳） */
  aborted: boolean;
  /** 是否已在 step 边界挂起（软暂停） */
  paused: boolean;
}

/** 创建一份空的累积态 */
export function createExecutionStreamState(): ExecutionStreamState {
  return { content: '', aborted: false, paused: false };
}

/**
 * 把单个 chunk 并入累积态（**只读 chunk，不产生副作用**）
 *
 * 正文规则与父会话持久化口径一致：
 *   - `text` 且 stage≠self_review → 追加（自审查是内部思考，不进正文）；
 *   - `narrate.withdrawn` → 从正文尾部扣除该段（契约不符则忽略，宁可多留叙述也不误删答案）；
 *   - `aborted` / `paused` → 置对应标志。
 *
 * @param state 累积态（就地更新）
 * @param chunk 本次从 loop 收到的 chunk
 */
export function observeExecutionChunk(state: ExecutionStreamState, chunk: AgentChunk): void {
  if (chunk.type === 'text' && chunk.stage !== 'self_review') {
    state.content += chunk.content;
  } else if (chunk.type === 'narrate' && chunk.withdrawn) {
    // 回抽契约：withdrawn 是最近追加正文的后缀；不符时只忽略（删错真实答案比多留一段叙述更糟）
    if (state.content.endsWith(chunk.withdrawn)) {
      state.content = state.content.slice(0, state.content.length - chunk.withdrawn.length);
    } else {
      // 保留父会话原有的可观测性：异常序/多 turn 复用流时不能静默吞掉不匹配
      logger.warn(
        { withdrawnLen: chunk.withdrawn.length, contentLen: state.content.length },
        'narrate 回抽：正文不含该段（后缀契约不符），已忽略',
      );
    }
  } else if (chunk.type === 'aborted') {
    state.aborted = true;
  } else if (chunk.type === 'paused') {
    state.paused = true;
  }
}

/** 执行流异常的三种去向（决定终态与要给宿主/子会话看的 chunk） */
export type ExecutionStreamErrorKind = 'user-abort' | 'internal-abort' | 'error';

/** 异常分类结果：待回放的 chunk + 终态 + 分类标签（供调用方决定是否记日志） */
export interface ExecutionStreamErrorClassification {
  /** 原逻辑会 yield 给宿主的 chunk（父/子共用同一文案与分类） */
  chunk: AgentChunk;
  /** 终态：aborted=true 表示「中断保留半截正文」，false 表示失败 */
  aborted: boolean;
  /** 失败与否（与 aborted 互斥） */
  failed: boolean;
  /** 分类标签（仅用于日志/调试，不参与业务判据） */
  kind: ExecutionStreamErrorKind;
}

/**
 * 把执行流抛出的异常归类为 chunk + 终态（父会话 catch 分支的唯一真源）
 *
 * 三种去向（与重构前 Agent.consumeExecutionStream 的 catch 逐字同源）：
 *   1. `AbortError` 且外部 signal 已 abort → 真用户取消（非失败），产出 aborted chunk；
 *      其中 signal.reason 是超时 → stopReason='timeout'；
 *   2. `AbortError` 但 signal 未 abort → provider/网络内部中断，按连接中断的 error 收口；
 *   3. 其余异常（含 TimeoutError 看门狗）→ error 收口，超时补 category。
 *
 * @param err 捕获到的异常
 * @param signal turn 外部中止信号
 */
export function classifyExecutionStreamError(
  err: unknown,
  signal: AbortSignal | undefined,
): ExecutionStreamErrorClassification {
  if (isAbortError(err)) {
    if (signal?.aborted) {
      return {
        chunk: {
          type: 'aborted',
          reason: isTimeoutAbortSignal(signal)
            ? 'LLM request timed out (no response)'
            : 'User cancelled the conversation',
          stopReason: isTimeoutAbortSignal(signal) ? 'timeout' : 'user',
        },
        aborted: true,
        failed: false,
        kind: 'user-abort',
      };
    }
    // signal 未 abort 却抛 AbortError → 连接被抽断/代理异常，不得谎报为用户取消
    return {
      chunk: {
        type: 'error',
        category: 'connection',
        message: err instanceof Error ? err.message : String(err),
      },
      aborted: false,
      failed: true,
      kind: 'internal-abort',
    };
  }
  return {
    chunk: {
      type: 'error',
      ...(isTimeoutError(err) ? { category: 'timeout' as const } : {}),
      message: err instanceof Error ? err.message : String(err),
    },
    aborted: false,
    failed: true,
    kind: 'error',
  };
}
