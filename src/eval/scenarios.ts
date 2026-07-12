/**
 * Agent 行为评估场景库
 *
 * 定义标准 EvalScenario，用于 Agent 行为回归测试。
 * 场景定义是"期望契约"——描述 Agent 在特定输入下应有的行为特征，
 * 由 EvalRunner 负责构造条件（MockProvider 返回值 + guardrail 规则配置）执行验证。
 *
 * 设计原则：
 *   - 场景通用，不耦合任何领域逻辑
 *   - 每个场景聚焦一个验证维度，失败原因可定位
 *   - input 是真实用户输入风格，非人造测试桩
 *   - expect 至少定义一项检查
 *
 * 当前覆盖的 EvalExpectation 维度：
 *   - guardrailBlocked（场景 1）
 *   - toolsCalled + toolsNotCalled（场景 2）
 *   - toolCallCount（场景 3）
 *
 * 未覆盖 recallSources：当前 evaluateResult 不检查该字段（见 evalTypes.ts 注释），
 * 待 EvalRunner 实现后按需扩展。
 */

import type { EvalScenario } from './evalTypes.js';

/**
 * 最小评估场景集（3 个场景）
 *
 * 覆盖护栏阻断 / 工具调用决策 / 调用次数范围三个维度。
 * EvalRunner 实现后可在 CI 中运行这些场景作为回归基线。
 */
export const MINIMAL_EVAL_SCENARIOS: readonly EvalScenario[] = [
  {
    name: 'empty-input-guardrail',
    description: '空输入应被输入护栏阻断（需配置匹配空白输入的 guardrail 规则）',
    input: '',
    expect: {
      guardrailBlocked: true,
    },
  },
  {
    name: 'read-file-tool-call',
    description: '用户请求读取文件时，Agent 应调用 read_file 且不调用 write_file',
    input: '请读取 README.md 文件',
    expect: {
      toolsCalled: ['read_file'],
      toolsNotCalled: ['write_file'],
    },
  },
  {
    name: 'multi-tool-call-count',
    description: '复合请求应触发多个工具调用（读取文件 + 搜索记忆）',
    input: '读取项目配置并搜索相关记忆',
    expect: {
      toolCallCount: { min: 2 },
    },
  },
];
