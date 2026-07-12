/**
 * EvalRunner — Agent 行为评估执行器
 *
 * 职责：通过 createAgent 工厂构造测试条件 → 执行场景 →
 *   收集 AgentChunk → 评估结果 → 汇总报告
 *
 * 设计要点：
 *   - 每个场景创建独立 Agent（通过工厂函数），避免状态污染
 *   - 场景执行后 close()，避免资源泄漏
 *   - 错误隔离：单个场景失败不中断其他场景
 *   - 超时保护：scenarioTimeoutMs 防止卡死（Promise.race + AbortController）
 *
 * 内核零依赖约束：仅使用 memora 内部模块，不引入新依赖。
 */

import type { Agent } from '@/agent/agent.js';
import type { EvalScenario, EvalResult } from './evalTypes.js';
import { collectAgentChunks, evaluateResult } from './evalTypes.js';

/**
 * EvalRunner 构造选项
 */
export interface EvalRunnerOptions {
  /**
   * Agent 工厂函数（每个场景创建新 Agent）
   *
   * 工厂函数负责配置 MockProvider、guardrail 规则、预写入记忆等测试条件。
   * EvalRunner 负责调用 init() / chat() / close() 管理 Agent 生命周期。
   */
  createAgent: () => Agent;

  /**
   * 单个场景超时_ms（默认 10000）
   *
   * 超时后通过 AbortController 中断 agent.chat，
   * 返回 passed=false 的 EvalResult。
   */
  scenarioTimeoutMs?: number;
}

/**
 * 批量执行汇总报告
 */
export interface EvalSummary {
  /** 每个场景的评估结果（按执行顺序） */
  results: EvalResult[];
  /** 通过场景数 */
  passed: number;
  /** 失败场景数 */
  failed: number;
  /** 场景总数 */
  total: number;
  /** 执行总耗时_ms */
  durationMs: number;
  /** 失败场景名列表 */
  failedScenarios: string[];
}

/** 默认场景超时_ms */
const DEFAULT_SCENARIO_TIMEOUT_MS = 10_000;

/**
 * Agent 行为评估执行器
 *
 * @example
 * ```ts
 * const runner = new EvalRunner({
 *   createAgent: () => new Agent({ projectPath, provider, configDir, dataDir, ... }),
 *   scenarioTimeoutMs: 15000,
 * });
 * const summary = await runner.runScenarios(EVAL_SCENARIOS);
 * console.log(`通过 ${summary.passed}/${summary.total}，耗时 ${summary.durationMs}ms`);
 * ```
 */
export class EvalRunner {
  /** Agent 工厂函数 */
  readonly #createAgent: () => Agent;
  /** 单场景超时_ms */
  readonly #scenarioTimeoutMs: number;

  constructor(opts: EvalRunnerOptions) {
    this.#createAgent = opts.createAgent;
    this.#scenarioTimeoutMs = opts.scenarioTimeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
  }

  /**
   * 执行单个评估场景
   *
   * 流程：创建 Agent → init() → chat(input) → collectAgentChunks → evaluateResult
   *
   * 错误隔离：任何异常（超时、Agent 抛错）都返回 passed=false 的 EvalResult，
   * 不向上抛出，确保 runScenarios 批量执行时单个失败不中断其他场景。
   *
   * Agent 生命周期：每个场景执行后 close()，避免资源泄漏（try/finally 保证）。
   *
   * @param scenario 评估场景定义
   * @returns 评估结果（始终返回，不抛异常）
   */
  async runScenario(scenario: EvalScenario): Promise<EvalResult> {
    const agent = this.#createAgent();
    try {
      await agent.init();
      const collected = await this.#runWithTimeout(agent, scenario.input);
      return evaluateResult(scenario.name, collected, scenario.expect);
    } catch (err) {
      // 错误隔离：返回 passed=false 的 EvalResult，不向上抛出
      return {
        name: scenario.name,
        passed: false,
        collected: {
          toolsCalled: [],
          recallCount: 0,
          guardrailBlocked: false,
          done: false,
        },
        failures: [
          `场景执行异常：${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    } finally {
      await agent.close();
    }
  }

  /**
   * 批量执行评估场景并汇总报告
   *
   * 顺序执行（非并行），每个场景创建独立 Agent，避免状态污染。
   * 错误隔离：单个场景失败不中断其他场景（由 runScenario 保证）。
   *
   * @param scenarios 场景列表
   * @returns 汇总报告
   */
  async runScenarios(scenarios: readonly EvalScenario[]): Promise<EvalSummary> {
    const start = Date.now();
    const results: EvalResult[] = [];

    for (const scenario of scenarios) {
      const result = await this.runScenario(scenario);
      results.push(result);
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;

    return {
      results,
      passed,
      failed,
      total: results.length,
      durationMs: Date.now() - start,
      failedScenarios: results.filter((r) => !r.passed).map((r) => r.name),
    };
  }

  /**
   * 带超时执行单个场景的 chat
   *
   * 使用 Promise.race 实现超时：
   *   - 正常完成 → 返回 collected 行为数据
   *   - 超时 → reject Error（被 runScenario 的 catch 捕获）
   *
   * 超时后通过 AbortController.abort() 中断 agent.chat，
   * 避免后台 generator 无限挂起。agent.close() 在 runScenario 的 finally 中调用，
   * 确保即使超时后资源也被正确清理。
   */
  async #runWithTimeout(
    agent: Agent,
    input: string,
  ): Promise<EvalResult['collected']> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`场景超时（${this.#scenarioTimeoutMs}ms）`));
      }, this.#scenarioTimeoutMs);
    });

    const runPromise = collectAgentChunks(
      agent.chat(input, controller.signal),
    );
    // 抑制超时后 runPromise 可能产生的 unhandled rejection
    // （超时后 agent.chat 被 abort，collectAgentChunks 可能在后台 resolve/reject，
    //   但 Promise.race 已通过 timeoutPromise 返回，runPromise 的结果被丢弃）
    void runPromise.catch(() => {});

    try {
      return await Promise.race([runPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
