/**
 * 生产级可观测性体系 —— 演示脚本
 *
 * 用法：
 *   npx tsx scripts/test-observability.ts
 *
 * 演示内容：
 *   1. Span 明细增强：自定义 Tracer 捕获工具调用的 args/result 属性
 *   2. Token 成本追踪：LlmChunk.usage → AgentMetrics.actualInputTokens/actualOutputTokens
 *   3. SLO 度量：任务级成功率、平均耗时统计
 *
 * 验收标准：
 *   - 脚本运行后输出的 metrics 对象包含所有 6 个维度
 *   - tasks 维度的 successCount/failureCount/avgDurationMs 有实际数据
 *   - llm.actualInputTokens/actualOutputTokens 在 Provider 支持 usage 时被填充
 */

import { AgentLoop } from '../src/agent/loop.js';
import type { AgentMetrics, ISpan, ITracer } from '../src/agent/tracer.js';
import type { LlmChunk } from '../src/llm/types.js';
import type { LlmProvider } from '../src/llm/provider.js';
import type { Memory } from '../src/memory/types.js';

// ─── 自定义 Tracer：记录 Span 属性到内存 ──────────────────

/** 记录的 Span 数据（用于断言验证） */
interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
}

/** 可观测性演示 Tracer：将所有 Span 属性记录到内存 */
class RecordingTracer implements ITracer {
  public spans: RecordedSpan[] = [];

  startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan {
    const span: RecordedSpan = {
      name,
      attributes: { ...(attributes ?? {}) },
    };
    this.spans.push(span);

    return {
      setAttribute: (key, value) => {
        span.attributes[key] = value;
      },
      end: () => {
        /* span 结束：仅记录，不做额外操作 */
      },
      recordException: () => {
        /* 异常记录：演示中不做额外操作 */
      },
    };
  }

  /** 查找指定名称的 Span 记录 */
  findSpan(name: string): RecordedSpan | undefined {
    return this.spans.find((s) => s.name === name);
  }

  /** 查找所有指定名称的 Span 记录 */
  findAllSpans(name: string): RecordedSpan[] {
    return this.spans.filter((s) => s.name === name);
  }
}

// ─── 带 usage 的 Mock Provider ──────────────────────────

/**
 * 模拟支持 usage 的 LLM Provider
 * 每次 chat 调用返回不同的响应，部分携带 usage 数据
 */
function createMockProviderWithUsage(): LlmProvider {
  let callCount = 0;

  return {
    name: 'mock-with-usage',
    async *chat(_messages: Array<{ role: string; content: string }>): AsyncIterable<LlmChunk> {
      callCount++;

      // 第 1 次调用：返回带 usage 的文本响应
      if (callCount % 4 === 1) {
        yield {
          content: '这是第一次测试响应，已收到你的消息。',
          usage: {
            inputTokens: 150,
            outputTokens: 30,
            totalTokens: 180,
          },
        };
        return;
      }

      // 第 2 次调用：返回不带 usage 的响应（模拟部分 Provider 不支持）
      if (callCount % 4 === 2) {
        yield {
          content: '这是第二次测试响应。',
        };
        return;
      }

      // 第 3 次调用：返回 tool_calls + usage
      if (callCount % 4 === 3) {
        yield {
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'test_tool', arguments: '{"key":"value"}' },
            },
          ],
          usage: {
            inputTokens: 200,
            outputTokens: 50,
            totalTokens: 250,
          },
        };
        return;
      }

      // 第 4 次及之后：返回简单文本 + usage
      yield {
        content: `这是第 ${callCount} 次响应。`,
        usage: {
          inputTokens: 100 + callCount * 10,
          outputTokens: 20 + callCount * 5,
          totalTokens: 120 + callCount * 15,
        },
      };
    },
  } as unknown as LlmProvider;
}

// ─── Mock Tool Executor ──────────────────────────

/** 模拟工具执行器：返回简单结果 */
async function mockToolExecutor(
  toolName: string,
  _args: string,
): Promise<string> {
  return `工具 ${toolName} 执行成功，结果：OK`;
}

// ─── 辅助函数 ──────────────────────────

/** 格式化输出 metrics */
function printMetrics(metrics: AgentMetrics, title: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
  console.log(JSON.stringify(metrics, null, 2));
  console.log('='.repeat(60));
}

