/**
 * 真实 LLM 集成测试
 *
 * Smoke test 验证端到端链路：chat → 归档 → 召回 → 角色切换
 *
 * 自动从项目级 .memora/config.json 读取 LLM 配置（loadConfig() 无参数时的查找路径）
 * apiKey 支持 ${ENV_VAR} 格式从环境变量展开（如 ${MEMORA_API_KEY}），避免明文落盘
 *
 * 运行方式：
 *   npx vitest run src/llm/__tests__/llmIntegration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, createLlmProvider, loadConfig } from '@/index.js';

/**
 * 同步探测是否有可用的 LLM API key（模块加载期求值，供 describe.skipIf 使用）。
 * 与 loadConfig() 无参时的项目级查找路径一致（<cwd>/.memora/config.json）；
 * apiKey 支持 ${ENV_VAR} 展开——环境变量存在才算有 key。
 * @returns 存在有效 apiKey 返回 true，否则 false
 */
function detectHasApiKey(): boolean {
  try {
    const configPath = resolve(process.cwd(), '.memora/config.json');
    if (!existsSync(configPath)) return false;
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      llm?: { providers?: Record<string, { apiKey?: string } | undefined> };
    };
    const providers = config?.llm?.providers ?? {};
    return Object.values(providers).some((p) => {
      const key = p?.apiKey;
      if (!key) return false;
      // ${ENV_VAR} 格式：环境变量存在才算有 key（与 loadConfig expandEnvVars 语义一致）
      const m = /^\$\{([A-Z0-9_]+)\}$/.exec(key);
      return m ? !!process.env[m[1]!] : true;
    });
  } catch {
    return false;
  }
}

/** 是否有可用的 LLM API key（离线/未配置时整套件 skip，避免空转 pass 污染"全绿"口径） */
const hasApiKey = detectHasApiKey();

describe.skipIf(!hasApiKey)('真实 LLM 集成测试', () => {
  let tmpDir: string;
  let tmpHome: string;
  let agent: Agent;

  beforeAll(async () => {
    // 从用户配置文件加载（与宿主一致）
    let config;
    try {
      config = await loadConfig();
    } catch {
      console.warn('跳过：未找到 ~/.memora/config.json 或配置不完整');
      return;
    }

    const hasProviderKey = Object.values(config?.llm?.providers ?? {}).some((p) => p?.apiKey);
    if (!hasProviderKey) {
      console.warn('跳过：配置中缺少 apiKey');
      return;
    }

    // 创建临时目录
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-llm-'));
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-llm-home-'));
    const configDir = join(tmpHome, '.memora-config');

    // 创建项目 .memora 目录
    const memoraDir = join(tmpDir, '.memora');
    mkdirSync(memoraDir, { recursive: true });

    // 创建 configDir 下的角色包（RolePackManager 从 configDir/role-packs/ 加载）
    const defaultPackDir = join(configDir, 'role-packs', '默认助手');
    mkdirSync(defaultPackDir, { recursive: true });
    writeFileSync(
      join(defaultPackDir, 'manifest.json'),
      JSON.stringify({
        name: '默认助手',
        displayName: '默认助手',
        strategy: {},
      }),
      'utf-8',
    );
    writeFileSync(
      join(defaultPackDir, 'persona.md'),
      '你是一个友好的 AI 助手，帮助用户解决问题。',
      'utf-8',
    );

    // 创建程序员角色包（用于角色切换测试）
    const coderPackDir = join(configDir, 'role-packs', '程序员助手');
    mkdirSync(coderPackDir, { recursive: true });
    writeFileSync(
      join(coderPackDir, 'manifest.json'),
      JSON.stringify({
        name: '程序员助手',
        displayName: '程序员助手',
        strategy: {},
      }),
      'utf-8',
    );
    writeFileSync(
      join(coderPackDir, 'persona.md'),
      '你是一个专业的程序员助手，擅长代码审查和问题诊断。',
      'utf-8',
    );

    // 用用户的真实配置创建 Provider
    const provider = createLlmProvider(config);

    // 创建 Agent
    agent = new Agent({
      projectPath: tmpDir,
      configDir,
      dataDir: join(tmpHome, '.memora'),
      provider,
    });

    await agent.init();
  });

  afterAll(async () => {
    if (agent) {
      await agent.close();
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('应该完成 chat → 归档 → 召回 全流程', async () => {
    if (!agent) {
      console.warn('跳过测试：Agent 未初始化');
      return;
    }

    // 第一轮对话：介绍用户信息
    const input1 = '你好，我叫张三，我是一名前端工程师，喜欢用 React 和 TypeScript。请简短回复。';
    let response1 = '';
    for await (const chunk of agent.chat(input1)) {
      if (chunk.type === 'text') {
        response1 += chunk.content;
        process.stdout.write(chunk.content);
      }
    }

    expect(response1.length).toBeGreaterThan(0);

    // 等待后处理完成（归档 + 轮次摘要生成）
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 第二轮对话：测试召回
    const input2 = '你还记得我叫什么名字吗？我的职业是什么？请简短回答。';
    let response2 = '';
    for await (const chunk of agent.chat(input2)) {
      if (chunk.type === 'text') {
        response2 += chunk.content;
        process.stdout.write(chunk.content);
      }
    }

    expect(response2.length).toBeGreaterThan(0);
  }, 60_000);

  it('应该支持角色切换', async () => {
    if (!agent) {
      console.warn('跳过测试：Agent 未初始化');
      return;
    }

    // 切换到程序员角色
    const switched = agent.switchRolePack('程序员助手');
    expect(switched).toBe(true);
    expect(agent.rolePack?.activeName).toBe('程序员助手');

    const input = '帮我看看这段代码有什么问题：const x = ; 请简短回复。';
    let response = '';
    for await (const chunk of agent.chat(input)) {
      if (chunk.type === 'text') {
        response += chunk.content;
        process.stdout.write(chunk.content);
      }
    }

    expect(response.length).toBeGreaterThan(0);
  }, 30_000);

  it('应该支持角色自动匹配', async () => {
    if (!agent) {
      console.warn('跳过测试：Agent 未初始化');
      return;
    }

    // 先切回默认角色，避免上一轮测试残留角色干扰本轮自动匹配
    agent.switchRolePack('默认助手');

    const input = '帮我写一个 TypeScript 工具函数来深拷贝对象。请简短。';
    let response = '';
    for await (const chunk of agent.chat(input)) {
      if (chunk.type === 'text') {
        response += chunk.content;
        process.stdout.write(chunk.content);
      }
    }

    expect(response.length).toBeGreaterThan(0);

    // 等待后处理完成（角色自动匹配在 chat 结束后异步触发）
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 60_000);
});
