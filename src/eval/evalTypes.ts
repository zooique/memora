/**
 * Agent 行为评估类型定义
 *
 * 定义 EvalScenario 类型，用于 Agent 行为回归测试。
 * 评估验证的是 Agent 的**行为决策**（工具调用、召回来源），
 * 而非文本质量（文本质量由宿主项目用真实 LLM 评估）。
 *
 * 设计约束（详见 docs/agent-harness-增强方案-v1.0.md §3.5）：
 *   - 仅使用 Mock LLM（MSW），不发起真实 API 调用
 *   - 评估运行在 CI 中，作为测试套件的一部分
 *   - 场景定义通用，不耦合任何领域逻辑
 */

import type { AgentChunk } from '@/agent/types.js';

/**
 * 评估场景定义
 *
 * 每个场景描述一个输入 + 期望的 Agent 行为，
 * 验证召回管线、工具调用决策、护栏效果等维度。
 */
export interface EvalScenario {
  /** 场景名称（用于测试报告） */
  name: string;
  /** 场景描述 */
  description: string;
  /** 用户输入 */
  input: string;
  /** 预设的召回记忆（模拟召回结果） */
  recalledMemories?: Array<{
    name: string;
    content: string;
    source: string;
  }>;
  /**
   * 期望的行为特征
   *
   * 至少定义一项。所有检查项都通过才算场景通过。
   */
  expect: EvalExpectation;
}

/**
 * 评估期望
 *
 * 定义 Agent 应该（或不应该）表现出的行为。
 * 所有字段都是可选的——只检查有定义的字段。
 */
export interface EvalExpectation {
  /**
   * 期望的工具调用名列表
   *
   * 如果定义，Agent 在对话过程中必须至少调用这些工具。
   * 例如：['read_file', 'search_memories']
   */
  toolsCalled?: string[];

  /**
   * 不应调用的工具名列表
   *
   * 例如：不应调用 write_file 的只读场景
   */
  toolsNotCalled?: string[];

  /**
   * 期望的召回 source 分布
   *
   * 验证召回管线是否排除了应排除的 source 类型。
   * 例如：{ 'rule': 0 } 表示不应召回 rule 类型的记忆
   *
   * 注意：当前 collectAgentChunks 只收集 recallCount（数量），
   * 不收集 source 分布。此字段为未来扩展预留，当前 evaluateResult 不检查。
   * 若需验证 source 分布，请在宿主层自行实现。
   */
  recallSources?: Record<string, number>;

  /**
   * 期望的召回记忆数量范围
   *
   * 验证召回管线是否返回了预期数量的记忆。
   * 例如：{ min: 1 } 表示应至少召回 1 条记忆；
   *       { max: 0 } 表示不应召回任何记忆（空召回降级场景）。
   */
  recallCount?: { min?: number; max?: number };

  /**
   * 工具调用次数范围
   */
  toolCallCount?: { min?: number; max?: number };

  /**
   * 期望护栏是否阻断
   *
   * true 表示期望护栏触发阻断（输入或输出被 block）；
   * false 表示期望护栏不阻断；
   * undefined 表示不检查（默认）。
   *
   * 与 collected.guardrailBlocked 比对，后者通过结构化标志
   * AgentChunk.guardrailBlocked 收集，而非中文文案匹配。
   */
  guardrailBlocked?: boolean;

  /**
   * 期望对话是否正常完成
   *
   * true 表示期望对话正常完成（收到 done chunk）；
   * false 表示期望对话未正常完成（如被中断、出错）；
   * undefined 表示不检查（默认）。
   *
   * 与 collected.done 比对。
   */
  done?: boolean;
}

/**
 * 评估结果
 */
export interface EvalResult {
  /** 场景名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 收集到的 Agent 行为数据 */
  collected: {
    toolsCalled: string[];
    recallCount: number;
    guardrailBlocked: boolean;
    done: boolean;
  };
  /** 失败原因（如果未通过） */
  failures: string[];
}

