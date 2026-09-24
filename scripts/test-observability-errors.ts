/**
 * 真实 Provider 错误场景端到端验证
 *
 * 目的：补 test-observability-real.ts（仅正常路径）与 test-observability.ts（模拟）未覆盖的
 * 真实错误路径——API 限流(429) / 网络超时 / 认证失败(401)，确认错误分类与异常语义符合契约。
 *
 * 用法：
 *   npx tsx scripts/test-observability-errors.ts
 *
 * 设计原则：
 *   - 用真实 OpenAICompatibleProvider（走真实 fetch + SSE 解析），不 mock HTTP 层
 *   - 认证失败：错 key 打真实 DeepSeek baseUrl → 期望 401 → configError
 *   - 限流 429：本地 HTTP server 返回 429 → 期望 llmError
 *   - 网络不可达：不可达地址 → 期望 networkError
 *   - 正常对照：真 key 单轮 → usage 真填充（证明错误分类不误伤正常路径）
 *
 * 验收标准：
 *   - 认证失败抛 configError 且消息含「LLM API Key 无效」
 *   - 限流抛 llmError 且消息含「LLM 服务限流」
 *   - 网络不可达抛 networkError
 *   - 正常对照 actualInputTokens > 0（DeepSeek 真实 usage 提取）
 */
import { createServer } from 'node:http';
import { OpenAICompatibleProvider } from '../src/llm/openaiCompatible.js';
import { loadConfig } from '../src/config/loader.js';
import { MemoraError } from '../src/utils/errors.js';
import type { Message } from '../src/llm/provider.js';

// ─── 断言辅助 ──────────────────────────────────

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    failures++;
    console.error(`  ❌ ${message}`);
  }
}

function printBanner(text: string): void {
  console.log(`\n${'━'.repeat(70)}\n  ${text}\n${'━'.repeat(70)}`);
}

/** 消费 provider.chat() 生成器，返回全部 chunk */
async function drain(
  provider: OpenAICompatibleProvider,
  messages: Message[],
  opts?: Record<string, unknown>,
): Promise<{ chunks: Array<{ content?: string; usage?: unknown }>; error?: unknown }> {
  try {
    const chunks: Array<{ content?: string; usage?: unknown }> = [];
    for await (const chunk of provider.chat(messages, opts as never)) {
      chunks.push({ content: chunk.content, usage: chunk.usage });
    }
    return { chunks };
  } catch (err) {
    return { chunks: [], error: err };
  }
}

// ─── 主函数 ──────────────────────────────────

async function main(): Promise<void> {
  printBanner('D3 · 真实 Provider 错误场景端到端验证');

  // 加载真实配置（获取 DeepSeek baseUrl）
  const config = await loadConfig();
  const providers = config.llm?.providers ?? {};
  const active = config.llm?.active ?? Object.keys(providers)[0] ?? '';
  const real = providers[active];
  check(
    real !== undefined && real !== null && typeof real.baseUrl === 'string' && real.baseUrl.length > 0,
    `真实 Provider 配置存在（${active}）`,
  );

  const baseUrl = (real?.baseUrl ?? '').replace(/\/chat\/completions\/?$/, '');
  const model = real?.model ?? '';
  const realKey = real?.apiKey ?? '';

  // ── 场景 1：认证失败（错 key 打真实 DeepSeek → 401） ──
  printBanner('场景 1：认证失败（401 → configError）');
  {
    const badProvider = new OpenAICompatibleProvider('deepseek-badkey', {
      baseUrl,
      apiKey: 'sk-invalid-key-0000',
      defaultModel: model,
    });
    const { error } = await drain(badProvider, [{ role: 'user', content: 'hi' }], { timeoutMs: 15000 });
    check(error !== null, '认证失败：调用抛出错误');
    if (error !== null) {
      const isConfig = error instanceof MemoraError && error.category === 'config';
      check(isConfig, '认证失败：抛 config 类 MemoraError');
      const msg = error instanceof Error ? error.message : String(error);
      check(msg.includes('API Key 无效'), `认证失败：错误消息含「API Key 无效」（实际: ${msg.slice(0, 60)}）`);
      const hint = error instanceof MemoraError ? error.suggestions : undefined;
      check(Array.isArray(hint) && hint.some((h) => h.includes('${MEMORA_API_KEY}')), '认证失败：hint 提示环境变量占位符展开');
    }
  }

  // ── 场景 2：限流 429（本地 server 返回 429 → llmError） ──
  printBanner('场景 2：限流（HTTP 429 → llmError）');
  {
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    try {
      const rateLimitedProvider = new OpenAICompatibleProvider('rate-limit-test', {
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'any',
        defaultModel: model,
      });
      const { error } = await drain(rateLimitedProvider, [{ role: 'user', content: 'hi' }], { timeoutMs: 5000 });
      check(error !== null, '限流：调用抛出错误');
      if (error !== null) {
        const msg = error instanceof Error ? error.message : String(error);
        check(msg.includes('限流'), `限流：错误消息含「限流」（实际: ${msg.slice(0, 60)}）`);
        const isNotConfig = !(error instanceof MemoraError && error.category === 'config');
        check(isNotConfig, '限流：错误类型非 configError（是 llmError）');
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  // ── 场景 3：网络不可达（networkError） ──
  printBanner('场景 3：网络不可达（networkError）');
  {
    const unreachableProvider = new OpenAICompatibleProvider('unreachable', {
      baseUrl: 'http://127.0.0.1:1', // 端口 1 必然拒绝连接
      apiKey: 'any',
      defaultModel: model,
    });
    const { error } = await drain(unreachableProvider, [{ role: 'user', content: 'hi' }], { timeoutMs: 5000 });
    check(error !== null, '网络不可达：调用抛出错误');
    if (error !== null) {
      const msg = error instanceof Error ? error.message : String(error);
      check(msg.includes('连接失败') || msg.includes('超时'), `网络不可达：错误消息含「连接失败/超时」（实际: ${msg.slice(0, 60)}）`);
    }
  }

  // ── 场景 4：正常对照（真 key 单轮 → usage 真填充） ──
  printBanner('场景 4：正常对照（真实 usage 提取）');
  {
    check(realKey.length > 20, '真实 key 可用（长度>20）');
    if (realKey.length > 20) {
      const goodProvider = new OpenAICompatibleProvider(active, {
        baseUrl,
        apiKey: realKey,
        defaultModel: model,
      });
      const { chunks, error } = await drain(goodProvider, [{ role: 'user', content: '只回复"OK"两个字。' }], {
        timeoutMs: 30000,
      });
      check(error === null, '正常对照：无错误');
      const usage = chunks.find((c) => c.usage && (c.usage as { inputTokens?: number }).inputTokens);
      const inTok = usage ? (usage.usage as { inputTokens: number }).inputTokens : 0;
      const outTok = usage ? (usage.usage as { outputTokens: number }).outputTokens : 0;
      check(inTok > 0, `正常对照：实际输入 token > 0（真实: ${inTok}）`);
      check(outTok > 0, `正常对照：实际输出 token > 0（真实: ${outTok}）`);
      const content = chunks.filter((c) => c.content).map((c) => c.content).join('');
      check(content.length > 0, `正常对照：有文本回复（${content.slice(0, 30)}...）`);
    }
  }

  printBanner(`D3 验证 ${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\n❌ 脚本异常:', err);
  process.exit(1);
});