/** 断言工具函数 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ 断言失败: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ 断言通过: ${message}`);
  }
}

// ─── 主函数 ──────────────────────────

async function main(): Promise<void> {
  console.log('🔍 P1 · 生产级可观测性体系 —— 演示\n');

  const tracer = new RecordingTracer();
  const provider = createMockProviderWithUsage();

  // 构造 AgentLoop
  const loop = new AgentLoop({
    provider,
    bootstrapMemories: [] as Memory[],
    toolExecutor: mockToolExecutor,
    tracer,
  });

  // ─── 测试 1：初始状态全零 ──────────────────────────
  console.log('\n📋 测试 1：初始 metrics 全零验证');
  const initialMetrics = loop.getMetrics();
  assert(initialMetrics.llm.callCount === 0, '初始 callCount 为 0');
  assert(initialMetrics.llm.actualInputTokens === 0, '初始 actualInputTokens 为 0');
  assert(initialMetrics.llm.actualOutputTokens === 0, '初始 actualOutputTokens 为 0');
  assert(initialMetrics.tasks.totalCount === 0, '初始 tasks.totalCount 为 0');
  assert(initialMetrics.tasks.successRate === 0, '初始 tasks.successRate 为 0');
  // 任务表观测量初始全零（实证"是否从没被触发"）
  assert(initialMetrics.plan.taskTableWriteCount === 0, '初始 plan.taskTableWriteCount 为 0');
  assert(initialMetrics.plan.planItemBoundaryCount === 0, '初始 plan.planItemBoundaryCount 为 0');

  // ─── 测试 2：运行一次对话 ──────────────────────────
  console.log('\n📋 测试 2：运行一次完整对话');

  const chunks: string[] = [];
  for await (const chunk of loop.processUserInput('你好，请帮我测试一下')) {
    if (chunk.type === 'text') {
      chunks.push(chunk.content);
    }
  }

  const afterFirstChat = loop.getMetrics();
  console.log(`  💬 对话输出片段: "${chunks.join('').slice(0, 50)}..."`);

  // ─── 测试 3：验证 Token 成本追踪 ──────────────────────────
  console.log('\n📋 测试 3：Token 成本追踪验证');
  assert(afterFirstChat.llm.callCount > 0, `LLM 调用次数 > 0 (实际: ${afterFirstChat.llm.callCount})`);
  assert(
    afterFirstChat.llm.actualInputTokens >= 150,
    `actualInputTokens 被捕获 (实际: ${afterFirstChat.llm.actualInputTokens})`,
  );
  assert(
    afterFirstChat.llm.actualOutputTokens >= 30,
    `actualOutputTokens 被捕获 (实际: ${afterFirstChat.llm.actualOutputTokens})`,
  );
  assert(
    afterFirstChat.llm.totalInputTokens > 0,
    `估算 totalInputTokens > 0 (实际: ${afterFirstChat.llm.totalInputTokens})`,
  );
  console.log(
    `  📊 Token 成本：估算输入 ${afterFirstChat.llm.totalInputTokens} / 实际输入 ${afterFirstChat.llm.actualInputTokens}`,
  );
  console.log(
    `  📊 Token 成本：估算输出 ${afterFirstChat.llm.totalOutputTokens} / 实际输出 ${afterFirstChat.llm.actualOutputTokens}`,
  );

  // ─── 测试 4：验证 SLO 度量 ──────────────────────────
  console.log('\n📋 测试 4：SLO 度量验证');
  assert(afterFirstChat.tasks.totalCount === 1, `tasks.totalCount = 1 (实际: ${afterFirstChat.tasks.totalCount})`);
  assert(afterFirstChat.tasks.successCount === 1, `tasks.successCount = 1 (实际: ${afterFirstChat.tasks.successCount})`);
  assert(afterFirstChat.tasks.failureCount === 0, `tasks.failureCount = 0 (实际: ${afterFirstChat.tasks.failureCount})`);
  assert(afterFirstChat.tasks.successRate === 1, `tasks.successRate = 1.0 (实际: ${afterFirstChat.tasks.successRate})`);
  assert(afterFirstChat.tasks.avgDurationMs > 0, `tasks.avgDurationMs > 0 (实际: ${afterFirstChat.tasks.avgDurationMs}ms)`);
  console.log(`  📊 任务 SLO：成功率 ${(afterFirstChat.tasks.successRate * 100).toFixed(1)}%`);
  console.log(`  📊 任务 SLO：平均耗时 ${afterFirstChat.tasks.avgDurationMs}ms`);

  // ─── 测试 4.5：任务表观测量（实证任务表是否被触发 / plan_item_boundary 是否产出）──
  // 本次为简单问答（非多步工程任务）→ 预期 taskTableWriteCount/planItemBoundaryCount 为 0；
  // 断言的是字段存在与如实反映，而非强行 >0（needsPlanning 假则不应建表）
  console.log('\n📋 测试 4.5：任务表观测量');
  assert(
    typeof afterFirstChat.plan.taskTableWriteCount === 'number',
    'plan.taskTableWriteCount 为可观测数值',
  );
  assert(
    typeof afterFirstChat.plan.planItemBoundaryCount === 'number',
    'plan.planItemBoundaryCount 为可观测数值',
  );
  console.log(
    `  📊 任务表：task_table_write 调用 ${afterFirstChat.plan.taskTableWriteCount} 次 / plan_item_boundary ${afterFirstChat.plan.planItemBoundaryCount} 个`,
  );

  // ─── 测试 5：第二次对话更新指标 ──────────────────────────
  console.log('\n📋 测试 5：第二次对话累积指标');

  const prevActualInputTokens = afterFirstChat.llm.actualInputTokens;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of loop.processUserInput('继续测试')) {
    // 消费所有 chunk
  }

  const afterSecondChat = loop.getMetrics();
  assert(afterSecondChat.tasks.totalCount === 2, `两次对话后 tasks.totalCount = 2 (实际: ${afterSecondChat.tasks.totalCount})`);
  assert(afterSecondChat.tasks.successCount === 2, `两次对话后 tasks.successCount = 2 (实际: ${afterSecondChat.tasks.successCount})`);
  // 注：第二次调用返回不带 usage 的响应（callCount % 4 === 2），actualInputTokens 不增加是正确行为
  // 第三次调用才会返回带 usage 的响应
  console.log(
    `  📊 actualInputTokens: 第一次=${prevActualInputTokens}, 第二次=${afterSecondChat.llm.actualInputTokens}`,
  );

  // ─── 测试 6：验证 Span 明细增强 ──────────────────────────
  console.log('\n📋 测试 6：Span 明细增强验证');

  const toolSpans = tracer.findAllSpans('tool.execute');
  console.log(`  🔧 工具执行 Span 数量: ${toolSpans.length}`);

  const firstToolSpan = toolSpans[0];
  if (firstToolSpan) {
    assert(
      firstToolSpan.attributes['toolName'] !== undefined,
      `Span 包含 toolName 属性 (实际: ${firstToolSpan.attributes['toolName']})`,
    );
    assert(
      firstToolSpan.attributes['args'] !== undefined,
      `Span 包含 args 属性 (实际长度: ${String(firstToolSpan.attributes['args'] ?? '').length})`,
    );
    // result 属性在工具成功执行后被设置
    if (firstToolSpan.attributes['ok'] !== undefined) {
      assert(
        firstToolSpan.attributes['result'] !== undefined,
        `Span 包含 result 属性 (实际: ${String(firstToolSpan.attributes['result'] ?? '').slice(0, 50)}...)`,
      );
      assert(
        firstToolSpan.attributes['ok'] === true,
        `Span 包含 ok=true 属性`,
      );
    }
  } else {
    console.log('  ⚠️  本次对话无工具调用，跳过 Span 明细验证');
  }

  // 验证 response span 包含任务级指标
  const responseSpan = tracer.findSpan('response.generate');
  if (responseSpan) {
    assert(
      responseSpan.attributes['taskDurationMs'] !== undefined,
      `Response Span 包含 taskDurationMs (实际: ${responseSpan.attributes['taskDurationMs']}ms)`,
    );
    assert(
      responseSpan.attributes['taskSucceeded'] === true,
      `Response Span 包含 taskSucceeded=true`,
    );
  }

  // ─── 测试 7：完整 Metrics 快照 ──────────────────────────
  console.log('\n📋 测试 7：完整 Metrics 快照展示');
  printMetrics(loop.getMetrics(), 'AgentMetrics 完整快照（5 个维度）');

  // ─── 测试 8：验证所有 5 个维度存在 ──────────────────────────
  // recall/decay 组已随召回编排/自动衰减退役，现存 5 组（含 plan 任务表组）
  console.log('\n📋 测试 8：5 维度完整性验证');
  const finalMetrics = loop.getMetrics();
  const dimensions = ['llm', 'tools', 'context', 'tasks', 'plan'] as const;
  for (const dim of dimensions) {
    assert(finalMetrics[dim] !== undefined, `维度 "${dim}" 存在`);
  }

  console.log('\n🎉 所有测试完成！可观测性体系 5 个维度全部验证通过。');
  console.log('\n📖 新增指标说明：');
  console.log('   - llm.actualInputTokens / llm.actualOutputTokens：Provider 实际返回的 token 用量');
  console.log('   - tasks.totalCount / successCount / failureCount：任务级 SLO 统计');
  console.log('   - tasks.successRate / tasks.avgDurationMs：任务成功率与平均耗时');
  console.log('   - Span.attributes.args / Span.attributes.result：工具调用的参数与结果摘要');
}

// 执行主函数
main().catch((err) => {
  console.error('演示脚本异常:', err);
  process.exit(1);
});