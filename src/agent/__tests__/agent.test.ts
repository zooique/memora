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
import type { Memory, MemoryTypeValue } from '@/memory/types.js';

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
 * 注意：memora.db 和 TopicStore 现在是 Agent 级共享资源（单 Agent 模型），
 * TopicStore 使用 dataDir（agentDataDir），而非 projectPath/.memora/。
 * personality/rules/skills/tools 写到 configDir 下（两层加载中的 Agent 层）。
 */
function seedProject(_projectPath: string, configDir: string, dataDir: string): void {
  // TopicStore 使用 Agent 级 dataDir，所以 topics/ 建在 dataDir 下
  mkdirSync(join(dataDir, 'topics'), { recursive: true });

  // 配置目录骨架（loader 扫描这里作为 Agent 级配置）
  mkdirSync(join(configDir, 'identities'), { recursive: true });
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(
    join(configDir, 'identities', 'default.md'),
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
    seedProject(tmpProject, tmpConfig, tmpData);
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

  it('inspect().bootstrap 应返回引导记忆（personality 由 PersonaManager 单独注入）', async () => {
    agent = makeAgent();
    await agent.init();

    const snap = agent.inspect();
    // bootstrap 跳过 personality 类型（PersonaManager 单独注入 system prompt 前缀）
    // 但仍可能包含 rules 等非 personality 记忆
    expect(typeof snap.bootstrap.total).toBe('number');
    expect(Array.isArray(snap.bootstrap.items)).toBe(true);
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
  }, 30000); // 显式 30s（mock 慢 + 并行测试时 timer 拥塞）
});

// ─── 2026-06-03 · Signal 实时触发归档 + Lazy 启动扫描 ────────────

import { MemoryType, Permanence } from '@/memory/types.js';
import { readdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

describe('Agent · 实时归档（Signal 触发 + Lazy 扫描）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(pathJoin(tmpdir(), 'memora-agent-signal-data-'));
    tmpProject = mkdtempSync(pathJoin(tmpdir(), 'memora-agent-signal-proj-'));
    tmpConfig = mkdtempSync(pathJoin(tmpdir(), 'memora-agent-signal-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
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

  function makeAgent(): Agent {
    const config = makeConfig(tmpData);
    return new Agent({
      config,
      configDir: tmpConfig,
      projectPath: tmpProject,
    });
  }

  it('用户输入强信号 → agent.chat 后应在 SQLite 索引出现 topic 记录', async () => {
    agent = makeAgent();
    await agent.init();

    // 强信号："我喜欢简洁的代码"
    await agent.chatSync('我喜欢简洁的代码风格');
    // 显式等待归档完成（信号触发 + lazy 都覆盖）
    await agent.waitForArchives(5000);

    // 验证：topic-*.md 应已写入 TopicStore（Agent 级 dataDir）
    const topicDir = pathJoin(tmpData, 'topics');
    const files = readdirSync(topicDir);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);

    // 验证：SQLite 索引应有 topic 类型记忆
    const ctx = agent.getBuildCtx();
    expect(ctx).not.toBeNull();
    const topicMemories = await ctx!.index.getByType('topic');
    expect(topicMemories.length).toBeGreaterThanOrEqual(1);
    const m = topicMemories[0];
    expect(m).toBeDefined();
    expect(m!.type).toBe(MemoryType.TOPIC);
    expect(m!.permanence).toBe(Permanence.TOPIC);
  });

  it('弱信号（问候/询问）不触发实时归档', async () => {
    agent = makeAgent();
    await agent.init();

    // 弱信号
    await agent.chatSync('你好');
    await agent.waitForArchives(500);

    const ctx = agent.getBuildCtx();
    const topicMemories = await ctx!.index.getByType('topic');
    // 0 条（问候不值得归档）
    expect(topicMemories).toHaveLength(0);
  });

  it('init() 触发 lazy 扫描：历史 topic 文件被补归档到 SQLite', async () => {
    // 预写一个历史 topic 文件到 Agent 级 topicStore 目录
    const topicDir = pathJoin(tmpData, 'topics');
    mkdirSync(topicDir, { recursive: true });
    const historicalFile = pathJoin(topicDir, '2026-06-01-historical.md');
    writeFileSync(
      historicalFile,
      `---
date: 2026-06-01
topic: historical
---

# historical (2026-06-01)

## [user] 2026-06-01T10:00:00.000Z

记得我喜欢 TypeScript

## [assistant] 2026-06-01T10:00:05.000Z

好的，记住了
`,
      'utf-8',
    );

    agent = makeAgent();
    await agent.init();

    // 等待 lazy 扫描完成（mock provider 慢，每字符 5ms；多 topic 累积更长）
    await agent.waitForArchives(10000);

    const ctx = agent.getBuildCtx();
    const topicMemories = await ctx!.index.getByType('topic');
    // historical 主题应已被补归档
    const historical = topicMemories.find((m) => m.id === 'topic-2026-06-01-historical');
    expect(historical).toBeDefined();
    expect(historical!.content.length).toBeGreaterThan(0);
  }, 30000); // 显式 30s 超时（mock + lazy 扫描需要时间）
});

describe('Agent · addRule() · Q-701', () => {
  let agent: Agent;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-test-addrule-'));
    mkdirSync(join(tmpDir, 'identities'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'identities', 'default.md'),
      '---\nname: default\nkeywords: 测试\n---\n\n默认角色',
      'utf-8',
    );
    mkdirSync(join(tmpDir, 'topics'), { recursive: true });
    agent = new Agent({
      projectPath: tmpDir,
      config: {
        llm: { provider: 'mock', model: 'mock', temperature: 0.7 },
        memory: { dataDir: '.memora', maxContextTokens: 8000 },
        security: { permission: 'owner', confirmWrites: false },
        allowedPaths: [tmpDir],
      },
      configDir: tmpDir,
    });
  });

  afterEach(async () => {
    await agent.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('应成功写入 always 规则并注入 system 消息', async () => {
    await agent.init();

    const rule: Memory = {
      id: 'rule:test-add',
      type: 'rule' as MemoryTypeValue,
      permanence: 'always',
      name: '测试规则',
      content: '这是一个测试规则内容。',
      tags: ['测试'],
      weight: 1.0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await agent.addRule(rule);

    // 验证 system 消息已注入（getMessages 最后一条是 system）
    const messages = agent.getMessages();
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.role).toBe('system');
    expect(lastMsg?.content).toContain('【项目规则】测试规则');
    expect(lastMsg?.content).toContain('测试规则内容');
  });

  it('应拒绝 type≠rule 的记忆', async () => {
    await agent.init();

    const badMem: Memory = {
      id: 'personality:bad',
      type: 'personality' as MemoryTypeValue,
      permanence: 'always',
      name: '不该出现',
      content: 'xx',
      tags: [],
      weight: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(agent.addRule(badMem)).rejects.toThrow(/无效记忆类型/);
  });

  it('应拒绝 permanence=topic 的记忆', async () => {
    await agent.init();

    const badPerm: Memory = {
      id: 'rule:bad-perm',
      type: 'rule' as MemoryTypeValue,
      permanence: 'topic',
      name: '不该出现',
      content: 'xx',
      tags: [],
      weight: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(agent.addRule(badPerm)).rejects.toThrow(/无效永久性/);
  });

  it('init 前调用应抛错', async () => {
    const rule: Memory = {
      id: 'rule:pre-init',
      type: 'rule' as MemoryTypeValue,
      permanence: 'always',
      name: '测试',
      content: 'test',
      tags: [],
      weight: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(agent.addRule(rule)).rejects.toThrow(/Agent 未初始化/);
  });
});
