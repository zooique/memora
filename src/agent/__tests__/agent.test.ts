/**
 * Agent 门面类单元测试
 *
 * 覆盖核心方法：
 * - inspect() · 4 层记忆快照（working / bootstrap / archive / mounted）
 * - 实时归档（Signal 触发 + Lazy 扫描）
 * - addRule() · Q-701
 * - 归档模式（ArchiveMode）
 *
 * 设计原则：
 * - 用 mock LLM provider 走完整 init() 流程
 * - 用 tmpdir 做项目根目录，不污染真实 .memora/
 * - 每个测试独立 tmp 目录
 *
 * 架构重构（v2.0）：Agent 不再接收 Config 对象，只接收 LlmProvider 实例。
 * 测试中直接创建 MockProvider 传给 Agent。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import { LlmProvider } from '@/llm/provider.js';
import { MemoryType, Permanence } from '@/memory/types.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { Memory, MemoryTypeValue } from '@/memory/types.js';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Provider（模拟 LLM 响应，不依赖真实 API）
// ═══════════════════════════════════════════════════════════════

class MockProvider extends LlmProvider {
  readonly name = 'mock';

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const reply = `Mock 响应：${lastUser?.content ?? '(empty)'}`;
    for (const char of reply) {
      yield { content: char };
      await new Promise((r) => setTimeout(r, 5));
    }
    yield { finishReason: 'stop' };
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 写入项目骨架文件，让 init() 能正常加载
 *
 * 注意：memora.db 和 TopicStore 是 Agent 级共享资源（单 Agent 模型），
 * TopicStore 使用 dataDir（agentDataDir），而非 projectPath/.memora/。
 * personality/rules/skills/tools 写到 configDir 下（两层加载中的 Agent 层）。
 */
function seedProject(_projectPath: string, configDir: string, dataDir: string): void {
  mkdirSync(join(dataDir, 'topics'), { recursive: true });
  mkdirSync(join(configDir, 'personas'), { recursive: true });
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(
    join(configDir, 'personas', 'default.md'),
    '---\nid: default-personality\ntype: personality\npermanence: always\nname: 默认人格\nweight: 1\n---\n\n你是一个测试助手。',
    'utf-8',
  );
}

/**
 * 创建 Agent 实例（使用 MockProvider，不依赖 Config 类型）
 */
function makeAgent(
  projectPath: string,
  configDir: string,
  dataDir: string,
  archiveMode?: 'full' | 'insights-only' | 'manual',
): Agent {
  return new Agent({
    projectPath,
    provider: new MockProvider(),
    configDir,
    dataDir,
    archiveMode,
    permission: 'owner',
    allowedPaths: [dataDir],
  });
}

// ═══════════════════════════════════════════════════════════════
// 测试：inspect() · 4 层记忆快照
// ═══════════════════════════════════════════════════════════════

