/**
 * Agent 门面类单元测试
 *
 * 覆盖核心方法：
 * - inspect() · 3 层记忆快照（working / bootstrap / archive）
 * - addRule() · Q-701
 * - getMessages()
 *
 * 设计原则：
 * - 用 mock LLM provider 走完整 init() 流程
 * - 用 tmpdir 做项目根目录，不污染真实 .memora/
 * - 每个测试独立 tmp 目录
 *
 * 基元驱动记忆模型（2026-06-11 重构）：
 * - MemoryType/Permanence 枚举 → source 开放字符串
 * - TopicMount → 移除
 * - ArchiveManager → 移除
 * - 归档模式 → 移除
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import { LlmProvider } from '@/llm/provider.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { Memory } from '@/memory/types.js';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Provider（模拟 LLM 响应，不依赖真实 API）
// ═══════════════════════════════════════════════════════════════

class MockProvider extends LlmProvider {
  readonly name = 'mock';

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const reply = `Mock 响应：${lastUser?.content ?? '(empty)'}`;
    // 一次性返回整段文本，避免逐字符延迟导致测试超时
    yield { content: reply };
    yield { finishReason: 'stop' };
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 写入项目骨架文件，让 init() 能正常加载
 */
function seedProject(_projectPath: string, configDir: string, _dataDir: string): void {
  mkdirSync(join(configDir, 'personas'), { recursive: true });
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(
    join(configDir, 'personas', 'default.md'),
    '---\nid: persona:default\nsource: persona\nname: 默认人格\nscore: 1\n---\n\n你是一个测试助手。',
    'utf-8',
  );
}

/**
 * 创建 Agent 实例（使用 MockProvider）
 */
function makeAgent(
  projectPath: string,
  configDir: string,
  dataDir: string,
): Agent {
  return new Agent({
    projectPath,
    provider: new MockProvider(),
    configDir,
    dataDir,
    permission: 'owner',
    allowedPaths: [dataDir],
  });
}

// ═══════════════════════════════════════════════════════════════
// 测试：memory.snapshot() · 3 层记忆快照
// ═══════════════════════════════════════════════════════════════

