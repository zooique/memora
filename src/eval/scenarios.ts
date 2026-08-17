/**
 * Agent 行为评估场景库
 *
 * 定义标准 EvalScenario，用于 Agent 行为回归测试。
 * 场景定义是"期望契约"——描述 Agent 在特定输入下应有的行为特征，
 * 由 EvalRunner 负责构造条件（MockProvider 返回值 + 预写入记忆）执行验证。
 *
 * 设计原则：
 *   - 场景通用，不耦合任何领域逻辑
 *   - 每个场景聚焦一个验证维度，失败原因可定位
 *   - input 是真实用户输入风格，非人造测试桩
 *   - expect 至少定义一项检查
 *
 * 当前覆盖的 EvalExpectation 维度（7 个场景）：
 *   - toolsCalled + toolsNotCalled（场景 1, 4）
 *   - toolCallCount（场景 2）
 *   - recallCount（场景 3, 7）
 *   - done（场景 5, 6, 7）
 *   - recalledMemories 预设（场景 3）
 *
 * 未覆盖 recallSources：当前 evaluateResult 不检查该字段（见 evalTypes.ts 注释），
 * 待宿主层按需扩展。
 */

import type { EvalScenario } from './evalTypes.js';

/**
 * 评估场景集（7 个场景）
 *
 * 覆盖工具调用决策 / 调用次数范围 / 召回数量 / 完成状态 / 长输入处理五个维度。
 * EvalRunner 实现后可在 CI 中运行这些场景作为回归基线。
 */
export const EVAL_SCENARIOS: readonly EvalScenario[] = [
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
  {
    name: 'recall-memory-present',
    description: '用户提问时应有记忆召回（需预写入匹配记忆到存储）',
    input: '根据之前的记忆，帮我回忆上次讨论的架构设计内容',
    recalledMemories: [
      {
        name: '架构设计讨论',
        content: '上次讨论了分层架构和模块解耦方案',
        source: 'round-summary',
      },
    ],
    expect: {
      recallCount: { min: 1 },
    },
  },
  {
    name: 'readonly-query',
    description: '只读查询场景不应调用 write_file（防止误写）',
    input: '查询当前项目的目录结构，列出所有文件',
    expect: {
      toolsNotCalled: ['write_file'],
    },
  },
  {
    name: 'normal-completion',
    description: '正常对话应正常完成（收到 done 事件）',
    input: '你好，请介绍一下自己',
    expect: {
      done: true,
    },
  },
  {
    name: 'long-input-handling',
    description: '较长输入应被正常处理（不触发长度限制，不崩溃，正常完成）',
    input:
      '请分析以下需求文档的可行性并给出技术方案建议：\n' +
      '系统需要支持高并发、低延迟的实时数据处理，同时保证数据一致性。'.repeat(200),
    expect: {
      done: true,
    },
  },
  {
    name: 'empty-recall-degrade',
    description: '无匹配记忆时不应崩溃，正常完成对话（空召回降级）',
    input: 'asdfqwerty 无意义输入不匹配任何记忆',
    expect: {
      recallCount: { max: 0 },
      done: true,
    },
  },
];
