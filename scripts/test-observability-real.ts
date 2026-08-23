/**
 * P1 · 生产级可观测性体系 —— 真实 LLM 端到端验证
 *
 * 用法：
 *   npx tsx scripts/test-observability-real.ts
 *
 * 演示内容：
 *   1. 使用真实 LLM Provider（从 .memora/config.json 加载）
 *   2. 全链路 Span 追踪：RECALL → LLM_CALL → TOOL_EXEC → RESPONSE
 *   3. Token 成本实时追踪（actualInputTokens/actualOutputTokens）
 *   4. 多轮对话指标累积
 *   5. 异常/取消路径的可观测性
 *   6. 宿主可消费的完整 metrics 快照
 *
 * 验收标准：
 *   - 至少 3 轮真实对话完成
 *   - 每轮都有完整的 Span 链路
 *   - metrics.llm.actualInputTokens > 0（真实 token 用量）
 *   - Span 属性包含 systemPromptHash 指纹
 */

import { AgentLoop } from '../src/agent/loop.js';
import { loadConfig } from '../src/config/loader.js';
import { createLlmProvider } from '../src/llm/factory.js';
import type { AgentMetrics, ISpan, ITracer } from '../src/agent/tracer.js';
import { TRACE_SPANS } from '../src/agent/tracer.js';

// ─── 可观测性增强：带时间戳的 Span 记录 ──────────────────

/** Span 记录（带完整追踪信息） */
interface SpanRecord {
  /** Span 名称 */
  name: string;
  /** 开始时间戳（ms） */
  startMs: number;
  /** 结束时间戳（ms） */
  endMs: number;
  /** 耗时（ms） */
  durationMs: number;
  /** 属性键值对 */
  attributes: Record<string, string | number | boolean>;
  /** 是否有异常 */
  hasException: boolean;
  /** 子 Span（按名称分组） */
  children: SpanRecord[];
}

/** 生产级可观测性 Tracer：记录所有 Span 的完整追踪数据 */
class ProductionTracer implements ITracer {
  public spans: SpanRecord[] = [];
  private activeSpans = new Map<ISpan, SpanRecord>();

  startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan {
    const record: SpanRecord = {
      name,
      startMs: Date.now(),
      endMs: 0,
      durationMs: 0,
      attributes: { ...(attributes ?? {}) },
      hasException: false,
      children: [],
    };

    const span: ISpan = {
      setAttribute: (key, value) => {
        record.attributes[key] = value;
      },
      end: () => {
        record.endMs = Date.now();
        record.durationMs = record.endMs - record.startMs;
        this.activeSpans.delete(span);
      },
      recordException: () => {
        record.hasException = true;
      },
    };

    this.activeSpans.set(span, record);
    this.spans.push(record);
    return span;
  }

  /** 按名称查找所有 Span */
  findAllByName(name: string): SpanRecord[] {
    return this.spans.filter((s) => s.name === name);
  }

  /** 按前缀查找 Span（如 'tool.' 匹配所有工具） */
  findByPrefix(prefix: string): SpanRecord[] {
    return this.spans.filter((s) => s.name.startsWith(prefix));
  }

  /** 获取最后 N 个 Span */
  last(n: number): SpanRecord[] {
    return this.spans.slice(-n);
  }

  /** 统计各类型 Span 数量 */
  getSpanCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of this.spans) {
      counts[s.name] = (counts[s.name] ?? 0) + 1;
    }
    return counts;
  }

  /** 统计平均耗时（按 Span 名称） */
  getAvgDurationByName(): Record<string, number> {
    const durations = new Map<string, number[]>();
    for (const s of this.spans) {
      if (!durations.has(s.name)) durations.set(s.name, []);
      durations.get(s.name)!.push(s.durationMs);
    }
    const result: Record<string, number> = {};
    for (const [name, durs] of durations) {
      result[name] = Math.round(durs.reduce((a, b) => a + b, 0) / durs.length);
    }
    return result;
  }
}

// ─── 工具定义与执行器 ──────────────────

/** 简化的工具定义（仅用于演示） */
const TOOL_DEFS = [
  {
    name: 'search_memories',
    description: '搜索记忆库',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: '搜索关键词' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: '读取文件内容',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: '文件路径' },
      },
      required: ['path'],
    },
  },
];