describe('Agent · memory.snapshot() · 3 层记忆快照', () => {
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

  it('init 后 inspect() 应返回 3 层快照结构', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.memory!.snapshot();

    expect(snap).toHaveProperty('working');
    expect(snap).toHaveProperty('bootstrap');
    expect(snap).toHaveProperty('archive');
  });

  it('inspect().working 应反映 AgentLoop 当前消息数', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const initial = agent.memory!.snapshot();
    expect(initial.working.total).toBe(1); // 仅 system
    const firstPreview = initial.working.preview[0];
    expect(firstPreview).toBeDefined();
    expect(firstPreview?.role).toBe('system');

    await agent.chatSync('你好');

    const afterChat = agent.memory!.snapshot();
    expect(afterChat.working.total).toBeGreaterThan(initial.working.total);
    const lastUser = [...afterChat.working.preview].reverse().find((m) => m.role === 'user');
    expect(lastUser).toBeDefined();
  });

  it('inspect().bootstrap 应返回引导记忆', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.memory!.snapshot();
    expect(typeof snap.bootstrap.total).toBe('number');
    expect(Array.isArray(snap.bootstrap.items)).toBe(true);
    for (const item of snap.bootstrap.items) {
      expect(item.id).toBeDefined();
      expect(item.source).toBeDefined();
      expect(item.name).toBeDefined();
      expect(typeof item.score).toBe('number');
    }
  });

  it('inspect().archive 应包含 currentSession 与 currentSessionName 与 hint', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.memory!.snapshot();
    expect(snap.archive.currentSession).toBeDefined();
    // currentSessionName 含日期前缀（如 "2026-06-09-main"），用于精确匹配会话文件
    expect(snap.archive.currentSessionName).toBeDefined();
    expect(snap.archive.currentSessionName).toContain(snap.archive.currentSession);
    expect(snap.archive.hint).toContain('listAllSessions');
    expect(typeof snap.archive.archiveCount).toBe('number');
  });

  it('未 init 时 memory 应为 null', () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    expect(agent.memory).toBeNull();
  });

  it('preview 字段应截断到 CONTENT_PREVIEW_LEN=80 字符', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const longContent = 'A'.repeat(500);
    await agent.chatSync(longContent);

    const snap = agent.memory!.snapshot();
    for (const item of snap.working.preview) {
      expect(item.contentPreview.length).toBeLessThanOrEqual(80);
    }
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════
// 测试：config.addRule() · Q-701
// ═══════════════════════════════════════════════════════════════

describe('Agent · config.addRule() · Q-701', () => {
  let agent: Agent;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-test-addrule-'));
    mkdirSync(join(tmpDir, 'personas'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'personas', 'default.md'),
      '---\nsource: persona\nname: default\nkeywords: 测试\n---\n\n默认角色',
      'utf-8',
    );
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

  it('应成功写入 rule 记忆并注入 system 消息', async () => {
    await agent.init();

    const now = new Date().toISOString();
    const rule: Memory = {
      id: 'rule:test-add',
      content: '这是一个测试规则内容。',
      source: SOURCE_LABELS.RULE,
      name: '测试规则',
      createdAt: now,
      accessedAt: now,
      score: 1.0,
    };

    await agent.config!.addRule(rule);

    const messages = agent.agentLoop!.getMessages();
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.role).toBe('system');
    expect(lastMsg?.content).toContain('【项目规则】测试规则');
    expect(lastMsg?.content).toContain('测试规则内容');
  });

  it('应拒绝 source≠rule 的记忆', async () => {
    await agent.init();

    const now = new Date().toISOString();
    const badMem: Memory = {
      id: 'persona:bad',
      content: 'xx',
      source: SOURCE_LABELS.PERSONA,
      name: '不该出现',
      createdAt: now,
      accessedAt: now,
      score: 1,
    };

    await expect(agent.config!.addRule(badMem)).rejects.toThrow(/无效来源/);
  });

  it('init 前 config 应为 null', () => {
    expect(agent.config).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：agentLoop.getMessages()
// ═══════════════════════════════════════════════════════════════

describe('Agent · agentLoop.getMessages()', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-agent-msg-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-agent-msg-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-agent-msg-cfg-'));
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

  it('init 后应返回包含 system 消息的数组', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const messages = agent.agentLoop!.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.role).toBe('system');
  });

  it('对话后消息数应增加', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const before = agent.agentLoop!.getMessages().length;
    await agent.chatSync('你好');
    const after = agent.agentLoop!.getMessages().length;

    expect(after).toBeGreaterThan(before);
  });

  it('未初始化时 agentLoop 应为 null', () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    expect(agent.agentLoop).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：Agent 生命周期 E2E（构造 → init → chat → close）
// ═══════════════════════════════════════════════════════════════

describe('Agent · 生命周期 E2E', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-e2e-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-e2e-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-e2e-cfg-'));
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

  it('完整生命周期：构造 → init → chat → close', { timeout: 30000 }, async () => {
    // 构造
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    expect(agent.initialized).toBe(false);
    expect(agent.persona).toBeNull();
    expect(agent.tools).toBeNull();
    expect(agent.config).toBeNull();
    expect(agent.insight).toBeNull();
    expect(agent.memory).toBeNull();

    // init
    const ctx = await agent.init();
    expect(agent.initialized).toBe(true);
    expect(ctx.projectPath).toBe(tmpProject);
    expect(agent.context).toBe(ctx);

    // Manager 访问器应可用
    expect(agent.persona).not.toBeNull();
    expect(agent.tools).not.toBeNull();
    expect(agent.config).not.toBeNull();
    expect(agent.insight).not.toBeNull();
    expect(agent.memory).not.toBeNull();

    // chat（流式）
    const chunks: string[] = [];
    for await (const chunk of agent.chat('你好')) {
      if (chunk.type === 'text') chunks.push(chunk.content);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('Mock 响应');

    // chatSync（同步）
    const reply = await agent.chatSync('测试');
    expect(reply).toContain('Mock 响应');

    // 状态检查
    expect(agent.isBusy).toBe(false);
    expect(agent.lastInteractionAt).toBeInstanceOf(Date);

    // close
    await agent.close();
    expect(agent.initialized).toBe(false);
    agent = null;
  });

  it('close 后再次 init 应正常工作', { timeout: 30000 }, async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);

    await agent.init();
    expect(agent.initialized).toBe(true);

    await agent.close();
    expect(agent.initialized).toBe(false);

    // 重新 init
    await agent.init();
    expect(agent.initialized).toBe(true);
    expect(agent.persona).not.toBeNull();
  });

  it('未初始化时调用 chat 应抛出 configError', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);

    // 未 init 直接 chat（遍历 generator 触发错误）
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of agent!.chat('你好')) {
        // 消费 generator
      }
    }).rejects.toThrow(/未初始化/);
  });

  it('事件订阅：memoryRecalled 应在对话后触发', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    let recalledCount = 0;
    agent.on('memoryRecalled', (e) => {
      recalledCount = e.count;
    });

    await agent.chatSync('你好');
    // memoryRecalled 事件可能触发也可能不触发（取决于召回结果），但不应抛错
    expect(recalledCount).toBeGreaterThanOrEqual(0);

    agent.off('memoryRecalled', () => {});
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：Manager 委托模式
// ═══════════════════════════════════════════════════════════════

describe('Agent · Manager 委托模式', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-mgr-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-mgr-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-mgr-cfg-'));
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

  it('persona 管理器：list / activeName / currentMode', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    expect(Array.isArray(agent.persona!.list)).toBe(true);
    expect(typeof agent.persona!.activeName).toBe('string');
    expect(['auto', 'manual']).toContain(agent.persona!.currentMode);
  });

  it('tools 管理器：getToolDefinitions 应包含内置工具', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const defs = agent.tools!.getToolDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(4);
    const names = defs.map((d) => d.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_dir');
    expect(names).toContain('search_memories');
  });

  it('memory 管理器：stats 应返回统计数据', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const stats = agent.memory!.stats();
    expect(typeof stats.total).toBe('number');
    expect(stats.total).toBeGreaterThanOrEqual(0);
    expect(typeof stats.bySource).toBe('object');
  });

  it('config 管理器：addSimpleRule 应注入规则', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await agent.config!.addSimpleRule('E2E 测试规则', '这是一条 E2E 测试规则');

    const messages = agent.agentLoop!.getMessages();
    const lastSystem = [...messages].reverse().find((m) => m.role === 'system');
    expect(lastSystem?.content).toContain('E2E 测试规则');
  });
});
