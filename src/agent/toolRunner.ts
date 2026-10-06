/**
 * 工具执行器（ToolRunner）— 从 AgentLoop 抽出的「单工具执行」独立单元
 *
 * 承载一个工具的完整生命周期：执行前检查（三重闸门）→ 并发/中断竞争执行 → 异常转结构化错误串。
 * 状态独立（不触碰 loop 工作记忆 / 指标 / 自主步标志），输入工具调用元素、输出结果串并触发
 * onToolExecuted，故可独立单测。loop 的 executeToolCalls 只做批量编排，逐工具委托本执行器。
 *
 * 依赖经 deps 注入（execute / preExecutionCheck / onToolExecuted / getStrategy / tracer），
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
import {
  isToolFailure,
  failedOutcome,
  okOutcome,
  blockedOutcome,
  type ToolOutcome,
  type BlockedReason,
} from '@/agent/managers/toolCallHelpers.js';

/** 工具调用元素契约（OpenAI 协议结构）——单一真源 llm/types.ToolCall（Message.toolCalls 同源） */
import type { ToolCall } from '@/llm/types.js';

/** 一次工具调用（LLM 输出的工具调用元素）——SSOT：形状真源在 llm/types.ToolCall（协议契约单一实现；re-export 保留本文件测试判据点） */
export type { ToolCall };

/** 执行前检查决策：单点聚合的多重顺序检查结果（denied 拒绝 / skip 幂等跳过 / execute 放行）。
 *  denied/skip 必带 blocked 原因（执行层闸门的「为什么挡下」，经 outcome 一并上报）。 */
type PreCheckDecision =
  | { kind: 'denied'; result: string; reason: BlockedReason }
  | { kind: 'skip'; result: string; reason: BlockedReason }
  | { kind: 'execute'; args: string };

/** 工具执行器依赖注入（loop 稳定的窄面；策略动态经 getStrategy 读取） */
export interface ToolRunnerDeps {
  /** 执行单个工具（loop 的 opts.toolExecutor）。
   *  第 3 参 emitOutcome：执行器按调用独立产出原生 outcome 的通道（见 toolExecutor.execute） */
  execute: (
    name: string,
    args: string,
    emitOutcome?: (outcome: ToolOutcome) => void,
  ) => Promise<string>;
  /** 内置工具定义（只读闸查 readonly 标记） */
  builtinTools?: ToolDefinition[];
  /** 宿主执行前检查（拒绝 / 跳过 / 改写参数） */
  preExecutionCheck?: (name: string, args: string) => PreExecutionResult;
  /** 工具执行完成回调（outbox 幂等记录是否已执行） */
  onToolExecuted?: (name: string, args: string, result: string, ok: boolean) => void;
  /** 读最新 L2 策略（toolReadonly 随 setStrategy 动态生效） */
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
   * @returns 结构化结果（`status` 为判据面唯一真源，`text` 为渲染面——B4 判据切换后
   *   编排层全部决策读 `status`，文本只喂 LLM / 渲染，不再参与成败判定）
   */
  async runOne(tc: ToolCall, signal?: AbortSignal): Promise<ToolOutcome> {
    // 工具执行 Span（并发时多个 span 时间重叠，tracer 可观测并发度）
    const span = this.deps.tracer.startSpan(TRACE_SPANS.TOOL_EXEC, {
      toolName: tc.function.name,
    });

    try {
      // 记录工具调用参数到 Span（可观测性增强：宿主可通过 span 详情看到每次工具调用的完整参数）
      span.setAttribute('args', tc.function.arguments);

      // 执行前检查：三重闸门输出三态决策（allow / skip / deny）
      const decision = this.applyPrechecks(tc);
      if (decision.kind === 'denied') {
        span.setAttribute('denied', true);
        // denied = 主动挡下（只读拒绝 / 宿主审批拒绝）⇒ blocked，原因随该闸门事实带出
        return blockedOutcome(decision.reason, decision.result);
      }
      if (decision.kind === 'skip') {
        span.setAttribute('skipped', true);
        // skip = outbox 幂等跳过（主动挡下）⇒ blocked（idempotent_skip）
        return blockedOutcome(decision.reason, decision.result);
      }

      // 每调用独立的原生 outcome 捕获器：已切族执行器在返回字符串的同点按事实产出；
      // 未切族不产出 ⇒ 走下方文本派生桥。
      let nativeOutcome: ToolOutcome | undefined;
      // raceToolWithSignal 兼容 signal 中断（每个调用独立 race，监听器无并发副作用）
      const result = await this.raceToolWithSignal(
        tc.function.name,
        decision.args,
        signal,
        (native) => {
          nativeOutcome = native;
        },
      );
      // 判据桥（SCRIPT-2 B4 后**唯一**残余文本判据）：未切族（outcome 化批次见方案 B5）
      // 的执行器只返回文本，此处按前缀约定派生 status——它不再是编排层的判据
      // （编排层只读本返回值的 status），而是「文本工具 → 结构化事实」的边界转换器，
      // 正确性由前缀契约测试 + toolFailurePrefixGuard 守卫锁定。
      const outcome =
        nativeOutcome ?? (isToolFailure(result) ? failedOutcome(result) : okOutcome(result));
      // 通知上层工具执行完成（供 outbox 幂等模式记录是否已执行）；
      // ok 判据单点 = outcome.status（与文本派生/native 产出同源，无第二次独立判断）
      this.deps.onToolExecuted?.(
        tc.function.name,
        decision.args,
        outcome.text,
        outcome.status === 'ok',
      );

      // 记录工具执行结果摘要到 Span（可观测性增强：宿主可追踪每次工具调用的结果）
      span.setAttribute('result', outcome.text.slice(0, 200));
      span.setAttribute('ok', outcome.status === 'ok');
      return outcome;
    } catch (err) {
      // 捕获异常转为结构化错误串回传 LLM 自行调整策略，避免传播中断对话
      const e = toError(err);
      span.recordException(e);
      if (err instanceof MemoraError) {
        const code = err.errorCode ?? 'UNKNOWN';
        // 失败串末尾附带 suggestions（人读的「下一步」也要进 LLM 上下文）：
        // 若建议只在 `error.format()` 给宿主 UI、LLM 只收 title+detail——首击失败后
        // LLM 收不到「使用 list_dir 查看目录结构」这类确切指令，只能凭证据自己悟（多绕一次）。
        // 证据（siblingDirHint 清单）在 detail 内，本拼接补上命令式建议，双管齐下。
        const result =
          `[ERR:TOOL:${code}] 错误：${err.title}${err.detail ? ` — ${err.detail}` : ''}` +
          (err.suggestions.length > 0 ? ` 建议：${err.suggestions.join('；')}` : '');
        logger.warn(
          { tool: tc.function.name, errorCode: code, title: err.title },
          '工具执行失败，错误已回传给 LLM',
        );
        this.deps.onToolExecuted?.(tc.function.name, tc.function.arguments, result, false);
        return failedOutcome(result);
      } else {
        const result = `[ERR:TOOL:UNKNOWN] 错误：工具执行异常 — ${e.message}`;
        logger.error({ tool: tc.function.name, err }, '工具执行异常');
        this.deps.onToolExecuted?.(tc.function.name, tc.function.arguments, result, false);
        return failedOutcome(result);
      }
    } finally {
      span.end();
    }
  }

