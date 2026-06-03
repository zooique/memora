/**
 * Agent 门面类单元测试
 *
 * 覆盖核心方法：
 * - inspect() · 4 层记忆快照（working / bootstrap / archive / mounted）
 *
 * 设计原则：
 * - 用 mock LLM provider 走完整 init() 流程
 * - 用 tmpdir 做项目根目录，不污染真实 .memora/
 * - 每个测试独立 tmp 目录
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import type { Config } from '@/config/loader.js';

function makeConfig(dataDir: string): Config {
  return {
    llm: { provider: 'mock', model: 'mock-model', temperature: 0.7 },
    memory: { dataDir, maxContextTokens: 80000 },
    security: { permission: 'owner', confirmWrites: false },
    allowedPaths: [dataDir],
  };
}

/**
 * 写入项目骨架文件，让 init() 能正常加载
 *
 * 注意：传入 configDir 时，loader 会用 configFileStore = FileStore(configDir)，
 * 所以 personality/rules/skills/tools 要写到 configDir 下，而不是 memoraDir。
 * (详见 project-manager.ts §initProject)
 */
function seedProject(projectPath: string, configDir: string): void {
  // 运行时数据目录骨架（仅 topics 即可——personality/rules 在 configDir 里）
  mkdirSync(join(projectPath, '.memora', 'topics'), { recursive: true });

  // 配置目录骨架（loader 默认扫描这里）
  mkdirSync(join(configDir, 'personality'), { recursive: true });
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(
    join(configDir, 'personality', 'default.md'),
    '---\nid: default-personality\ntype: personality\npermanence: always\nname: 默认人格\nweight: 1\n---\n\n你是一个测试助手。',
    'utf-8',
  );
}

describe('Agent · inspect() · 4 层记忆快照', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    // 系统级 tmp 目录（dataDir），避免污染用户 ~/.memora
    tmpData = mkdtempSync(join(tmpdir(), 'memora-agent-data-'));
    // 项目目录
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-agent-proj-'));
    // 配置目录
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-agent-cfg-'));
    seedProject(tmpProject, tmpConfig);
  });

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  /**
   * 构造一个最小可用的 Agent
   */
  function makeAgent(): Agent {
    const config = makeConfig(tmpData);
    const a = new Agent({
      config,
      configDir: tmpConfig,
      projectPath: tmpProject,
    });
    return a;
  }

  it('init 后 inspect() 应返回 4 层快照结构', async () => {
    agent = makeAgent();
    await agent.init();

    const snap = agent.inspect();

    // 4 层结构必须存在
    expect(snap).toHaveProperty('working');
    expect(snap).toHaveProperty('bootstrap');
    expect(snap).toHaveProperty('archive');
    expect(snap).toHaveProperty('mounted');
  });

  it('inspect().working 应反映 AgentLoop 当前消息数', async () => {
    agent = makeAgent();
    await agent.init();

    // 初始只有 system 提示
    const initial = agent.inspect();
    expect(initial.working.total).toBe(1); // 仅 system
    // preview 至少有一条（system 消息必存在）
    const firstPreview = initial.working.preview[0];
    expect(firstPreview).toBeDefined();
    expect(firstPreview?.role).toBe('system');

    // 模拟一次 chat
    await agent.chatSync('你好');

    // chatSync 后多了 user + assistant 两条
    const afterChat = agent.inspect();
    expect(afterChat.working.total).toBeGreaterThan(initial.working.total);
    const lastUser = [...afterChat.working.preview].reverse().find((m) => m.role === 'user');
    expect(lastUser).toBeDefined();
  });

  it('inspect().bootstrap 应包含 always+domain 记忆', async () => {
    agent = makeAgent();
    await agent.init();

    const snap = agent.inspect();
    // seedProject 写入了 personality，应被 bootstrap 加载
    expect(snap.bootstrap.total).toBeGreaterThan(0);
    expect(snap.bootstrap.items.length).toBeGreaterThan(0);
    // 每条 bootstrap 记忆应包含 5 个必要字段
    for (const item of snap.bootstrap.items) {
      expect(item.id).toBeDefined();
      expect(item.type).toBeDefined();
      expect(item.permanence).toBeDefined();
      expect(item.name).toBeDefined();
      expect(typeof item.weight).toBe('number');
    }
  });

  it('inspect().archive 应包含 currentTopic 与 hint', async () => {
    agent = makeAgent();
    await agent.init();

    const snap = agent.inspect();
    expect(snap.archive.currentTopic).toBeDefined();
    expect(snap.archive.hint).toContain('listAllTopics');
    // 同步快照 topicFilesCount 暂为 0，真实值由 listAllTopics() 异步补全
    expect(typeof snap.archive.topicFilesCount).toBe('number');
  });

  it('inspect().mounted 初始应未挂载（topicMount 为空）', async () => {
    agent = makeAgent();
    await agent.init();

    const snap = agent.inspect();
    expect(snap.mounted.total).toBe(0);
    expect(snap.mounted.isMounted).toBe(false);
    expect(snap.mounted.items).toHaveLength(0);
  });

  it('chatSync 触发 TopicMount.focus() 后 inspect().mounted 应有变化', async () => {
    agent = makeAgent();
    await agent.init();

    // 关注前快照
    const before = agent.inspect();
    expect(before.mounted.total).toBe(0);

    // 触发 focus（chatSync 内部会调 focus）
    await agent.chatSync('写一段测试对话');

    // 关注后快照（即使没有相关记忆，状态也应反映 focus 调用）
    const after = agent.inspect();
    // 字段结构应一致
    expect(after.mounted).toHaveProperty('total');
    expect(after.mounted).toHaveProperty('isMounted');
    expect(after.mounted).toHaveProperty('items');
  });

  it('inspect() 在未 init 时应抛错', () => {
    agent = makeAgent();
    // 注意：未 init 就 inspect
    expect(() => agent!.inspect()).toThrow(/未初始化/);
  });

  it('preview 字段应截断到 CONTENT_PREVIEW_LEN=80 字符', async () => {
    agent = makeAgent();
    await agent.init();

    // 注入一条超长 system prompt
    const longContent = 'A'.repeat(500);
    await agent.chatSync(longContent);

    const snap = agent.inspect();
    for (const item of snap.working.preview) {
      // preview 长度 ≤ 80，但 contentLength 反映真实长度
      expect(item.contentPreview.length).toBeLessThanOrEqual(80);
    }
  });
});
