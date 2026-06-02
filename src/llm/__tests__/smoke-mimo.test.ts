/**
 * 集成测试：M-001 配置加载链路
 *
 * ⚠️ 真实 LLM 端到端测试在 scripts/smoke-llm.ts（需要 MEMORA_LLM_API_KEY）
 * 本测试只验证"配置 → 记忆 → LLM Provider"中间链路，不需要真实 LLM
 *
 * 跑法：
 *   pnpm test:run src/llm/__tests__/smoke-mimo.test.ts
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/loader.js';
import { createLlmProvider } from '../factory.js';
import { FileStore } from '../../memory/store.js';
import { MemoryIndex } from '../../memory/index.js';
import { MemoryLoader } from '../../memory/loader.js';

// 用项目自带的示例记忆目录（含 personality + rule + skill 3 条必召）
const MEMORY_DIR = resolve('f:/zooique/memora/examples/memories');
const DB_PATH = resolve('f:/zooique/memora/.smoke-test/memora.db');

describe('M-001 · 配置 + 记忆链路集成测试', () => {
  beforeAll(async () => {
    if (existsSync(DB_PATH)) {
      await rm(DB_PATH, { force: true });
    }
  });

  afterAll(async () => {
    if (existsSync(DB_PATH)) {
      // sqlite3 可能仍持有句柄，延迟删除
      await new Promise((r) => setTimeout(r, 100));
      try {
        await rm(DB_PATH, { force: true });
      } catch {
        // Windows EBUSY 常见，忽略
      }
    }
  });

  it('必召记忆被正确加载到 system prompt', async () => {
    const fileStore = new FileStore(MEMORY_DIR);
    const index = new MemoryIndex(DB_PATH);
    const loader = new MemoryLoader(fileStore, index);
    const { memories: bootstrap, loadResult } = await loader.bootstrap();

    // 4 条全加载，3 条必召（personality + rule + skill）
    expect(loadResult.loaded).toBe(4);
    expect(bootstrap.length).toBe(3);

    // 验证必召记忆中包含核心人格
    const personality = bootstrap.find((m) => m.type === 'personality');
    expect(personality).toBeDefined();
    expect(personality?.content).toContain('Memora');
    expect(personality?.content).toContain('万物皆记忆');

    // 验证必召记忆包含安全规则
    const rule = bootstrap.find((m) => m.type === 'rule');
    expect(rule).toBeDefined();
    expect(rule?.permanence).toBe('always');

    await index.close();
  });

  it('smoke-mimo.json 配置能被正确加载和展开', async () => {
    const configPath = resolve('f:/zooique/memora/config/smoke-mimo.json');
    if (!existsSync(configPath)) {
      return; // CI 环境下文件可能不存在
    }

    const raw = await readFile(configPath, 'utf-8');
    expect(raw).toContain('${MEMORA_LLM_API_KEY}'); // 占位符必须存在

    // 加载后应被展开（若没设环境变量，apiKey 为空字符串）
    const config = await loadConfig(configPath);
    expect(config.llm.model).toBe('mimo-v2.5-pro');
    expect(config.llm.baseUrl).toBe('https://api.xiaomimimo.com/v1');
  });

  it('factory 能根据 mimo 配置创建 OpenAI 兼容 provider（无网络调用）', () => {
    // 直接构造配置，跳过 loadConfig 避免依赖环境变量
    const fakeConfig = {
      llm: {
        provider: 'mimo',
        model: 'mimo-v2.5-pro',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'test-key-not-real',
        temperature: 0.7,
      },
      memory: { dataDir: MEMORY_DIR, maxContextTokens: 120000 },
      security: { permission: 'owner' as const, confirmWrites: false },
      allowedPaths: [],
    };

    const provider = createLlmProvider(fakeConfig as never);
    expect(provider.name).toBe('mimo');
    // 不真正调用 chat（避免网络请求）
  });
});