/**
 * 从 AgentChunk 流中收集行为数据
 *
 * 消费 AgentLoop 的 AsyncGenerator 输出，
 * 提取工具调用名、召回数量、护栏状态等关键信息。
 *
 * @param chunks AgentChunk 异步迭代器
 * @returns 收集到的行为数据
 */
export async function collectAgentChunks(
  chunks: AsyncGenerator<AgentChunk, void, unknown>,
): Promise<EvalResult['collected']> {
  const collected: EvalResult['collected'] = {
    toolsCalled: [],
    recallCount: 0,
    guardrailBlocked: false,
    done: false,
  };

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'recall':
        // recall chunk 携带 memories 数组，count 由数组长度得出
        collected.recallCount = chunk.memories.length;
        break;
      case 'tool_start':
        if (!collected.toolsCalled.includes(chunk.name)) {
          collected.toolsCalled.push(chunk.name);
        }
        break;
      case 'text':
        // 通过结构化标志判断护栏阻断（替代中文文案子串匹配）
        // AgentChunk.text.guardrailBlocked 由 AgentLoop 在护栏 block 时显式置 true
        if (chunk.guardrailBlocked) {
          collected.guardrailBlocked = true;
        }
        break;
      case 'done':
        collected.done = true;
        break;
    }
  }

  return collected;
}

/**
 * 将收集到的行为数据与期望进行比对
 *
 * @param name 场景名称
 * @param collected 收集到的行为数据
 * @param expect 期望的行为特征
 * @returns 评估结果
 */
export function evaluateResult(
  name: string,
  collected: EvalResult['collected'],
  expect: EvalExpectation,
): EvalResult {
  const failures: string[] = [];

  // 检查工具调用
  if (expect.toolsCalled) {
    for (const tool of expect.toolsCalled) {
      if (!collected.toolsCalled.includes(tool)) {
        failures.push(`期望调用工具 "${tool}"，但未调用（已调用：${collected.toolsCalled.join(', ') || '无'}）`);
      }
    }
  }

  // 检查不应调用的工具
  if (expect.toolsNotCalled) {
    for (const tool of expect.toolsNotCalled) {
      if (collected.toolsCalled.includes(tool)) {
        failures.push(`不应调用工具 "${tool}"，但实际调用了`);
      }
    }
  }

  // 检查工具调用次数
  if (expect.toolCallCount) {
    const count = collected.toolsCalled.length;
    if (expect.toolCallCount.min !== undefined && count < expect.toolCallCount.min) {
      failures.push(`工具调用次数 ${count} < 期望最小值 ${expect.toolCallCount.min}`);
    }
    if (expect.toolCallCount.max !== undefined && count > expect.toolCallCount.max) {
      failures.push(`工具调用次数 ${count} > 期望最大值 ${expect.toolCallCount.max}`);
    }
  }

  // 检查召回数量
  if (expect.recallCount) {
    if (expect.recallCount.min !== undefined && collected.recallCount < expect.recallCount.min) {
      failures.push(`召回数量 ${collected.recallCount} < 期望最小值 ${expect.recallCount.min}`);
    }
    if (expect.recallCount.max !== undefined && collected.recallCount > expect.recallCount.max) {
      failures.push(`召回数量 ${collected.recallCount} > 期望最大值 ${expect.recallCount.max}`);
    }
  }

  // 检查护栏阻断
  if (expect.guardrailBlocked !== undefined) {
    if (expect.guardrailBlocked !== collected.guardrailBlocked) {
      failures.push(
        `期望护栏阻断=${expect.guardrailBlocked}，实际=${collected.guardrailBlocked}`,
      );
    }
  }

  // 检查完成状态
  if (expect.done !== undefined) {
    if (expect.done !== collected.done) {
      failures.push(`期望完成状态=${expect.done}，实际=${collected.done}`);
    }
  }

  return {
    name,
    passed: failures.length === 0,
    collected,
    failures,
  };
}