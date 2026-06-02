/**
 * 真实 LLM 端到端烟测
 *
 * 用法：
 *   $env:MEMORA_LLM_API_KEY = "sk-xxx"
 *   npx tsx scripts/smoke-llm.ts
 *
 * 验证项（M-001）：
 *   1. 配置加载 + 环境变量展开
 *   2. 必召记忆注入（always + domain）
 *   3. OpenAI 兼容协议调用真实 LLM
 *   4. SSE 流式响应解析
 *   5. 完整 token 拼回（用于验证流式不丢字）
 *
 * 不会：
 *   - 写 API Key 到任何文件
 *   - 提交任何 commit
 *   - 触发 Git 钩子
 */

// Node 24 + Windows + undici 在 fetch 401 后会触发 libuv async handle closing assertion
// 我们已经在业务层 catch 并打印友好错误，但 undici 内部的 stream 资源有时仍会触发崩溃
// 用 uncaughtException 兜底：业务错误已处理，崩溃可接受
process.on('uncaughtException', (err) => {
  if (
    String(err.message).includes('UV_HANDLE_CLOSING') ||
    String(err.stack ?? '').includes('async.c')
  ) {
    process.stderr.write('\n⚠️  Node fetch 内部 stream 清理异常（已忽略，业务错误已在上面处理）\n');
    process.exit(1);
  }
  // 未知异常：正常抛出
  process.stderr.write(`💥 未捕获异常：${err.stack ?? err.message}\n`);
  process.exit(1);
});

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config/loader.js';
import { createLlmProvider } from '../src/llm/factory.js';
import { FileStore } from '../src/memory/store.js';
import { MemoryIndex } from '../src/memory/index.js';
import { MemoryLoader } from '../src/memory/loader.js';
import { logger } from '../src/logging/logger.js';

async function main(): Promise<void> {
  // 1. 配置加载
  // SMOKE_CONFIG 环境变量可指定配置文件路径（默认走标准 loadConfig 逻辑）
  const configPath = process.env['SMOKE_CONFIG'];
  const config = await loadConfig(configPath);
  logger.info({ provider: config.llm.provider, model: config.llm.model }, '配置加载完成');

  if (!config.llm.apiKey) {
    console.error('❌ 未设置 MEMORA_LLM_API_KEY 环境变量');
    console.error('   PowerShell: $env:MEMORA_LLM_API_KEY = "sk-xxx"');
    console.error('   Bash:       export MEMORA_LLM_API_KEY="sk-xxx"');
    process.exit(1);
  }

  // 2. 必召记忆加载
  const memoraDir = resolve(config.memory.dataDir.replace(/^~/, homedir()));
  const fileStore = new FileStore(memoraDir);
  const dbPath = resolve(memoraDir, 'memora.db');
  const index = new MemoryIndex(dbPath);
  const loader = new MemoryLoader(fileStore, index);
  const { memories: bootstrap, loadResult } = await loader.bootstrap();
  logger.info({ loaded: loadResult.loaded, bootstrap: bootstrap.length }, '记忆加载完成');
  await index.close();

  // 3. Provider 创建
  const provider = createLlmProvider(config);

  // 4. 组装消息：必召记忆 → system + user
  const systemMessages = bootstrap.map((m) => ({
    role: 'system' as const,
    content: `## ${m.type}:${m.name}\n\n${m.content}`,
  }));
  const userMessage = '用一句话介绍你自己，不要超过 50 字。';

  console.log('\n' + '━'.repeat(60));
  console.log('🌲 M-001 真实 LLM 端到端烟测');
  console.log('━'.repeat(60));
  console.log(`Provider:  ${provider.name}`);
  console.log(`Model:     ${config.llm.model}`);
  console.log(`BaseUrl:   ${config.llm.baseUrl}`);
  console.log(`必召记忆:  ${bootstrap.length} 条`);
  console.log(`用户输入:  ${userMessage}`);
  console.log('━'.repeat(60));
  console.log('🤖 响应：\n');

  // 5. 调用 + 流式输出
  const startTime = Date.now();
  let fullContent = '';
  let chunkCount = 0;
  try {
    for await (const chunk of provider.chat([
      ...systemMessages,
      { role: 'user', content: userMessage },
    ])) {
      if (chunk.content) {
        process.stdout.write(chunk.content);
        fullContent += chunk.content;
        chunkCount++;
      }
      if (chunk.finishReason === 'stop') {
        break;
      }
    }
  } catch (err) {
    console.error('\n\n❌ LLM 调用失败：', (err as Error).message);
    process.exit(1);
  }
  const elapsed = Date.now() - startTime;

  console.log('\n');
  console.log('━'.repeat(60));
  console.log('📊 烟测结果：');
  console.log(`   响应长度：${fullContent.length} 字符`);
  console.log(`   流式 chunk 数：${chunkCount}`);
  console.log(`   耗时：${elapsed} ms`);
  console.log('━'.repeat(60));

  if (fullContent.length === 0) {
    console.error('❌ 响应为空（流式可能未触发）');
    process.exit(1);
  }

  console.log('✅ M-001 烟测通过！');
}

main()
  .then(() => {
    // 显式退出：避免 Node 24 + Windows + fetch 的 stream 关闭顺序问题
    // (libuv async handle closing assertion)
    process.exit(0);
  })
  .catch((err: unknown) => {
    // Node 24 + Windows PowerShell 下 console.error(err) 偶尔报 inspect 错误
    // 改用 String() 兜底
    const msg =
      err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    process.stderr.write(`💥 致命错误：\n${msg}\n`);
    process.exit(1);
  });