describe('Agent · inspect() · 4 层记忆快照', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-agent-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-agent-proj-'));
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

  it('init 后 inspect() 应返回 4 层快照结构', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.inspect();

    expect(snap).toHaveProperty('working');
    expect(snap).toHaveProperty('bootstrap');
    expect(snap).toHaveProperty('archive');
    expect(snap).toHaveProperty('mounted');
  });

  it('inspect().working 应反映 AgentLoop 当前消息数', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const initial = agent.inspect();
    expect(initial.working.total).toBe(1); // 仅 system
    const firstPreview = initial.working.preview[0];
    expect(firstPreview).toBeDefined();
    expect(firstPreview?.role).toBe('system');

    await agent.chatSync('你好');

    const afterChat = agent.inspect();
    expect(afterChat.working.total).toBeGreaterThan(initial.working.total);
    const lastUser = [...afterChat.working.preview].reverse().find((m) => m.role === 'user');
    expect(lastUser).toBeDefined();
  });

  it('inspect().bootstrap 应返回引导记忆', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.inspect();
    expect(typeof snap.bootstrap.total).toBe('number');
    expect(Array.isArray(snap.bootstrap.items)).toBe(true);
    for (const item of snap.bootstrap.items) {
      expect(item.id).toBeDefined();
      expect(item.type).toBeDefined();
      expect(item.permanence).toBeDefined();
      expect(item.name).toBeDefined();
      expect(typeof item.weight).toBe('number');
    }
  });

  it('inspect().archive 应包含 currentTopic 与 currentTopicName 与 hint', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.inspect();
    expect(snap.archive.currentTopic).toBeDefined();
    // currentTopicName 含日期前缀（如 "2026-06-09-main"），用于精确匹配话题文件
    expect(snap.archive.currentTopicName).toBeDefined();
    expect(snap.archive.currentTopicName).toContain(snap.archive.currentTopic);
    expect(snap.archive.hint).toContain('listAllTopics');
    expect(typeof snap.archive.topicFilesCount).toBe('number');
  });

  it('inspect().mounted 初始应未挂载', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.inspect();
    expect(snap.mounted.total).toBe(0);
    expect(snap.mounted.isMounted).toBe(false);
    expect(snap.mounted.items).toHaveLength(0);
  });

  it('chatSync 触发 TopicMount.focus() 后 inspect().mounted 应有变化', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const before = agent.inspect();
    expect(before.mounted.total).toBe(0);

    await agent.chatSync('写一段测试对话');

    const after = agent.inspect();
    expect(after.mounted).toHaveProperty('total');
    expect(after.mounted).toHaveProperty('isMounted');
    expect(after.mounted).toHaveProperty('items');
  });

  it('inspect() 在未 init 时应抛错', () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    expect(() => agent!.inspect()).toThrow(/未初始化/);
  });

  it('preview 字段应截断到 CONTENT_PREVIEW_LEN=80 字符', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const longContent = 'A'.repeat(500);
    await agent.chatSync(longContent);

    const snap = agent.inspect();
    for (const item of snap.working.preview) {
      expect(item.contentPreview.length).toBeLessThanOrEqual(80);
    }
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════
// 测试：实时归档（Signal 触发 + Lazy 扫描）
// ═══════════════════════════════════════════════════════════════

describe('Agent · 实时归档（Signal 触发 + Lazy 扫描）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-agent-signal-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-agent-signal-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-agent-signal-cfg-'));
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

  it('用户输入强信号 → agent.chat 后应在 SQLite 索引出现 topic 记录', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await agent.chatSync('我喜欢简洁的代码风格');
    await agent.waitForArchives(5000);

    const topicDir = join(tmpData, 'topics');
    const files = readdirSync(topicDir);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);

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
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await agent.chatSync('你好');
    await agent.waitForArchives(500);

    const ctx = agent.getBuildCtx();
    const topicMemories = await ctx!.index.getByType('topic');
    expect(topicMemories).toHaveLength(0);
  });

  it('init() 触发 lazy 扫描：历史 topic 文件被补归档到 SQLite', async () => {
    const topicDir = join(tmpData, 'topics');
    mkdirSync(topicDir, { recursive: true });
    const historicalFile = join(topicDir, '2026-06-01-historical.md');
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

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await agent.waitForArchives(10000);

    const ctx = agent.getBuildCtx();
    const topicMemories = await ctx!.index.getByType('topic');
    const historical = topicMemories.find((m) => m.id === 'topic-2026-06-01-historical');
    expect(historical).toBeDefined();
    expect(historical!.content.length).toBeGreaterThan(0);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════
// 测试：addRule() · Q-701
// ═══════════════════════════════════════════════════════════════

describe('Agent · addRule() · Q-701', () => {
  let agent: Agent;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-test-addrule-'));
    mkdirSync(join(tmpDir, 'personas'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'personas', 'default.md'),
      '---\nname: default\nkeywords: 测试\n---\n\n默认角色',
      'utf-8',
    );
    mkdirSync(join(tmpDir, 'topics'), { recursive: true });
    agent = new Agent({
      projectPath: tmpDir,
      provider: new MockProvider(),
      configDir: tmpDir,
      dataDir: '.memora',
      allowedPaths: [tmpDir],
      permission: 'owner',
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

// ═══════════════════════════════════════════════════════════════
// 测试：归档模式（ArchiveMode）
// ═══════════════════════════════════════════════════════════════

describe('Agent · 归档模式（ArchiveMode）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-archive-mode-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-archive-mode-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-archive-mode-cfg-'));
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

  it('默认 archiveMode 为 full', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    expect(agent.getArchiveMode()).toBe('full');
  });

  it('构造时指定 archiveMode=insights-only 应生效', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'insights-only');
    await agent.init();
    expect(agent.getArchiveMode()).toBe('insights-only');
  });

  it('setArchiveMode() 可运行时切换', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    expect(agent.getArchiveMode()).toBe('full');

    agent.setArchiveMode('insights-only');
    expect(agent.getArchiveMode()).toBe('insights-only');

    agent.setArchiveMode('manual');
    expect(agent.getArchiveMode()).toBe('manual');
  });

  it('insights-only 模式下强信号不触发话题归档', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'insights-only');
    await agent.init();

    await agent.chatSync('我喜欢简洁的代码风格');
    await agent.waitForArchives(3000);

    const ctx = agent.getBuildCtx();
    const topicMemories = await ctx!.index.getByType('topic');
    expect(topicMemories).toHaveLength(0);
  });

  it('insights-only 模式下用户画像仍自动归档', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'insights-only');
    await agent.init();

    await agent.chatSync('我叫张三');
    await agent.waitForArchives(3000);

    const ctx = agent.getBuildCtx();
    const personalityMemories = await ctx!.index.getByType('personality');
    const profile = personalityMemories.find((m) => m.content.includes('张三'));
    expect(profile).toBeDefined();
  });

  it('archiveApprovedContent() 手动归档定稿内容', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'insights-only');
    await agent.init();

    await agent.chatSync('帮我写一段开头');
    await agent.chatSync('再改一下情绪');
    await agent.waitForArchives(3000);

    const ctx = agent.getBuildCtx();
    const beforeArchive = await ctx!.index.getByType('topic');
    expect(beforeArchive).toHaveLength(0);

    await agent.archiveApprovedContent('主角深夜回到老宅，发现书房的灯亮着...');
    await agent.waitForArchives(5000);

    const afterArchive = await ctx!.index.getByType('topic');
    expect(afterArchive.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('manual 模式下所有自动归档都跳过', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'manual');
    await agent.init();

    await agent.chatSync('我喜欢TypeScript');
    await agent.chatSync('再聊聊');
    await agent.chatSync('第三轮了');
    await agent.waitForArchives(3000);

    const ctx = agent.getBuildCtx();
    const topicMemories = await ctx!.index.getByType('topic');
    expect(topicMemories).toHaveLength(0);
  });

  it('archiveApprovedContent() 在未初始化时抛错', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'insights-only');
    await expect(agent.archiveApprovedContent('test')).rejects.toThrow(/Agent 未初始化/);
  });
});
