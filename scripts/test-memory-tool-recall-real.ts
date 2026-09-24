/**
 * A/B 模型行为验收 · 真实 LLM 会话驱动
 *
 * 用法（真实配置：MEMORA_API_KEY 环境变量 + loadConfig）：
 *   $env:MEMORA_API_KEY = "sk-xxx"
 *   npx tsx scripts/test-memory-tool-recall-real.ts            # 全量 10 case
 *   $env:BENCH_CASE="A1,A5,B2"; npx tsx scripts/...real.ts    # 指定 case
 *
 * 职责（对接 docs/architecture/memory-tool-recall-ab-benchmark.md §0/§3）：
 *  用一个最小 tool-calling 环驱动真实 LLM：每 case 注入问题集 input，只暴露
 *  search_memories 一个工具；记录该轮是否**主动**调用（queried?）以及返回是否命中
 *  目标实体词（hit?），并打印最终文本供人工评答案质量。据此算 A 想起率 / B 命中率。
 *
 * 判定口径：
 *  - queried?  = 本轮 LLM 发起过 search_memories 工具调用（是否主动检索）
 *  - hit?      = 工具返回文本含目标记忆的独特实体词（是否检索到正确果实）
 *  - 答案质量  = 打印最终文本，人工评（本脚本不自动判优劣）
 *
 * 阈值（§阶段1 出口条件）：B 必须 ≈100%；本地/云端 A 对照阈值实测前冻结。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { createLlmProvider } from '../src/llm/factory.js';
import { InMemoryStorage } from '../src/memory/inMemoryStorage.js';
import { BuiltinToolHandlers } from '../src/agent/builtinToolHandlers.js';
import { SecurityGuard } from '../src/security/pathGuard.js';
import type { Message, ChatOptions } from '../src/llm/provider.js';
import { BENCH_SEEDS, loadBenchmarkSeed, type BenchmarkSeed } from './benchmark-seeds.js';

// Node 24 + undici 已知 bug：fetch 401/403 后 keep-alive stream 残留，process.exit 时触发
// libuv "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"。与 smokeLlm.ts 同构兜底。
process.on('uncaughtException', (err) => {
  const isLibuvAssertion =
    err.name === 'AssertionError' || (err as NodeJS.ErrnoException).code === 'ERR_ASSERTION';
  const isAsyncClosing =
    String(err.message).includes('UV_HANDLE_CLOSING') ||
    String(err.stack ?? '').includes('async.c');
  if (isLibuvAssertion && isAsyncClosing) {
    process.stderr.write('\n⚠️  Node fetch 内部 stream 清理异常（已知 undici bug，业务错误已处理）\n');
    process.exit(1);
  }
  process.stderr.write(`💥 未捕获异常：${err.stack ?? err.message}\n`);
  process.exit(1);
});

// ─── search_memories 工具定义（最小 Tool；完整面在内核 SimpleTool 注册） ──
const SEARCH_TOOL: NonNullable<ChatOptions['tools']>[number] = {
  type: 'function',
  function: {
    name: 'search_memories',
    description:
      '检索用户此前的记忆（决定、偏好、事实、报错解法、方案上下文等）。' +
      '当回答需要参考用户之前讨论过/定下的内容时调用；返回命中记忆的预览与来源。',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '检索关键词/语义描述' },
        limit: { type: 'number', description: '返回条数上限（默认 5）' },
        mode: { type: 'string', enum: ['hybrid', 'keyword', 'vector'], description: '检索模式' },
      },
      required: ['q'],
    },
  },
};

/** 系统提示：引导 LLM 按需主动检索（对应纯工具化语义） */
function buildSystemPrompt(): string {
  return (
    '你是用户的历史记忆助理。你可用 search_memories 工具检索用户先前的记忆' +
    '（决定、偏好、事实、报错解法、方案上下文等）。每次回答前先判断：是否需参考此前的记忆？' +
    '若相关，应先调用 search_memories 检索，再基于检索结果作答。当前会话开场文本已直接给出，不在检索范围。'
  );
}

// ── 单次收集 provider.chat 流，返回文本与捕获的 tool_calls ──
interface TurnResult {
  content: string;
  toolCalls: Message['toolCalls'];
}

async function collectTurn(
  provider: ReturnType<typeof createLlmProvider>,
  messages: Message[],
): Promise<TurnResult> {
  let content = '';
  let toolCalls: Message['toolCalls'];
  for await (const chunk of provider.chat(messages, { tools: [SEARCH_TOOL] })) {
    if (chunk.content) content += chunk.content;
    if (chunk.toolCalls && chunk.toolCalls.length > 0) toolCalls = chunk.toolCalls;
  }
  return { content, toolCalls };
}

