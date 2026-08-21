/**
 * 工具执行器（ToolRunner）— 从 AgentLoop 抽出的「单工具执行」独立单元
 *
 * 承载一个工具的完整生命周期：执行前检查（三重闸门）→ 并发/中断竞争执行 → 异常转结构化错误串。
 * 状态独立（不触碰 loop 工作记忆 / 指标 / 自主步标志），输入工具调用元素、输出结果串并触发
 * onToolExecuted，故可独立单测。loop 的 executeToolCalls 只做批量编排，逐工具委托本执行器。
 *
 * 依赖经 deps 注入（execute / preExecutionCheck / onToolExecuted / onToolApproval / getStrategy / tracer），
 * 其中 getStrategy 每次执行读最新策略——setStrategy 的动态更新在此依然生效。
 */

import type { PreExecutionResult } from '@/agent/types.js';
import type { ToolDefinition } from '@/agent/toolExecutor.js';
import type { L2RuntimeStrategy } from '@/role-pack/types.js';
import type { ITracer } from '@/agent/tracer.js';
import { TRACE_SPANS } from '@/agent/tracer.js';
import { MemoraError } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { logger } from '@/logging/logger.js';

/** 一次工具调用（LLM 输出的工具调用元素；与 Message.toolCalls 元素同构） */
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/** 执行前检查决策：单点聚合的多重顺序检查结果（denied 拒绝 / skip 幂等跳过 / execute 放行） */
type PreCheckDecision =
  | { kind: 'denied'; result: string }
  | { kind: 'skip'; result: string }
  | { kind: 'execute'; args: string };

/** ToolRunner 依赖注入（loop 稳定的窄面；策略动态经 getStrategy 读取） */
export interface ToolRunnerDeps {
  /** 执行单个工具（loop 的 opts.toolExecutor） */
  execute: (name: string, args: string) => Promise<string>;
  /** 内置工具定义（只读闸查 readonly 标记） */
  builtinTools?: ToolDefinition[];
  /** 宿主执行前检查（拒绝 / 跳过 / 改写参数） */
  preExecutionCheck?: (name: string, args: string) => PreExecutionResult;
  /** 工具执行完成回调（outbox 幂等记录是否已执行） */
  onToolExecuted?: (name: string, args: string, result: string, ok: boolean) => void;
  /** 审批回调（toolApproval=confirm 时触发） */
  onToolApproval?: (info: { toolName: string; args: string }) => void;
  /** 读最新 L2 策略（toolReadonly / toolApproval 随 setStrategy 动态生效） */
  getStrategy: () => L2RuntimeStrategy;
  /** 可观测性 Tracer */
  tracer: ITracer;
}

/**
 * 工具执行器：单工具执行单元（异常捕获转结构化错误串回传 LLM，不中断对话）。
 */
export class ToolRunner {
  constructor(private readonly deps: ToolRunnerDeps) {}

  /**
   * 执行单个工具（并行独立执行单元，无共享状态，可安全并发）。
   * @param tc 工具调用元素
   * @param signal 中止信号（与工具执行 race，signal 先 abort 返回 ABORTED 错误串）
   * @returns 执行结果串（成功文本或 [ERR:TOOL:code] 错误串）
   */
  async runOne(tc: ToolCall, signal?: AbortSignal): Promise<string> {
    // 工具执行 Span（并发时多个 span 时间重叠，tracer 可观测并发度）
    const span = this.deps.tracer.startSpan(TRACE_SPANS.TOOL_EXEC, {
      toolName: tc.function.name,
    });

    try {
      // 执行前检查：三重闸门输出三态决策（allow / skip / deny）
      const decision = this.applyPrechecks(tc);
      if (decision.kind === 'denied') {
        span.setAttribute('denied', true);
        return decision.result;
      }
      if (decision.kind === 'skip') {
        span.setAttribute('skipped', true);
        return decision.result;
      }

      // raceToolWithSignal 兼容 signal 中断（每个调用独立 race，监听器无并发副作用）
      const result = await this.raceToolWithSignal(tc.function.name, decision.args, signal);
      // 通知上层工具执行完成（供 outbox 幂等模式记录是否已执行）
      const ok = !result.startsWith('[ERR');
      this.deps.onToolExecuted?.(tc.function.name, decision.args, result, ok);
      return result;
    } catch (err) {
      // 捕获异常转为结构化错误串回传 LLM 自行调整策略，避免传播中断对话
      const e = toError(err);
      span.recordException(e);
      if (err instanceof MemoraError) {
        const code = err.errorCode ?? 'UNKNOWN';
        const result = `[ERR:TOOL:${code}] 错误：${err.title}${err.detail ? ` — ${err.detail}` : ''}`;
        logger.warn(
          { tool: tc.function.name, errorCode: code, title: err.title },
          '工具执行失败，错误已回传给 LLM',
        );
        this.deps.onToolExecuted?.(tc.function.name, tc.function.arguments, result, false);
        return result;
      } else {
        const result = `[ERR:TOOL:UNKNOWN] 错误：工具执行异常 — ${e.message}`;
        logger.error({ tool: tc.function.name, err }, '工具执行异常');
        this.deps.onToolExecuted?.(tc.function.name, tc.function.arguments, result, false);
        return result;
      }
    } finally {
      span.end();
    }
  }

