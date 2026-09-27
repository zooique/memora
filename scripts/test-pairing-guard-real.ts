/**
 * 发送边界成形守卫 —— 真实 LLM 复验
 *
 * 目的：验证「守卫在真实模型输出下健康态真零触发」。
 * mock 恒绿不足以证明（mock provider 不做服务端 400 校验），需真实模型 + 真实服务端：
 *   1. 真实模型**确实发起一次工具调用**（read_file）→ 内核执行 → 写 assistant.toolCalls+tool 结果；
 *   2. 下一轮把配对批次真实发给服务端 → 服务端**接受**（不 400）；
 *   3. 过程若守卫命中会抛「发送边界守卫拒绝」→ 本轮异常中断（= 假阳性，本次只需证明不触发）。
 *
 * 用法（需 .memora/config.json + ${MEMORA_API_KEY}）：
 *   npx tsx scripts/test-pairing-guard-real.ts
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { AgentLoop } from '../src/agent/loop.js';
import { loadConfig } from '../src/config/loader.js';
import { createLlmProvider } from '../src/llm/factory.js';
import type { AgentMetrics } from '../src/agent/tracer.js';

/** 让真实模型调用的工具：读一个真实存在的文件（package.json） */
const TARGET = join(process.cwd(), 'package.json');

const TOOL_DEFS = [
  {
    name: 'read_file',
    description: '读取指定文件的完整内容。需要读取文件内容时使用。',
    parameters: {
      type: 'object' as const,
      properties: { path: { type: 'string' as const, description: '要读取的文件绝对路径' } },
      required: ['path'],
    },
  },
];

function assert(cond: boolean, msg: string): void {
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) process.exitCode = 1;
}

function printMetrics(m: AgentMetrics): void {
  console.log(`\n┌─ 真实运行 metrics`);
  console.log(
    `│  LLM 调用 ${m.llm.callCount} 次 | 实际输入 ${m.llm.actualInputTokens} / 输出 ${m.llm.actualOutputTokens} tokens`,
  );
  console.log(`│  工具 ${m.tools.callCount} 次调用 | ${m.tools.failureCount} 次失败`);
  console.log(
    `│  任务 ${m.tasks.totalCount} 次 | 成功 ${m.tasks.successCount} | 失败 ${m.tasks.failureCount}`,
  );
  console.log(`└${'─'.repeat(50)}`);
}

async function main(): Promise<void> {
  console.log(
    `${'━'.repeat(64)}\n  TOOLPAIR-2 Step 3 · 发送边界成形守卫 —— 真实 LLM 复验\n${'━'.repeat(64)}`,
  );

  const config = await loadConfig();
  const hasKey = Object.values(config?.llm?.providers ?? {}).some((p) => p?.apiKey);
  if (!hasKey) {
    console.error('❌ 配置无 API Key（需 .memora/config.json + ${MEMORA_API_KEY}）');
    process.exit(1);
  }
  const provider = createLlmProvider(config);
  console.log(`  Provider: ${provider.name} | 触发工具: read_file -> ${TARGET}\n`);

  // 记录工具是否真的被调用（证明真实模型发起 tool_call）
  let toolCalled = false;
  let toolArgPath = '';
  const toolExecutor = async (name: string, argsStr: string): Promise<string> => {
    if (name !== 'read_file') return `未知工具: ${name}`;
    toolCalled = true;
    const args = JSON.parse(argsStr || '{}') as { path?: string };
    toolArgPath = args.path ?? '';
    try {
      const content = readFileSync(args.path!, 'utf-8');
      return `读取成功（${args.path}）：前 300 字符\n${content.slice(0, 300)}`;
    } catch {
      return `读取失败：${args.path}`;
    }
  };

  const loop = new AgentLoop({
    provider,
    bootstrapMemories: [],
    toolExecutor,
    toolDefinitions: TOOL_DEFS,
  });

  console.log(
    `📤 输入: "请务必调用 read_file 工具读取 ${TARGET}，然后用一句话告诉我文件里有没有 'version' 字段。不要直接回答。"\n`,
  );
  const input = `请务必调用 read_file 工具读取 ${TARGET}，然后用一句话告诉我文件里有没有 'version' 字段。不要直接回答。`;

  let response = '';
  let guardFired = false;
  let serviceRejected = false;
  try {
    for await (const chunk of loop.processUserInput(input)) {
      if (chunk.type === 'text') {
        response += chunk.content;
        process.stdout.write(chunk.content);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 守卫命中（假阳性）与本轮异常都视为复验失败信号
    if (msg.includes('发送边界守卫拒绝')) guardFired = true;
    if (msg.includes('400') || msg.includes('格式错误')) serviceRejected = true;
    console.error(`\n\n💥 本轮异常：${msg}`);
  }
  console.log(`\n\n  ⏱️  已跑完一轮（若守卫或 400 命中，上方会出现 💥 异常）`);

  const metrics = loop.getMetrics();

  printMetrics(metrics);

  console.log(`\n┌─ 复验判据`);
  assert(toolCalled, `真实模型发起了 read_file 工具调用（path=${toolArgPath || '(未取到)'}）`);
  assert(!guardFired, '守卫未命中（健康态真零触发）——若命中即假阳性');
  assert(!serviceRejected, '服务端未拒绝（无 400 / 无「格式错误」）');
  assert(metrics.tools.failureCount === 0, `工具失败数 = 0（实际 ${metrics.tools.failureCount}）`);
  assert(response.length > 0, '有最终文本回复');
  console.log(`└${'─'.repeat(50)}`);

  if (!process.exitCode) {
    console.log('\n🎉 真机复验通过：真实模型工具调用 → 内核配对 → 服务端接受，守卫零触发。');
  } else {
    console.log('\n⚠️ 存在失败项，见上方 ❌。');
  }
}

main().catch((err) => {
  console.error('💥 脚本异常:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