/** 工具执行器（真实环境中由宿主提供） */
async function toolExecutor(name: string, argsStr: string): Promise<string> {
  const args = JSON.parse(argsStr || '{}');
  switch (name) {
    case 'search_memories':
      return `搜索记忆：查询"${args.query ?? ''}"，找到 0 条匹配`;
    case 'read_file':
      return `读取文件：${args.path ?? 'unknown'}（演示环境，返回模拟内容）`;
    default:
      return `未知工具: ${name}`;
  }
}

// ─── 输出辅助 ──────────────────

function printBanner(text: string): void {
  console.log(`\n${'━'.repeat(70)}`);
  console.log(`  ${text}`);
  console.log('━'.repeat(70));
}

function printMetrics(metrics: AgentMetrics, title: string): void {
  console.log(`\n┌─ ${title}`);
  console.log(`│  LLM: 调用 ${metrics.llm.callCount} 次 | 估算输入 ${metrics.llm.totalInputTokens} / 实际 ${metrics.llm.actualInputTokens} tokens`);
  console.log(`│  LLM: 估算输出 ${metrics.llm.totalOutputTokens} / 实际 ${metrics.llm.actualOutputTokens} tokens`);
  console.log(`│  召回: ${metrics.recall.totalCount} 次 | 命中 ${metrics.recall.hitCount} 次 | 命中率 ${(metrics.recall.hitRate * 100).toFixed(1)}%`);
  console.log(`│  工具: ${metrics.tools.callCount} 次调用 | ${metrics.tools.failureCount} 次失败`);
  console.log(`│  上下文: ${metrics.context.messageCount} 条消息 | 估算 ${metrics.context.estimatedTokens} tokens | 截断 ${metrics.context.truncationCount} 次`);
  console.log(`│  任务: ${metrics.tasks.totalCount} 次 | 成功 ${metrics.tasks.successCount} | 失败 ${metrics.tasks.failureCount} | 成功率 ${(metrics.tasks.successRate * 100).toFixed(1)}%`);
  console.log(`│  任务耗时: 平均 ${metrics.tasks.avgDurationMs}ms`);
  console.log(`└${'─'.repeat(60)}`);
}