  /** 执行前检查：按顺序叠加只读 → 审批 → 宿主 preExecutionCheck 三重闸门，任一命中提前返回 */
  private applyPrechecks(tc: ToolCall): PreCheckDecision {
    const name = tc.function.name;
    const args = tc.function.arguments;
    const strategy = this.deps.getStrategy();

    // ① 只读闸：toolReadonly='readonly' 阻止非只读工具
    if (strategy.toolReadonly === 'readonly') {
      const toolDef = this.deps.builtinTools?.find((t) => t.name === name);
      if (toolDef && !toolDef.readonly) {
        logger.warn({ tool: name }, '工具只读模式：阻止写入工具执行');
        return {
          kind: 'denied',
          result: `[ERR:TOOL:READONLY_DENIED] 工具 "${name}" 是写入操作，在只读模式下不可用`,
        };
      }
    }

    // ② 审批闸：toolApproval='confirm' 触发审批回调（仅通知宿主征询，不阻塞放行）。
    // 职责边界：onToolApproval 只"通知"宿主有 toolApproval=confirm 的高风险调用，不承担放行/拒绝决策；
    // 真正的决策闸是③ preExecutionCheck（宿主返回 denied 即拒绝）。宿主须在 preExecutionCheck 做 confirm
    // 拦截，勿期待 onToolApproval 的返回能阻止执行（它无返回值，回调后仍继续到③）。
    if (strategy.toolApproval === 'confirm') {
      this.deps.onToolApproval?.({ toolName: name, args });
    }

    // ③ 宿主 preExecutionCheck：拒绝 / 跳过 / 放行（可改写参数）
    const preCheck = this.deps.preExecutionCheck?.(name, args);
    if (preCheck?.denied) {
      const reason = preCheck.reason ?? '工具调用被拒绝';
      logger.warn({ tool: name, reason }, '工具调用被拒绝（执行前检查）');
      // PERMISSION_DENIED 不可重试，LLM 见后会调整策略而非重试
      return { kind: 'denied', result: `[ERR:TOOL:PERMISSION_DENIED] ${reason}` };
    }
    if (preCheck?.skip) {
      const result =
        preCheck.previousResult ?? '[SKIP:TOOL:IDEMPOTENT] 工具已执行（outbox 模式跳过）';
      logger.debug(
        { tool: name, argsSignature: args.slice(0, 80) },
        '工具已执行，跳过（仅一次语义）',
      );
      return { kind: 'skip', result };
    }

    // 放行：有改写参数则用改写后的执行（审计/参数改写）
    return { kind: 'execute', args: preCheck?.overrideArgs ?? args };
  }

  /**
   * 工具执行与 signal abort 竞争包裹。toolExecutor 签名不接受 signal，无法真正中断；
   * 用 Promise.race 竞争，signal 先 abort 则返回 [ERR:TOOL:ABORTED]（而非抛 AbortError，
   * 避免破坏"工具失败回传 LLM"契约；ABORTED 不入错误码体系，不触发 Reflection）
   */
  private async raceToolWithSignal(
    name: string,
    args: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const { execute } = this.deps;
    // 无 signal 时直接执行工具（保持原行为，测试场景常用）
    if (!signal) {
      return execute(name, args);
    }

    // signal 已 abort：直接返回中断错误，不发起工具调用
    if (signal.aborted) {
      return '[ERR:TOOL:ABORTED] 错误：工具执行被中断';
    }

    // abort 监听 Promise（signal abort 时 resolve 错误串）；onAbort 提外层便于 race 后清理
    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<string>((resolve) => {
      onAbort = () => resolve('[ERR:TOOL:ABORTED] 错误：工具执行被中断');
      signal.addEventListener('abort', onAbort, { once: true });
    });

    // race 结束清理监听器，避免并发工具调用累积残留监听器（{ once: true } 不保证未触发时被移除）
    return Promise.race([execute(name, args), abortPromise]).finally(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    });
  }
}