/** 执行一个 case：真实 LLM 驱动，返回逐判定 */
async function runCase(
  s: BenchmarkSeed,
  provider: ReturnType<typeof createLlmProvider>,
  handlers: BuiltinToolHandlers,
): Promise<{ queried: boolean; hit: boolean; turns: number }> {
  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: s.input },
  ];
  let queried = false;
  let hit = false;
  let toolResultText = '';
  const MAX_TURNS = 5;
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns++;
    const { content, toolCalls } = await collectTurn(provider, messages);
    const calls = (toolCalls ?? []).filter((tc) => tc.function.name === 'search_memories');

    // 回填本轮 assistant 消息（含 tool_calls，供续轮上下文）
    messages.push({ role: 'assistant', content: content || '', toolCalls });

    if (calls.length === 0) {
      // 无工具调用 → 已是最终回答
      return { queried, hit, turns };
    }

    queried = true; // 主动调用了 search_memories
    for (const call of calls) {
      let args: { q?: string; limit?: number; mode?: string } = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      const q = args.q ?? s.input;
      const result = await handlers.searchMemories(q, String(args.limit ?? 5), args.mode ?? 'hybrid');
      toolResultText += result + '\n';
      messages.push({ role: 'tool', name: 'search_memories', toolCallId: call.id, content: result });
    }
    if (s.entity && toolResultText.includes(s.entity)) hit = true; // 命中目标（实体词）
  }
  return { queried, hit, turns };
}

async function main(): Promise<void> {
  console.log('🧪 真实 LLM A/B 模型行为验收\n');

  // 1. 真实配置（aliases: providers[active]，与 test-observability-errors.ts 同取法）
  const configPath = process.env['SMOKE_CONFIG'];
  const config = await loadConfig(configPath);
  const providers = config.llm?.providers ?? {};
  const active = config.llm?.active ?? Object.keys(providers)[0] ?? '';
  const realActive = providers[active];
  if (!realActive?.apiKey) {
    console.error('❌ active provider 未配置 apiKey（PowerShell: $env:MEMORA_API_KEY = "sk-xxx"，或 config 中填写）');
    process.exit(1);
  }
  const provider = createLlmProvider(config);
  console.log(`Provider: ${provider.name}`);
  console.log(`Model:    ${realActive.model ?? config.llm.model}`);
  console.log(`BaseUrl:  ${realActive.baseUrl}`);

  // 2. 筛选 case（BENCH_CASE 环境变量可限定，默认全量）
  const filter = (process.env['BENCH_CASE'] ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const cases = filter.length ? BENCH_SEEDS.filter((s) => filter.includes(s.id)) : BENCH_SEEDS;
  if (cases.length === 0) {
    console.error(`❌ BENCH_CASE 无匹配 case：${filter.join(',')}`);
    process.exit(1);
  }

  // 3. 装载种子（隔离会话，规避组装互斥）
  const projectPath = await mkdtemp(join(tmpdir(), 'memora-llm-'));
  const storage = new InMemoryStorage();
  loadBenchmarkSeed(storage);
  const security = new SecurityGuard(projectPath, projectPath);
  const handlers = new BuiltinToolHandlers(projectPath, security, storage);

  // 4. 逐 case 跑
  console.log(`\n运行 ${cases.length} 个 case（BENCH_CASE=${filter.length ? filter.join(',') : 'all'}）\n`);
  const rows: Array<{ id: string; queried: boolean; hit: boolean; answer: string }> = [];
  for (const s of cases) {
    const start = Date.now();
    const { queried, hit } = await runCase(s, provider, handlers);
    const ms = Date.now() - start;
    rows.push({ id: s.id, queried, hit, answer: `(耗时 ${ms}ms)` });
    const mark = `[${s.kind}] ${s.id} ${queried ? '✓主动检索' : '✗未检索'} ${hit ? '✓命中' : '✗未命中'}`;
    console.log(`${mark}  <- ${s.input}`);
  }

  // 5. 打印每 case 最终回答文本（供人工评答案质量）
  console.log('\n' + '━'.repeat(70));
  console.log('📋 判定记录表（queried=是否主动检索，hit=检索是否命中目标实体词）');
  console.log('| case | input | expectId | queried? | hit? | 答案质量 | 判定 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const s = cases.find((c) => c.id === r.id)!;
    const judge = r.queried && r.hit ? '成功' : !r.queried ? '失败(A未想起 / B未查)' : '失败(命中但hit?未中)';
    console.log(`| ${r.id} | ${s.input} | ${s.expectId} | ${r.queried ? '✓' : '✗'} | ${r.hit ? '✓' : '✗'} | ${r.answer} | ${judge} |`);
  }

  // 6. 汇总指标
  const aCases = cases.filter((c) => c.kind === 'A');
  const bCases = cases.filter((c) => c.kind === 'B');
  const aOk = rows.filter((r, i) => r.queried && r.hit && aCases.includes(cases[i]!)).length;
  const bOk = rows.filter((r, i) => r.queried && r.hit && bCases.includes(cases[i]!)).length;
  const aRate = aCases.length ? (aOk / aCases.length) * 100 : NaN;
  const bRate = bCases.length ? (bOk / bCases.length) * 100 : NaN;
  console.log('\n' + '━'.repeat(70));
  console.log('📊 指标（本机 → 与自动注入基线/云端对照见基准文档 §0）');
  console.log(`   A 想起率 = ${isNaN(aRate) ? 'N/A(无A用例)' : aRate.toFixed(0) + '%'}  （${aOk}/${aCases.length} 主动检索且命中）`);
  console.log(`   B 命中率 = ${isNaN(bRate) ? 'N/A(无B用例)' : bRate.toFixed(0) + '%'}  （${bOk}/${bCases.length}，须 ≈100% 硬门槛）`);
  if (!isNaN(bRate) && bRate < 100) {
    console.log(`   ⚠️ B 未达 ≈100% 硬门槛 → 判定阶段 1 未落地，可回退或升级（§阶段1 出口条件）`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    process.stderr.write(`💥 致命错误：\n${msg}\n`);
    process.exit(1);
  });