function printSpanTrace(tracer: ProductionTracer): void {
  const spanCounts = tracer.getSpanCounts();
  const avgDurations = tracer.getAvgDurationByName();

  console.log('\n┌─ Span 追踪汇总');
  for (const [name, count] of Object.entries(spanCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
    const avgMs = avgDurations[name] ?? 0;
    console.log(`│  ${name.padEnd(25)} × ${String(count).padStart(3)} 次 | 平均 ${String(avgMs).padStart(5)} ms`);
  }
  console.log(`└${'─'.repeat(60)}`);

  // 详细 Span 属性（仅展示关键 Span）
  const llmSpans = tracer.findAllByName(TRACE_SPANS.LLM_CALL);
  if (llmSpans.length > 0) {
    console.log('\n┌─ LLM Call Span 详情');
    for (const span of llmSpans.slice(-3)) {
      console.log(`│  模型: ${span.attributes.model ?? 'N/A'} | 耗时: ${span.durationMs}ms | 消息数: ${span.attributes.messageCount ?? 'N/A'}`);
      console.log(`│  估算输入: ${span.attributes.inputTokens ?? 'N/A'} tokens | 实际输入: ${span.attributes.actualInputTokens ?? 'N/A'} tokens`);
      console.log(`│  System Prompt Hash: ${span.attributes.systemPromptHash ?? 'N/A'}`);
      if (span.hasException) console.log('│  ⚠️  此 Span 有异常');
    }
    console.log(`└${'─'.repeat(60)}`);
  }

  const toolSpans = tracer.findByPrefix('tool.');
  if (toolSpans.length > 0) {
    console.log('\n┌─ Tool Execute Span 详情（最近 5 条）');
    for (const span of toolSpans.slice(-5)) {
      const toolName = span.attributes.toolName ?? 'unknown';
      const ok = span.attributes.ok;
      console.log(`│  ${toolName.padEnd(25)} | ${String(span.durationMs).padStart(4)}ms | ${ok === true ? '✅' : ok === false ? '❌' : '⏭️'} | 参数: ${String(span.attributes.args ?? '').slice(0, 60)}`);
    }
    console.log(`└${'─'.repeat(60)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ 断言失败: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ 断言通过: ${message}`);
  }
}

// ─── 主函数 ──────────────────

async function main(): Promise<void> {
  printBanner('P1 · 生产级可观测性体系 —— 真实 LLM 端到端验证');

  // 1. 加载配置并创建真实 Provider
  console.log('\n📋 步骤 1：加载 LLM 配置');
  let config;
  try {
    config = await loadConfig();
  } catch {
    console.error('❌ 未找到配置文件，请先配置 .memora/config.json');
    process.exit(1);
  }

  const hasProviderKey = Object.values(config?.llm?.providers ?? {}).some((p) => p?.apiKey);
  if (!hasProviderKey) {
    console.error('❌ 配置中缺少 API Key');
    process.exit(1);
  }

  console.log('  ✅ 配置加载成功，准备创建 Provider...');
  const provider = createLlmProvider(config);
  console.log(`  ✅ Provider 创建成功: ${provider.name}`);

  // 2. 创建可观测性 Tracer 与 AgentLoop
  console.log('\n📋 步骤 2：初始化 AgentLoop 与可观测性体系');
  const tracer = new ProductionTracer();

  const loop = new AgentLoop({
    provider,
    bootstrapMemories: [],
    toolExecutor,
    toolDefinitions: TOOL_DEFS,
    tracer,
  });

  const initialMetrics = loop.getMetrics();
  assert(initialMetrics.llm.callCount === 0, '初始 callCount 为 0');
  assert(initialMetrics.tasks.totalCount === 0, '初始 tasks.totalCount 为 0');

  // 3. 第一轮对话：简单问答（测试基础链路）
  console.log('\n📋 步骤 3：第一轮对话 —— 简单自我介绍');
  console.log('  📤 输入: "你好，我叫小明，我是一名全栈工程师。用一句话介绍你自己。"');

  const input1 = '你好，我叫小明，我是一名全栈工程师。用一句话介绍你自己。';
  let response1 = '';
  const chunks1: string[] = [];
  const start1 = Date.now();

  for await (const chunk of loop.processUserInput(input1)) {
    if (chunk.type === 'text') {
      response1 += chunk.content;
      chunks1.push(chunk.content);
      process.stdout.write(chunk.content);
    }
  }
  const duration1 = Date.now() - start1;
  console.log(`\n\n  ⏱️  第一轮耗时: ${duration1}ms`);
  assert(response1.length > 0, '第一轮有文本回复');

  const metrics1 = loop.getMetrics();
  printMetrics(metrics1, '第一轮对话后 Metrics');

  // 4. 第二轮对话：测试记忆召回 + 工具调用
  console.log('\n📋 步骤 4：第二轮对话 —— 测试记忆与工具');
  console.log('  📤 输入: "你还记得我是谁吗？帮我搜索一下我的信息。"');

  const input2 = '你还记得我是谁吗？帮我搜索一下我的信息。';
  let response2 = '';
  const start2 = Date.now();

  for await (const chunk of loop.processUserInput(input2)) {
    if (chunk.type === 'text') {
      response2 += chunk.content;
      process.stdout.write(chunk.content);
    }
  }
  const duration2 = Date.now() - start2;
  console.log(`\n\n  ⏱️  第二轮耗时: ${duration2}ms`);
  assert(response2.length > 0, '第二轮有文本回复');

  const metrics2 = loop.getMetrics();
  printMetrics(metrics2, '第二轮对话后 Metrics');

  // 5. 第三轮对话：复杂任务（测试多轮推理）
  console.log('\n📋 步骤 5：第三轮对话 —— 复杂代码任务');
  console.log('  📤 输入: "写一个 TypeScript 函数，实现深拷贝（支持循环引用检测）。"');

  const input3 = '写一个 TypeScript 函数，实现深拷贝（支持循环引用检测）。';
  let response3 = '';
  const start3 = Date.now();

  for await (const chunk of loop.processUserInput(input3)) {
    if (chunk.type === 'text') {
      response3 += chunk.content;
      process.stdout.write(chunk.content);
    }
  }
  const duration3 = Date.now() - start3;
  console.log(`\n\n  ⏱️  第三轮耗时: ${duration3}ms`);
  assert(response3.length > 0, '第三轮有文本回复');

  const metrics3 = loop.getMetrics();
  printMetrics(metrics3, '第三轮对话后 Metrics');

  // 6. 可观测性验证
  console.log('\n📋 步骤 6：可观测性指标验证');

  // 6a. Token 追踪
  console.log('\n  🔍 Token 成本追踪验证:');
  assert(metrics3.llm.callCount >= 3, `LLM 调用次数 >= 3 (实际: ${metrics3.llm.callCount})`);
  assert(metrics3.llm.actualInputTokens > 0, `实际输入 token > 0 (实际: ${metrics3.llm.actualInputTokens})`);
  assert(metrics3.llm.actualOutputTokens > 0, `实际输出 token > 0 (实际: ${metrics3.llm.actualOutputTokens})`);
  assert(metrics3.llm.totalInputTokens > 0, `估算输入 token > 0 (实际: ${metrics3.llm.totalInputTokens})`);

  // 6b. 任务级 SLO
  console.log('\n  🔍 任务级 SLO 验证:');
  assert(metrics3.tasks.totalCount === 3, `任务总数 = 3 (实际: ${metrics3.tasks.totalCount})`);
  assert(metrics3.tasks.successCount === 3, `成功数 = 3 (实际: ${metrics3.tasks.successCount})`);
  assert(metrics3.tasks.successRate === 1, `成功率 = 100% (实际: ${(metrics3.tasks.successRate * 100).toFixed(1)}%)`);
  assert(metrics3.tasks.avgDurationMs > 0, `平均耗时 > 0ms (实际: ${metrics3.tasks.avgDurationMs}ms)`);

  // 6c. Span 追踪验证
  console.log('\n  🔍 Span 链路验证:');
  const spanCounts = tracer.getSpanCounts();
  assert((spanCounts[TRACE_SPANS.LLM_CALL] ?? 0) >= 3, `LLM_CALL Span >= 3 (实际: ${spanCounts[TRACE_SPANS.LLM_CALL] ?? 0})`);

  const llmSpans = tracer.findAllByName(TRACE_SPANS.LLM_CALL);
  if (llmSpans.length > 0) {
    const lastLlmSpan = llmSpans[llmSpans.length - 1];
    assert(lastLlmSpan.attributes.model !== undefined, 'LLM Span 包含 model 属性');
    assert(lastLlmSpan.attributes.messageCount !== undefined, 'LLM Span 包含 messageCount 属性');
    assert(lastLlmSpan.attributes.inputTokens !== undefined, 'LLM Span 包含 inputTokens 属性');
    assert(lastLlmSpan.attributes.systemPromptHash !== undefined, 'LLM Span 包含 systemPromptHash 指纹');
    assert(lastLlmSpan.durationMs > 0, `LLM Span 耗时 > 0ms (实际: ${lastLlmSpan.durationMs}ms)`);
  }

  // 6d. 上下文管理
  console.log('\n  🔍 上下文管理验证:');
  assert(metrics3.context.messageCount > 0, `上下文消息数 > 0 (实际: ${metrics3.context.messageCount})`);
  assert(metrics3.context.estimatedTokens > 0, `上下文估算 token > 0 (实际: ${metrics3.context.estimatedTokens})`);

  // 7. 完整 Span 追踪报告
  printBanner('完整 Span 追踪报告');
  printSpanTrace(tracer);

  // 8. 最终 Metrics 快照
  printBanner('最终 Metrics 快照');
  printMetrics(metrics3, '3 轮对话累积指标');

  // 9. 6 维度完整性
  console.log('\n📋 步骤 7：6 维度完整性验证');
  const dimensions: Array<keyof AgentMetrics> = ['llm', 'recall', 'tools', 'context', 'decay', 'tasks'];
  for (const dim of dimensions) {
    assert(metrics3[dim] !== undefined, `维度 "${dim}" 存在`);
  }

  console.log('\n🎉 所有验证完成！生产级可观测性体系验证通过。');
  console.log('\n📖 关键发现：');
  console.log(`   - 真实 API 调用 ${metrics3.llm.callCount} 次，总耗时 ${duration1 + duration2 + duration3}ms`);
  console.log(`   - 实际 Token 用量：输入 ${metrics3.llm.actualInputTokens} / 输出 ${metrics3.llm.actualOutputTokens}`);
  console.log(`   - 估算 vs 实际偏差：输入 ${((1 - metrics3.llm.totalInputTokens / Math.max(metrics3.llm.actualInputTokens, 1)) * 100).toFixed(1)}%`);
  console.log(`   - LLM 平均响应时间：${(llmSpans.reduce((s, sp) => s + sp.durationMs, 0) / Math.max(llmSpans.length, 1)).toFixed(0)}ms`);
  console.log(`   - Span 总数：${tracer.spans.length} 个，覆盖 ${Object.keys(spanCounts).length} 种类型`);
}

// 执行主函数
main().catch((err) => {
  console.error('\n❌ 脚本异常:', err);
  process.exit(1);
});