  /**
   * 执行前检查：按顺序叠加两层闸门——只读 → 宿主 preExecutionCheck，任一命中提前返回。
   * （内核不提供"审批"闸门：无"需审批"标签与回调，审批决策统一归宿主 preExecutionCheck。）
   */
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
          // 只读模式拦截：原因独立于宿主审批（readonly_denied）
          reason: 'readonly_denied',
        };
      }
    }

    // ② 宿主 preExecutionCheck：拒绝 / 跳过 / 放行（可改写参数）
    const preCheck = this.deps.preExecutionCheck?.(name, args);
    if (preCheck?.denied) {
      const reason = preCheck.reason ?? '工具调用被拒绝';
      logger.warn({ tool: name, reason }, '工具调用被拒绝（执行前检查）');
      // PERMISSION_DENIED 不可重试，LLM 见后会调整策略而非重试
      return {
        kind: 'denied',
        result: `[ERR:TOOL:PERMISSION_DENIED] ${reason}`,
        // 宿主审批拒绝 / fail-closed：permission_denied
        reason: 'permission_denied',
      };
    }
    if (preCheck?.skip) {
      const result =
        preCheck.previousResult ?? '[SKIP:TOOL:IDEMPOTENT] 工具已执行（outbox 模式跳过）';
      logger.debug(
        { tool: name, argsSignature: args.slice(0, 80) },
        '工具已执行，跳过（仅一次语义）',
      );
      return {
        kind: 'skip',
        result,
        // outbox 幂等跳过：idempotent_skip
        reason: 'idempotent_skip',
      };
    }

    // 放行：有改写参数则用改写后的执行（审计/参数改写）
    return { kind: 'execute', args: preCheck?.overrideArgs ?? args };
  }

  /**
   * 工具执行与 signal abort 竞争包裹。toolExecutor 签名不接受 signal，无法真正中断；
   * 用 Promise.race 竞争，signal 先 abort 则返回 [ERR:TOOL:ABORTED]（而非抛 AbortError，
   * 避免破坏"工具失败回传 LLM"契约；ABORTED 不入错误码体系，不触发 Reflection）
   *
   * @param emitOutcome 原生 outcome 回调（透传给 execute；未切族忽略此参）
   */
  private async raceToolWithSignal(
    name: string,
    args: string,
    signal: AbortSignal | undefined,
    emitOutcome: (outcome: ToolOutcome) => void,
  ): Promise<string> {
    const { execute } = this.deps;
    // 无 signal 时直接执行工具（保持原行为，测试场景常用）
    if (!signal) {
      return execute(name, args, emitOutcome);
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

    // race 结束清理监听器，避免并发工具调用累积残留监听器（{ once: true } 不保证未触发时被移除）。
    // ⚠️ 注意：execute 胜出时已完成（含可能的 emitOutcome）；abort 胜出时执行仍在后台跑但结果丢弃。
    return Promise.race([execute(name, args, emitOutcome), abortPromise]).finally(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    });
  }
}
