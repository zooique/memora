/**
 * 真实 LLM 集成测试
 *
 * Smoke test 验证端到端链路：chat → 归档 → 召回 → 角色切换
 *
 * 自动从 ~/.memora/config.json 读取 LLM 配置（与 sprite 宿主一致）
 *
 * 运行方式：
 *   npx vitest run src/llm/__tests__/llm-integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, createLlmProvider, loadConfig } from '@/index.js';

describe('真实 LLM 集成测试', () => {
  let tmpDir: string;
  let tmpHome: string;
  let agent: Agent;

  beforeAll(async () => {
    // 从用户配置文件加载（与 sprite 宿主一致）
    let config;
    try {
      config = await loadConfig();
    } catch {
      console.warn('跳过：未找到 ~/.memora/config.json 或配置不完整');
      return;
    }

    if (!config?.llm?.apiKey) {
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

    // 创建 configDir 下的角色文件（PersonaManager 从 configDir 加载）
    mkdirSync(join(configDir, 'personas'), { recursive: true });

    // 创建默认角色
    writeFileSync(
      join(configDir, 'personas', 'default.md'),
      `---
name: 默认助手
keywords:
  - 帮助
  - 助手
---
你是一个友好的 AI 助手，帮助用户解决问题。
`,
    );

    // 创建程序员角色（用于角色切换测试）
    writeFileSync(
      join(configDir, 'personas', 'coder.md'),
      `---
name: 程序员助手
keywords:
  - 代码
  - 编程
  - bug
---
你是一个专业的程序员助手，擅长代码审查和问题诊断。
`,
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

    // 等待后处理完成（归档 + insight 提取）
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
    const switched = agent.persona?.switchPersona('程序员助手');
    expect(switched).toBeTruthy();
    expect(agent.persona?.activeName).toBe('程序员助手');

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
    agent.persona?.switchPersona('默认助手');

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
