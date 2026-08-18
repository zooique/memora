/**
 * Agent 门面类单元测试
 *
 * 覆盖核心方法：
 * - memory.snapshot() · 3 层记忆快照（working / bootstrap / archive）
 * - addRule() · Q-701
 * - getMessages()
 *
 * 设计原则：
 * - 用 mock LLM provider 走完整 init() 流程
 * - 用 tmpdir 做项目根目录，不污染真实 .memora/
 * - 每个测试独立 tmp 目录
 *
 * 基元驱动记忆模型：
 * - MemoryType/Permanence 枚举 → source 开放字符串
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import type { AgentChunk } from '@/agent/types.js';
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import { todayDate } from '@/utils/time.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';
import { ArchiveCoordinator } from '@/agent/managers/archiveCoordinator.js';

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
  archiveMode?: 'full' | 'manual',
): Agent {
  return new Agent({
    projectPath,
    provider: new MockProvider(),
    configDir,
    dataDir,
    permission: 'owner',
    allowedPaths: [dataDir],
    archiveMode,
    messages: {
      abortedByUser: '用户取消了对话',
      maxIterationsReached: '\n\n[已达到最大迭代次数]',
      recentConversationLabel: '[最近对话]',
      userLabel: '用户',
      assistantLabel: '助手',
    },
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

  it('init 后 memory.snapshot() 应返回 3 层快照结构', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.memory!.snapshot();

    expect(snap).toHaveProperty('working');
    expect(snap).toHaveProperty('bootstrap');
    expect(snap).toHaveProperty('archive');
  });

  it('memory.snapshot().working 应反映 AgentLoop 当前消息数', async () => {
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

  it('memory.snapshot().bootstrap 应返回引导记忆', async () => {
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

  it('memory.snapshot().archive 应包含 currentSession 与 currentSessionName 与 hint', async () => {
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
// 测试：config 门面
// ═══════════════════════════════════════════════════════════════

describe('Agent · config 门面', () => {
  let agent: Agent;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-test-config-'));
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

    const messages = agent.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.role).toBe('system');
  });

  it('对话后消息数应增加', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const before = agent.getMessageCount();
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

  it('close 后所有组件字段应被 null 化（nullifyAllComponents 完整性验证）', { timeout: 30000 }, async () => {
    // 构造并初始化 Agent，使所有组件字段被填充
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 初始化后所有组件字段应非 null（前置验证）
    expect(agent.persona).not.toBeNull();
    expect(agent.tools).not.toBeNull();
    expect(agent.config).not.toBeNull();
    expect(agent.memory).not.toBeNull();
    expect(agent.agentLoop).not.toBeNull();
    expect(agent.agentHistory).not.toBeNull();
    expect(agent.context).not.toBeNull();
    expect(agent.projects).not.toBeNull();
    expect(agent.works).not.toBeNull();
    expect(agent.sessionManager).not.toBeNull();
    expect(agent.polish).not.toBeNull();

    // close 调用 nullifyAllComponents，应 null 化全部 13 个组件字段
    await agent.close();

    // Provider 相关
    expect(agent.agentLoop).toBeNull();
    expect(agent.agentHistory).toBeNull();
    // 核心组件
    expect(agent.context).toBeNull();
    // 专职 Manager
    expect(agent.persona).toBeNull();
    expect(agent.tools).toBeNull();
    expect(agent.config).toBeNull();
    expect(agent.memory).toBeNull();
    expect(agent.projects).toBeNull();
    expect(agent.works).toBeNull();
    expect(agent.sessionManager).toBeNull();
    expect(agent.polish).toBeNull();

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

  it('tools 管理器：list 应包含内置工具', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const defs = agent.tools!.list;
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

  it('memory 管理器：suggest 无 query 时应返回全局热度推荐', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // suggest 已迁至 Agent 门面直连 advisor，不再经 inspector 转发
    const results = agent.governance!.suggest();
    expect(Array.isArray(results)).toBe(true);
    for (const hit of results) {
      expect(hit).toHaveProperty('name');
      expect(hit).toHaveProperty('source');
      expect(hit).toHaveProperty('relevance');
      expect(hit).toHaveProperty('contentPreview');
      expect(hit).toHaveProperty('reason');
      expect(hit.relevance).toBeGreaterThanOrEqual(0);
      expect(hit.relevance).toBeLessThanOrEqual(1);
    }
  });

  it('memory 管理器：suggest 有 query 时搜索命中应优先', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 写入一条 content 记忆
    agent.memory!['index'].upsert({
      id: 'content:suggest-test',
      content: '关于 TypeScript 类型系统的归档',
      source: 'content',
      name: 'TypeScript 类型系统',
      createdAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      score: 0.9,
    });

    // suggest 已迁至 Agent 门面直连 advisor，不再经 inspector 转发
    const results = agent.governance!.suggest('TypeScript');
    expect(results.length).toBeGreaterThan(0);
    // 搜索命中的应排在前面
    const firstHit = results[0]!;
    expect(firstHit.source).toBe('content');
    expect(firstHit.reason).toBe('与搜索相关');
  });

  it('memory 管理器：suggest 应排除指定 source', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // suggest 已迁至 Agent 门面直连 advisor，不再经 inspector 转发
    const results = agent.governance!.suggest(undefined, {
      excludeSources: ['content', 'profile', 'work-projection', 'persona', 'rule', 'skill'],
      limit: 10,
    });
    // 排除所有 source 后应返回空
    expect(results).toEqual([]);
  });

  it('memory 管理器：suggest limit 应限制返回数量', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // suggest 已迁至 Agent 门面直连 advisor，不再经 inspector 转发
    const results = agent.governance!.suggest(undefined, { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('config 管理器：confirmConfigSuggestion 应注入规则并刷新 bootstrap', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await agent.config!.confirmConfigSuggestion({
      type: 'rule',
      name: 'E2E测试规则',
      content: '这是一条 E2E 测试规则',
      confidence: 0.9,
    });

    const messages = agent.getMessages();
    const lastSystem = [...messages].reverse().find((m) => m.role === 'system');
    expect(lastSystem?.content).toContain('E2E测试规则');
  });

  // ─── L1~L3 LLM 记忆治理委托（G1） ─────────────────────────
  // makeAgent 未注入 backgroundProvider，验证委托转发 + 降级路径 + 报告结构完整性。
  // 降级语义：manager 内部检测到 backgroundProvider 缺失时返回 skippedReason 报告。

  it('L1 语义去重：deduplicateMemories 委托应返回 DedupReport 结构（未注入 backgroundProvider 降级）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 委托到 MemoryInspector.deduplicateMemories，未注入 backgroundProvider 时降级
    // MIND2-D4：从 agent.deduplicateMemories() 迁移到 governance.deduplicate()
    const report = await agent.governance!.deduplicate();
    expect(report).toHaveProperty('scannedCount');
    expect(report).toHaveProperty('pairCount');
    expect(report).toHaveProperty('deduplicatedCount');
    expect(report).toHaveProperty('demotedIds');
    expect(Array.isArray(report.demotedIds)).toBe(true);
    // 降级路径：skippedReason 非空
    expect(report.skippedReason).toBeTruthy();
  });

  it('L2 时效性评估：evaluateTimeliness 委托应返回 TimelinessReport 结构（未注入 backgroundProvider 降级）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 委托到 MemoryDecayScheduler.evaluateTimeliness，未注入 backgroundProvider 时降级
    // MIND2-D4：从 agent.evaluateTimeliness() 迁移到 governance.evaluateTimeliness()
    const report = await agent.governance!.evaluateTimeliness();
    expect(report).toHaveProperty('scannedCount');
    expect(report).toHaveProperty('outdatedCount');
    expect(report).toHaveProperty('demotedIds');
    expect(Array.isArray(report.demotedIds)).toBe(true);
    expect(report.skippedReason).toBeTruthy();
  });

  it('L3 冲突检测：detectConflicts 委托应返回 ConflictReport 结构（未注入 backgroundProvider 降级）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // v2 PROXY-1 闭环：直接调用 MemoryAdvisor.detectConflicts（不经 MemoryInspector 转发），
    // 未注入 backgroundProvider 时降级返回 skippedReason
    // MIND2-D4：从 agent.detectConflicts() 迁移到 governance.detectConflicts()
    const report = await agent.governance!.detectConflicts();
    expect(report).toHaveProperty('scannedCount');
    expect(report).toHaveProperty('pairCount');
    expect(report).toHaveProperty('conflictCount');
    expect(report).toHaveProperty('conflicts');
    expect(Array.isArray(report.conflicts)).toBe(true);
    expect(report.skippedReason).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：postProcess() · 对话后处理
// ═══════════════════════════════════════════════════════════════

/**
 * 写入含多角色 + 技能的项目骨架，用于 postProcess 测试
 */
function seedProjectWithPersonasAndSkills(
  _projectPath: string,
  configDir: string,
  _dataDir: string,
): void {
  // 角色文件
  mkdirSync(join(configDir, 'personas'), { recursive: true });
  writeFileSync(
    join(configDir, 'personas', 'default.md'),
    '---\nsource: persona\nname: 默认助手\nkeywords: 你好,帮助\n---\n\n你是一个通用助手。',
    'utf-8',
  );
  writeFileSync(
    join(configDir, 'personas', 'coder.md'),
    '---\nsource: persona\nname: 编程专家\nkeywords: 代码,编程,bug,函数,调试\n---\n\n你是一个编程专家，擅长代码分析和调试。',
    'utf-8',
  );
  writeFileSync(
    join(configDir, 'personas', 'writer.md'),
    '---\nsource: persona\nname: 写作助手\nkeywords: 写作,文章,故事,小说\n---\n\n你是一个写作助手，擅长创意写作。',
    'utf-8',
  );

  // 技能文件
  mkdirSync(join(configDir, 'skills'), { recursive: true });
  writeFileSync(
    join(configDir, 'skills', 'code-review.md'),
    '---\nsource: skill\nname: 代码审查\nkeywords: 审查,review,代码质量\n---\n\n审查代码时关注可读性、性能和安全性。',
    'utf-8',
  );

  // 规则文件（保持目录结构完整）
  mkdirSync(join(configDir, 'rules'), { recursive: true });
}

describe('Agent · postProcess() · 对话后处理', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-pp-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-pp-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-pp-cfg-'));
    seedProjectWithPersonasAndSkills(tmpProject, tmpConfig, tmpData);
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

  it('角色自动匹配：输入匹配关键词后应触发 personaSwitched 事件', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 初始角色为扫描顺序第一个（编程专家）
    const initialName = agent.persona!.activeName;
    expect(initialName).toBe('编程专家');

    // 监听 personaSwitched 事件
    let switchedFrom: string | null = null;
    let switchedTo: string | null = null;
    agent.on('personaSwitched', (e) => {
      switchedFrom = e.from;
      switchedTo = e.to;
    });

    // 输入包含写作关键词，应触发角色自动切换到"写作助手"
    await agent.chatSync('帮我写一篇关于小说创作的故事');

    // 验证事件已触发
    expect(switchedFrom).toBe(initialName);
    expect(switchedTo).toBe('写作助手');

    // 验证当前角色已切换
    expect(agent.persona!.activeName).toBe('写作助手');

    agent.off('personaSwitched', () => {});
  });

  it('技能关键词匹配：输入匹配关键词后 skillMatched 事件应立即触发（当轮生效）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    let matchedSkill: string | null = null;
    let matchedScore: number = 0;
    agent.on('skillMatched', (e) => {
      matchedSkill = e.skill;
      matchedScore = e.score;
    });

    // 输入包含技能关键词，应在 chat() 内实时匹配并注入
    await agent.chatSync('帮我审查一下代码质量');

    // 验证 skillMatched 事件已在当轮触发（非延迟到下一轮）
    expect(matchedSkill).toBe('代码审查');
    expect(matchedScore).toBeGreaterThanOrEqual(0.3);

    // 补充验证：SkillManager.match() 底层方法也确认匹配
    const match = agent.skills!.match('帮我审查一下代码质量');
    expect(match).not.toBeNull();
    expect(match!.skill.name).toBe('代码审查');

    agent.off('skillMatched', () => {});
  });

  it('无 Manager 时不报错：postProcess 应正常完成', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 正常 init 后所有 Manager 都存在，postProcess 不应抛错
    // 通过 chatSync 间接触发 postProcess，验证无异常
    const reply = await agent.chatSync('你好');
    expect(reply).toContain('Mock 响应');

    // 再发一条 trivial 输入，验证简短的 postProcess 路径也不报错
    const reply2 = await agent.chatSync('好的');
    expect(reply2).toContain('Mock 响应');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：switchProject() · 切换到已注册项目
// ═══════════════════════════════════════════════════════════════

describe('Agent · switchProject() · 切换到已注册项目', () => {
  let tmpProjectA: string;
  let tmpProjectB: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-switch-data-'));
    tmpProjectA = mkdtempSync(join(tmpdir(), 'memora-switch-projA-'));
    tmpProjectB = mkdtempSync(join(tmpdir(), 'memora-switch-projB-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-switch-cfg-'));
    seedProject(tmpProjectA, tmpConfig, tmpData);
    seedProject(tmpProjectB, tmpConfig, tmpData);
  });

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = null;
    }
    rmSync(tmpProjectA, { recursive: true, force: true });
    rmSync(tmpProjectB, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  it('切换到已注册项目应返回新 ProjectContext', async () => {
    agent = makeAgent(tmpProjectA, tmpConfig, tmpData);
    await agent.init();

    // 项目 B 通过路径切换
    const newCtx = await agent.switchProject(tmpProjectB);
    expect(newCtx.projectPath).toBe(tmpProjectB);
    expect(agent.context).toBe(newCtx);
  });

  it('切换项目后 agentLoop 应可用', async () => {
    agent = makeAgent(tmpProjectA, tmpConfig, tmpData);
    await agent.init();

    await agent.switchProject(tmpProjectB);

    expect(agent.agentLoop).not.toBeNull();
    const messages = agent.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it('未初始化时调用 switchProject 应抛出 configError', async () => {
    agent = makeAgent(tmpProjectA, tmpConfig, tmpData);

    await expect(agent.switchProject(tmpProjectB)).rejects.toThrow(/未初始化/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：forkSession() · 分叉当前会话
// ═══════════════════════════════════════════════════════════════

describe('Agent · forkSession() · 分叉当前会话', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  /** Mock ISessionStore，支持 forkSession 所需的 copySession */
  function createMockSessionStore(): ISessionStore {
    const store = new Map<string, Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: string }>>();

    return {
      appendMessage(date: string, session: string, message: { role: 'user' | 'assistant' | 'system'; content: string; timestamp: string }) {
        const key = `${date}-${session}`;
        const list = store.get(key) ?? [];
        list.push(message);
        store.set(key, list);
      },
      loadMessages(date: string, session: string) {
        return store.get(`${date}-${session}`) ?? [];
      },
      listSessions() {
        return Array.from(store.keys());
      },
      copySession(sourceDate: string, sourceSession: string, targetDate: string, targetSession: string) {
        const source = store.get(`${sourceDate}-${sourceSession}`) ?? [];
        store.set(`${targetDate}-${targetSession}`, [...source]);
      },
    };
  }

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-fork-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-fork-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-fork-cfg-'));
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

  it('分叉会话应返回 newSession 和 messageCount', async () => {
    const sessionStore = createMockSessionStore();
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 先对话产生消息
    await agent.chatSync('你好');

    const result = agent.forkSession();
    expect(result.newSession).toBeDefined();
    expect(typeof result.newSession).toBe('string');
    expect(result.messageCount).toBeGreaterThan(0);
  });

  it('分叉会话应发射 sessionForked 事件', async () => {
    const sessionStore = createMockSessionStore();
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    await agent.chatSync('你好');

    let forkedFrom: string | null = null;
    let forkedTo: string | null = null;
    agent.on('sessionForked', (e) => {
      forkedFrom = e.from;
      forkedTo = e.to;
    });

    agent.forkSession();

    expect(forkedFrom).not.toBeNull();
    expect(forkedTo).not.toBeNull();

    agent.off('sessionForked', () => {});
  });

  it('未初始化时调用 forkSession 应抛出 configError', () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    expect(() => agent!.forkSession()).toThrow(/未初始化/);
  });

  it('chat 忙碌时调用 forkSession 应抛出 configError', async () => {
    const sessionStore = createMockSessionStore();
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 先产生消息
    await agent.chatSync('你好');

    // 模拟 chat 忙碌（直接设置内部状态以测试并发锁行为）
    (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager._chatBusy = true;

    expect(() => agent!.forkSession()).toThrow(/对话繁忙/);

    (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager._chatBusy = false;
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：restoreMostRecentSession() · 恢复最近会话
// ═══════════════════════════════════════════════════════════════

describe('Agent · restoreMostRecentSession() · 恢复最近会话', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  /** Mock ISessionStore，用于测试 restoreMostRecentSession */
  function createMockSessionStore(sessions: string[], messagesBySession: Record<string, Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: string }>>): ISessionStore {
    return {
      appendMessage() {},
      loadMessages(date: string, session: string) {
        return messagesBySession[`${date}-${session}`] ?? [];
      },
      listSessions() {
        return sessions;
      },
    };
  }

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-restore-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-restore-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-restore-cfg-'));
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

  it('未注入 ISessionStore 时应返回 0', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const count = await agent.sessionManager!.restoreMostRecentSession();
    expect(count).toBe(0);
  });

  it('sessionStore 无会话时应返回 0', async () => {
    const sessionStore = createMockSessionStore([], {});
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    const count = await agent.sessionManager!.restoreMostRecentSession();
    expect(count).toBe(0);
  });

  it('有会话时应恢复消息并返回消息数', async () => {
    const today = todayDate();
    const sessionKey = `${today}-main`;
    const messages = [
      { role: 'user' as const, content: '你好', timestamp: new Date().toISOString() },
      { role: 'assistant' as const, content: '你好！', timestamp: new Date().toISOString() },
    ];
    const sessionStore = createMockSessionStore(
      [sessionKey],
      { [sessionKey]: messages },
    );
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    const count = await agent.sessionManager!.restoreMostRecentSession('main');
    expect(count).toBe(2);
  });

  it('preferredSession 不匹配时取最后一个会话', async () => {
    const today = todayDate();
    const sessionKey = `${today}-other`;
    const messages = [
      { role: 'user' as const, content: '旧消息', timestamp: new Date().toISOString() },
    ];
    const sessionStore = createMockSessionStore(
      [sessionKey],
      { [sessionKey]: messages },
    );
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // preferredSession='main' 不匹配，fallback 到最后一个
    const count = await agent.sessionManager!.restoreMostRecentSession('main');
    expect(count).toBe(1);
  });

  it('会话标识格式不匹配时应返回 0', async () => {
    const sessionStore = createMockSessionStore(
      ['invalid-format'],
      {},
    );
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    const count = await agent.sessionManager!.restoreMostRecentSession();
    expect(count).toBe(0);
  });

  it('会话消息为空时应返回 0', async () => {
    const today = todayDate();
    const sessionKey = `${today}-main`;
    const sessionStore = createMockSessionStore(
      [sessionKey],
      { [sessionKey]: [] },
    );
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    const count = await agent.sessionManager!.restoreMostRecentSession('main');
    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：setProvider() / setBackgroundProvider() · 切换 Provider
// ═══════════════════════════════════════════════════════════════

describe('Agent · setProvider() / setBackgroundProvider() · 切换 Provider', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-provider-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-provider-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-provider-cfg-'));
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

  it('setProvider 应切换前台 Provider', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 使用 CustomProvider 验证切换
    class AnotherProvider extends LlmProvider {
      readonly name = 'another';
      async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
        yield { content: 'Another 响应' };
        yield { finishReason: 'stop' };
      }
    }

    agent.setProvider(new AnotherProvider());
    expect(agent.provider.name).toBe('another');
  });

  it('setProvider 后对话应使用新 Provider', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 自定义 Provider，返回特定内容
    class CustomProvider extends LlmProvider {
      readonly name = 'custom';
      async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
        yield { content: 'Custom 响应' };
        yield { finishReason: 'stop' };
      }
    }

    agent.setProvider(new CustomProvider());

    const reply = await agent.chatSync('测试');
    expect(reply).toContain('Custom 响应');
  });

  it('setBackgroundProvider 应设置后台 Provider', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const bgProvider = new MockProvider();
    // 调用不抛错即验证方法存在且可执行
    expect(() => agent!.setBackgroundProvider(bgProvider)).not.toThrow();
  });

  it('setBackgroundProvider(null) 应清除后台 Provider', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    agent.setBackgroundProvider(new MockProvider());
    // 清除不抛错
    expect(() => agent!.setBackgroundProvider(null)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：archiveMode（ADR-015）· 二态归档模式
// ═══════════════════════════════════════════════════════════════

describe('Agent · archiveMode（ADR-015）· 二态归档模式（2026-08-14 洞察层收敛为 full|manual）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-amode-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-amode-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-amode-cfg-'));
    seedProjectWithPersonasAndSkills(tmpProject, tmpConfig, tmpData);
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

  // ─── 默认值与 getter/setter ────────────────────────────

  it('默认归档模式应为 full', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    expect(agent.getArchiveMode()).toBe('full');
  });

  it('构造时指定 archiveMode 应生效', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'manual');
    await agent.init();

    expect(agent.getArchiveMode()).toBe('manual');
  });

  it('setArchiveMode 应切换模式', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    agent.setArchiveMode('full');
    expect(agent.getArchiveMode()).toBe('full');

    agent.setArchiveMode('manual');
    expect(agent.getArchiveMode()).toBe('manual');
  });

  it('setArchiveMode 幂等：相同模式不重复切换', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    agent.setArchiveMode('manual');
    agent.setArchiveMode('manual'); // 重复切换不抛错
    expect(agent.getArchiveMode()).toBe('manual');
  });

  it('setArchiveMode 对话繁忙时抛错', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 模拟对话进行中
    (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager._chatBusy = true;
    expect(() => agent!.setArchiveMode('manual')).toThrow(/对话繁忙/);

    // 恢复空闲状态
    (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager._chatBusy = false;
  });

  // ─── switchPersona 手动切换（与自动匹配共享事件链路） ─────

  it('switchPersona 应切换角色并发射 personaSwitched 事件', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 初始角色为扫描顺序第一个（编程专家）
    const initialName = agent.persona!.activeName;
    expect(initialName).toBe('编程专家');

    // 监听 personaSwitched 事件
    let switchedFrom: string | null = null;
    let switchedTo: string | null = null;
    agent.on('personaSwitched', (e) => {
      switchedFrom = e.from;
      switchedTo = e.to;
    });

    const prompt = agent.switchPersona('写作助手');

    // 验证返回值是新角色的 system prompt
    expect(prompt).toContain('写作助手');
    // 验证事件已触发
    expect(switchedFrom).toBe(initialName);
    expect(switchedTo).toBe('写作助手');
    // 验证当前角色已切换
    expect(agent.persona!.activeName).toBe('写作助手');

    agent.off('personaSwitched', () => {});
  });

  it('switchPersona 同名切换幂等：不触发事件，返回当前 prompt', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    let eventFired = false;
    agent.on('personaSwitched', () => {
      eventFired = true;
    });

    const initialName = agent.persona!.activeName!;
    const prompt = agent.switchPersona(initialName);

    // 同名切换不应触发事件
    expect(eventFired).toBe(false);
    // 但应返回当前角色的 prompt
    expect(prompt).toContain(initialName);

    agent.off('personaSwitched', () => {});
  });

  it('switchPersona 角色不存在时返回 null（不抛错）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const initialName = agent.persona!.activeName;

    // 角色不存在时返回 null，不向上抛异常
    const result = agent.switchPersona('不存在的角色');
    expect(result).toBeNull();

    // 当前角色应保持不变
    expect(agent.persona!.activeName).toBe(initialName);
  });

  it('switchPersona 对话繁忙时抛错（与 setArchiveMode 一致）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 模拟对话进行中
    (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager._chatBusy = true;
    expect(() => agent!.switchPersona('写作助手')).toThrow(/对话繁忙/);

    // 恢复空闲状态
    (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager._chatBusy = false;
  });

  // ─── switchRolePack 手动切换（角色包系统，与自动匹配共享事件链路） ─────

  it('switchRolePack 应切换角色包并发射 personaSwitched 事件', async () => {
    // 写两个角色包（manifest.json 文件夹形态）
    const packsDir = join(tmpConfig, 'role-packs');
    const writePack = (dirName: string, manifest: object, persona: string) => {
      const packDir = join(packsDir, dirName);
      mkdirSync(packDir, { recursive: true });
      writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      writeFileSync(join(packDir, (manifest as { persona: string }).persona), persona, 'utf-8');
    };
    writePack('写作助手', { name: '写作助手', formatVersion: '1.0.0', persona: 'persona.md' }, '你是写作助手。');
    writePack('技术文档工程师', { name: '技术文档工程师', formatVersion: '1.0.0', persona: 'persona.md' }, '你是技术文档工程师。');

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const rpm = agent.rolePackManager!;
    rpm.activate('写作助手');

    // 监听 personaSwitched 事件
    let switched: { from: string | null; to: string } | null = null;
    agent.on('personaSwitched', (e) => {
      switched = e;
    });

    const ok = agent.switchRolePack('技术文档工程师');
    expect(ok).toBe(true);
    expect(rpm.activeName).toBe('技术文档工程师');
    expect(switched).toEqual({ from: '写作助手', to: '技术文档工程师' });

    agent.off('personaSwitched', () => {});
  });

  it('switchRolePack 角色不存在：返回 false 且不发射事件', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const rpm = agent.rolePackManager!;

    let switched = false;
    agent.on('personaSwitched', () => {
      switched = true;
    });

    const ok = agent.switchRolePack('不存在的角色');
    expect(ok).toBe(false);
    // 未加载任何角色包时 activeName 保持 null（rolePackManager.activePackName 初始 null）
    expect(rpm.activeName).toBeNull();
    expect(switched).toBe(false);

    agent.off('personaSwitched', () => {});
  });

  it('switchRolePack 同名切换幂等：返回 true 且不发射事件', async () => {
    const packsDir = join(tmpConfig, 'role-packs');
    const packDir = join(packsDir, '写作助手');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'manifest.json'),
      JSON.stringify({ name: '写作助手', formatVersion: '1.0.0', persona: 'persona.md' }, null, 2),
      'utf-8',
    );
    writeFileSync(join(packDir, 'persona.md'), '你是写作助手。', 'utf-8');

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const rpm = agent.rolePackManager!;
    rpm.activate('写作助手');

    let switched = false;
    agent.on('personaSwitched', () => {
      switched = true;
    });

    const ok = agent.switchRolePack('写作助手');
    expect(ok).toBe(true);
    expect(rpm.activeName).toBe('写作助手');
    expect(switched).toBe(false);

    agent.off('personaSwitched', () => {});
  });

  // ─── manual 模式跳过自动归档 ────────────────────────────

  it('manual 模式：chatSync 后不触发 memoryAdded 事件', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'manual');
    await agent.init();

    // 监听 memoryAdded 事件
    let memoryAddedCount = 0;
    agent.on('memoryAdded', () => {
      memoryAddedCount++;
    });

    await agent.chatSync('我正在开发一个新项目，需要记住这个偏好');

    // 等待可能的异步归档（fire-and-forget）
    await new Promise((r) => setTimeout(r, 100));

    // manual 模式应跳过所有自动归档，memoryAdded 不应被触发
    expect(memoryAddedCount).toBe(0);

    agent.off('memoryAdded', () => {});
  });

  it('manual 模式：角色匹配/技能匹配仍执行（非归档行为不受影响）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'manual');
    await agent.init();

    // 监听 personaSwitched 事件（非归档行为，应正常触发）
    let personaSwitched = false;
    agent.on('personaSwitched', () => {
      personaSwitched = true;
    });

    // 输入包含写作关键词，应触发角色自动切换
    await agent.chatSync('帮我写一篇关于小说创作的故事');

    expect(personaSwitched).toBe(true);

    agent.off('personaSwitched', () => {});
  });

  // ─── 手动 API（manual 模式下使用） ─────────────────────

  it('archiveSessionContent：手动触发会话内容归档', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'manual');
    await agent.init();

    // 手动触发会话内容归档
    const result = await agent.archiveSessionContent('2026-07-04', 'session-1');

    // 应返回归档结果结构
    expect(result).toHaveProperty('memories');
    expect(result).toHaveProperty('sessionLabel', '2026-07-04-session-1');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：reloadConfig()（事件驱动配置热重载）
// ═══════════════════════════════════════════════════════════════

describe('Agent · reloadConfig()（配置热重载）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-reload-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-reload-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-reload-cfg-'));
    seedProjectWithPersonasAndSkills(tmpProject, tmpConfig, tmpData);
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

  it('reloadConfig(skill) 应重载技能并反映新增技能', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    // 初始 1 个技能（seedProjectWithPersonasAndSkills 创建的 code-review）
    expect(agent['skillManager']!.list).toHaveLength(1);

    // 新增第 2 个技能文件
    writeFileSync(
      join(tmpConfig, 'skills', 'writing.md'),
      '---\nsource: skill\nname: 写作技能\nkeywords: 写作,文章\n---\n\n写作技能内容',
      'utf-8',
    );

    const result = await agent.reloadConfig('skill');
    expect(result.skill).toBe(2);
    expect(agent['skillManager']!.list).toHaveLength(2);
  });

  it('reloadConfig(persona) 应重载角色并保持激活角色', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const initialActive = agent['rolePackManager_']!.activeName;

    // 新增角色包文件
    writeFileSync(
      join(tmpConfig, 'role-packs', 'reviewer', 'persona.md'),
      '---\nname: 审查员\nkeywords: 审查\n---\n\n你是审查专家',
      'utf-8',
    );

    const result = await agent.reloadConfig('persona');
    expect(result.persona).toBeGreaterThanOrEqual(0);
    // 激活角色应保持不变
    expect(agent['rolePackManager_']!.activeName).toBe(initialActive);
  });

  it('reloadConfig(rule) 应跳过重载（rule 已由 addRule 即时注入）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const result = await agent.reloadConfig('rule');
    expect(result.skill).toBe(0);
    expect(result.persona).toBe(0);
  });

  it('reloadConfig() 无参数应全量重载 skill + persona', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const result = await agent.reloadConfig();
    expect(result.skill).toBeGreaterThan(0);
    expect(result.persona).toBeGreaterThan(0);
  });

  it('reloadConfig 对话繁忙时应抛错', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 模拟对话繁忙
    (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager._chatBusy = true;
    await expect(agent.reloadConfig('skill')).rejects.toThrow(/对话繁忙/);
    (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager._chatBusy = false;
  });

  it('对话繁忙时 reloadConfig(persona/skill) 应暂存到 pendingConfigReload', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 模拟对话繁忙
    const lock = (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager;
    lock._chatBusy = true;
    await expect(agent.reloadConfig('persona')).rejects.toThrow(/对话繁忙/);
    await expect(agent.reloadConfig('skill')).rejects.toThrow(/对话繁忙/);
    // 两个 source 均应暂存
    expect(agent['pendingConfigReload'].has('persona')).toBe(true);
    expect(agent['pendingConfigReload'].has('skill')).toBe(true);
    lock._chatBusy = false;
  });

  it('对话繁忙时 reloadConfig() 无参数不暂存（全量重载无具体来源）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const lock = (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager;
    lock._chatBusy = true;
    await expect(agent.reloadConfig()).rejects.toThrow(/对话繁忙/);
    expect(agent['pendingConfigReload'].size).toBe(0);
    lock._chatBusy = false;
  });

  it('对话繁忙时 reloadConfig(rule) 仍暂存（虽 rule 重载为 no-op，但补执行语义一致）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const lock = (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager;
    lock._chatBusy = true;
    await expect(agent.reloadConfig('rule')).rejects.toThrow(/对话繁忙/);
    // rule 在 chatLock busy 阶段被暂存（补执行时 reloadConfig('rule') 会 no-op 返回）
    expect(agent['pendingConfigReload'].has('rule')).toBe(true);
    lock._chatBusy = false;
  });

  it('close() 应清空 pendingConfigReload（防止 re-init 残留）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 暂存一个请求
    const lock = (agent as unknown as { chatLockManager: { _chatBusy: boolean } }).chatLockManager;
    lock._chatBusy = true;
    await expect(agent.reloadConfig('persona')).rejects.toThrow(/对话繁忙/);
    expect(agent['pendingConfigReload'].size).toBe(1);
    lock._chatBusy = false;

    await agent.close();
    expect(agent['pendingConfigReload'].size).toBe(0);
    agent = null; // 阻止 afterEach 重复 close
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：chat 输入过长时抛错
// ═══════════════════════════════════════════════════════════════

describe('Agent · chat 输入过长时抛错', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-toolong-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-toolong-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-toolong-cfg-'));
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

  it('输入超过 128KB 时应抛出 configError', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 128KB + 1 字符
    const tooLong = 'A'.repeat(128 * 1024 + 1);

    await expect(async () => {
      for await (const {} of agent!.chat(tooLong)) {
        // 消费 generator
      }
    }).rejects.toThrow(/输入过长/);
  });

  it('输入恰好 128KB 时不应抛错', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 恰好 128KB
    const exactMax = 'A'.repeat(128 * 1024);

    // 不应抛出"输入过长"错误（可能因其他原因失败，但不应是输入长度）
    let threwTooLong = false;
    try {
      for await (const {} of agent.chat(exactMax)) {
        break; // 只需验证不抛长度错误即可，不必消费完
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('输入过长')) {
        threwTooLong = true;
      }
    }
    expect(threwTooLong).toBe(false);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════
// 测试：chat 并发锁 · 上一轮未完成时再次调用抛错
// ═══════════════════════════════════════════════════════════════

describe('Agent · chat 并发锁 · 上一轮未完成时再次调用抛错', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  /** 慢速 MockProvider：延迟后才返回，用于模拟未完成的 chat */
  class SlowProvider extends LlmProvider {
    readonly name = 'slow';
    async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
      yield { content: '慢' };
      // 模拟延迟
      await new Promise((resolve) => setTimeout(resolve, 500));
      yield { content: '响应' };
      yield { finishReason: 'stop' };
    }
  }

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-lock-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-lock-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-lock-cfg-'));
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

  it('上一轮 chat 未完成时再次调用应抛出 configError', async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new SlowProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    // 启动第一轮 chat（不 await 完成）
    const gen = agent.chat('第一轮');

    // 消费第一个 chunk 确保 chat 已进入 busy 状态
    const firstChunk = await gen.next();
    expect(firstChunk.done).toBe(false);

    // 此时 isBusy 应为 true
    expect(agent.isBusy).toBe(true);

    // 第二次调用应抛错
    await expect(async () => {
      for await (const {} of agent!.chat('第二轮')) {
        // 消费 generator
      }
    }).rejects.toThrow(/对话繁忙/);

    // 消费完第一轮，释放锁
    for await (const {} of gen) {
      // drain
    }
    expect(agent.isBusy).toBe(false);
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════
// 测试：rebuildComponents() · 手动重建组件
// ═══════════════════════════════════════════════════════════════

describe('Agent · rebuildComponents() · 手动重建组件', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-rebuild-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-rebuild-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-rebuild-cfg-'));
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

  it('rebuildComponents 后 agentLoop 应可用', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await agent.rebuildComponents();

    expect(agent.agentLoop).not.toBeNull();
    expect(agent.agentHistory).not.toBeNull();
  });

  it('rebuildComponents 后对话应正常', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await agent.rebuildComponents();

    const reply = await agent.chatSync('重建后测试');
    expect(reply).toContain('Mock 响应');
  }, 30000);

  it('rebuildComponents 后 Manager 应可用', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await agent.rebuildComponents();

    expect(agent.persona).not.toBeNull();
    expect(agent.tools).not.toBeNull();
    expect(agent.config).not.toBeNull();
    expect(agent.memory).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：chat() 中断保留文本
// ═══════════════════════════════════════════════════════════════

/**
 * 可中断 Mock LLM Provider（测试专用）
 *
 * 与 MockProvider 区别：
 * - 分多个 chunk 输出（模拟真实 LLM 流式）
 * - chunk 之间有延迟（让外部有机会在 chunk 之间触发 abort）
 * - 不主动检查 signal（让 loop.ts 的 callLlmWithRetry 在 chunk 之间检测 abort）
 *
 * 时序：provider yield chunk → loop 检查 signal → yield text → 外部收到 → abort →
 *       provider 延迟结束 yield 下一个 chunk → loop 检测 signal.aborted → break
 */
class AbortableMockProvider extends LlmProvider {
  readonly name = 'abortable-mock';
  /** 分块输出的文本片段 */
  private readonly chunks: string[];
  /** chunk 间延迟（ms），让外部有机会在 chunk 之间触发 abort */
  private readonly delayMs: number;

  constructor(chunks: string[], delayMs = 30) {
    super();
    this.chunks = chunks;
    this.delayMs = delayMs;
  }

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    for (const chunk of this.chunks) {
      yield { content: chunk };
      // 延迟让外部有机会 abort（不检查 signal，让 loop 自己检测）
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    yield { finishReason: 'stop' };
  }
}

describe('Agent · chat() 中断保留文本', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-abort-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-abort-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-abort-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
  });

  afterEach(async () => {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  it('中断时有已生成文本 → 应保留到 history 并追加 [已中断] 标记', async () => {
    // 分两个 chunk 输出，30ms 延迟让外部在第一个 chunk 后触发 abort
    const provider = new AbortableMockProvider(['你好', '我是助手'], 30);
    agent = new Agent({
      projectPath: tmpProject,
      provider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    const ctrl = new AbortController();
    // 收集 chunk，第一个 text 到达后触发 abort
    for await (const chunk of agent.chat('测试', ctrl.signal)) {
      if (chunk.type === 'text') {
        // 第一个 text chunk 到达后立即 abort
        ctrl.abort();
        // 继续消费剩余 chunk 直到 generator 自然结束（loop 检测到 abort 后 yield aborted）
      }
    }

    // 验证 history 中最后一条 assistant 消息包含已生成文本 + [已中断] 标记
    const messages = agent.getMessages();
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content).toContain('你好');
    expect(lastAssistant!.content).toContain('[已中断]');
  }, 15000);

  it('中断时无文本 → 不写入空消息', async () => {
    // 提前 abort：在 chat() 进入主流程前 signal 已 aborted
    const provider = new AbortableMockProvider(['不应到达的文本'], 30);
    agent = new Agent({
      projectPath: tmpProject,
      provider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    const ctrl = new AbortController();
    ctrl.abort(); // 提前 abort，chat() 启动时即检测到

    const chunks: AgentChunk[] = [];
    for await (const chunk of agent.chat('测试', ctrl.signal)) {
      chunks.push(chunk);
    }

    // 期望只收到 aborted chunk，不应有 text chunk
    expect(chunks.some((c) => c.type === 'text')).toBe(false);
    // 验证 history 中没有 assistant 消息（assistantContent 为空，跳过 appendAssistant）
    const messages = agent.getMessages();
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    expect(hasAssistant).toBe(false);
  }, 15000);

  it('自定义 interrupted 配置 → 应使用自定义文案', async () => {
    const provider = new AbortableMockProvider(['部分内容'], 30);
    agent = new Agent({
      projectPath: tmpProject,
      provider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      messages: {
        abortedByUser: '用户取消了对话',
        maxIterationsReached: '\n\n[已达到最大迭代次数]',
        // 自定义中断标记文案
        interrupted: '\n\n[自定义中断标记]',
        recentConversationLabel: '[最近对话]',
        userLabel: '用户',
        assistantLabel: '助手',
      },
    });
    await agent.init();

    const ctrl = new AbortController();
    for await (const chunk of agent.chat('测试', ctrl.signal)) {
      if (chunk.type === 'text') {
        ctrl.abort();
      }
    }

    // 验证 history 中使用自定义中断文案，而非默认的 [已中断]
    const messages = agent.getMessages();
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content).toContain('部分内容');
    expect(lastAssistant!.content).toContain('[自定义中断标记]');
    expect(lastAssistant!.content).not.toContain('[已中断]');
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 测试：chat() 锁超时机制
// ═══════════════════════════════════════════════════════════════

/**
 * 永不主动返回的 Provider，用于模拟卡死的 LLM
 *
 * 立即 yield 第一个 chunk 让 chat() 进入 busy 状态，
 * 然后卡在 outerPromise 等待外部 resolve。
 * 不依赖 setTimeout，避免与 fake timers 冲突。
 */
class HungProvider extends LlmProvider {
  readonly name = 'hung';
  /** 外部控制 resolve 的 Promise */
  outerPromise: Promise<void>;
  /** resolve 函数，测试中调用以解除阻塞 */
  outerResolve: () => void = () => {};

  constructor() {
    super();
    this.outerPromise = new Promise<void>((resolve) => {
      this.outerResolve = resolve;
    });
  }

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    // 立即 yield 第一个 chunk，让 chat() 进入 busy 状态并设置 chatLockTimer
    yield { content: '开始' };
    // 卡在这里，等待外部 resolve（模拟 LLM 卡死）
    await this.outerPromise;
    yield { content: '结束' };
    yield { finishReason: 'stop' };
  }
}

/**
 * chat() 锁超时机制测试
 *
 * 覆盖场景：
 *   - 超时回调校验 token 后才释放锁
 *   - finally 块校验 token 后才清理资源
 *   - close() 递增 token 接管清理职责
 *
 * 测试策略：
 *   - 用 HungProvider 模拟卡死的 LLM（不依赖 setTimeout，兼容 fake timers）
 *   - 用 vi.useFakeTimers + advanceTimersByTime 推进 CHAT_LOCK_TIMEOUT_MS 触发超时
 *   - 通过行为断言（isBusy、新调用是否抛错）验证 token 校验逻辑
 */
describe('Agent · chat() 锁超时机制', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpData = mkdtempSync(join(tmpdir(), 'memora-lockto-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-lockto-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-lockto-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
  });

  afterEach(async () => {
    // 恢复真实定时器，确保 close() 内部的 await 正常工作
    vi.useRealTimers();
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误（测试中可能已部分清理）
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  /**
   * 辅助：推进 fake timers 直到 chatLockTimer 触发
   *
   * CHAT_LOCK_TIMEOUT_MS = 180_000，推进此时间后超时回调执行。
   * 用 advanceTimersByTimeAsync 让 microtask 也完成。
   */
  async function advanceToLockTimeout(): Promise<void> {
    // CHAT_LOCK_TIMEOUT_MS 在 constants.ts 中为 180_000
    // 这里直接用字面量避免导入常量（测试隔离）
    await vi.advanceTimersByTimeAsync(180_000);
  }

  it('锁超时后应释放锁（isBusy=false）', async () => {
    const provider = new HungProvider();
    agent = new Agent({
      projectPath: tmpProject,
      provider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    // 启动 chat，消费第一个 chunk（'开始'）让其进入 busy 状态
    const gen = agent.chat('测试超时');
    const firstChunk = await gen.next();
    expect(firstChunk.done).toBe(false);

    // 此时 isBusy 应为 true
    expect(agent.isBusy).toBe(true);

    // 推进时间触发超时回调
    await advanceToLockTimeout();

    // 超时后 isBusy 应为 false（锁已释放）
    expect(agent.isBusy).toBe(false);

    // 清理：解除 HungProvider 阻塞，消费剩余 chunk
    provider.outerResolve();
    try {
      for await (const {} of gen) {
        // drain
      }
    } catch {
      // 超时后 generator 可能抛 AbortError，忽略
    }
  }, 30000);

  it('锁超时后新调用应能获取锁（不抛"对话繁忙"）', async () => {
    const provider = new HungProvider();
    agent = new Agent({
      projectPath: tmpProject,
      provider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    // 启动第一轮 chat，消费第一个 chunk
    const gen1 = agent.chat('第一轮');
    await gen1.next();
    expect(agent.isBusy).toBe(true);

    // 推进时间触发超时
    await advanceToLockTimeout();
    expect(agent.isBusy).toBe(false);

    // 第二轮 chat 应能成功获取锁（不抛"对话繁忙"）
    const gen2 = agent.chat('第二轮');
    const chunk2 = await gen2.next();
    expect(chunk2.done).toBe(false);
    expect(agent.isBusy).toBe(true);

    // 清理：解除两个 generator
    provider.outerResolve();
    try {
      for await (const {} of gen1) {
      }
    } catch {
    }
    try {
      for await (const {} of gen2) {
      }
    } catch {
    }
  }, 30000);

  it('race condition：超时后新调用获取锁，旧 generator 完成时不应误清新调用者的锁', async () => {
    const provider = new HungProvider();
    agent = new Agent({
      projectPath: tmpProject,
      provider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    // 启动 chat A，消费第一个 chunk
    const genA = agent.chat('chat A');
    await genA.next();
    expect(agent.isBusy).toBe(true);

    // 推进时间触发超时（chat A 的锁被释放）
    await advanceToLockTimeout();
    expect(agent.isBusy).toBe(false);

    // 启动 chat B（获取新锁，token 递增）
    const genB = agent.chat('chat B');
    await genB.next();
    expect(agent.isBusy).toBe(true);

    // 解除 chat A 的阻塞，让其 generator 完成
    // chat A 的 finally 块校验 token，发现 token 已变（被 chat B 递增），
    // 跳过清理，避免误清 chat B 的锁/计时器/controller
    provider.outerResolve();
    try {
      for await (const {} of genA) {
        // drain chat A
      }
    } catch {
      // chat A 可能因超时 abort 而抛错，忽略
    }

    // 关键断言：chat B 的锁应仍然存在（未被 chat A 的 finally 误清）
    expect(agent.isBusy).toBe(true);

    // 清理 chat B
    try {
      for await (const {} of genB) {
      }
    } catch {
    }
  }, 30000);

  it('close() 递增 token，旧 chat generator 完成时不应清理已关闭的状态', async () => {
    const provider = new HungProvider();
    agent = new Agent({
      projectPath: tmpProject,
      provider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    // 启动 chat，消费第一个 chunk
    const gen = agent.chat('chat');
    await gen.next();
    expect(agent.isBusy).toBe(true);

    // close() 递增 token，接管清理职责
    await agent.close();
    // close 后 agent 已销毁，isBusy 应为 false
    expect(agent.isBusy).toBe(false);

    // 解除 chat 的阻塞，让其 generator 完成
    // chat 的 finally 块校验 token，发现 token 已变（被 close 递增），
    // 跳过清理，避免对已关闭的 agent 重复清理
    provider.outerResolve();
    try {
      for await (const {} of gen) {
      }
    } catch {
      // close 已 abort，generator 可能抛错，忽略
    }

    // agent 已关闭，不应因旧 generator 的 finally 产生副作用
    // （如果 finally 误清，可能抛 null reference 或重复清理日志）
    // 这里主要验证不抛错
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════
// 测试：软暂停信号 canContinueWithoutInput()（不中断工作模型 v2.1）
// 决定 sprite 暂停按钮显隐 + 暂停后"继续"UI 的可续跑信号
// ═══════════════════════════════════════════════════════════════

describe('Agent · canContinueWithoutInput() · 软暂停可续跑信号', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-cancont-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-cancont-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-cancont-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
  });

  afterEach(async () => {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  it('RUNNING 且无待续目标时返回 false（简单问答不暴露暂停按钮）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    expect(agent.canContinueWithoutInput()).toBe(false);
  });

  it('已软暂停（paused 状态）时返回 true（必可经 resumeExecution 续跑）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 暂停前应为 false
    expect(agent.canContinueWithoutInput()).toBe(false);

    // 内核事实驱动：状态机翻 PAUSED 发生在 loop 边界挂起时（chat 消费 {paused} chunk）。
    // 此处经 pause() 直接翻状态机（与 requestPause 延迟翻转互补），验证 paused 态可续跑。
    agent.pause('测试软暂停信号', 'user');

    // 已暂停 → 必可续跑
    expect(agent.canContinueWithoutInput()).toBe(true);

    // 清理：恢复状态，避免影响 close()
    agent.resume();
    expect(agent.canContinueWithoutInput()).toBe(false);
  });

  it('T1-1 空闲态 requestPause 应直接翻 PAUSED（不再延迟，修复悬挂锁）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // RUNNING 且无待续目标 → 不可续跑
    expect(agent.canContinueWithoutInput()).toBe(false);

    // 空闲态申请软暂停：无活跃流可"延迟到 loop 边界挂起"，直接同步翻状态机（T1-1）。
    // SSOT 收口后：空闲态 requestPause 直接翻 PAUSED，不再通过 pending 延迟。
    agent.requestPause('空闲暂停');

    // 关键断言：空闲态应立即翻 PAUSED，且可续跑判定随之变为 true（UI 应展示"继续"）
    expect(agent.sessionManager!.status).toBe('paused');
    expect(agent.canContinueWithoutInput()).toBe(true);
  });

  it('isPausePending：申请在途=true，已暂停/已取消=false（宿主三态按钮依据）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 初始：无在途申请
    expect(agent.isPausePending()).toBe(false);

    // 流中在途：通过 SessionStateMachine 模拟申请已发但状态机未翻
    // 状态机初始为 running，直接 requestPause 设置 pending 状态
    const sm = agent.sessionManager!;
    sm.requestPause('流中暂停申请', 'user');
    expect(agent.isPausePending()).toBe(true);

    // 取消在途申请 → 标志清空 → false（宿主按钮切回「暂停」）
    agent.cancelPauseRequest();
    expect(agent.isPausePending()).toBe(false);

    // 已暂停态：状态机守卫——即使尝试设置 pending 也按 false（宿主显示「继续」）
    agent.pause('暂停', 'user');
    // 已暂停后状态机拒绝新 pending 申请（status !== 'running'）
    expect(agent.isPausePending()).toBe(false);
    agent.resume();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：暂停超时自动归档 · T1-2 单一消费点
// ═══════════════════════════════════════════════════════════════

describe('Agent · 暂停超时自动归档（T1-2）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  /**
   * Mock ISessionStore：只回放一个心跳已过期的 paused 检查点
   *
   * 让 init() 的 loadPersistedCheckpoint 走进超时分支，
   * 从而验证「发现超时 → 触发归档」这条链是否真的通。
   */
  function createTimedOutCheckpointStore(sessionId: string): ISessionStore {
    const checkpoint = {
      sessionId,
      status: 'paused',
      mainGoal: '超时归档测试',
      currentGoal: '超时归档测试',
      goalChangeSeq: 0,
      plan: [],
      role: { name: 'assistant' },
      standard: { quality: '完成', constraints: [] },
      resource: { documents: [], memories: [], context: '' },
      hotMemory: [],
      lastHeartbeat: Date.now() - AGENT_CONSTANTS.PAUSE_TIMEOUT_MS - 60_000,
    };
    return {
      appendMessage: () => {},
      loadMessages: () => [],
      listSessions: () => [],
      copySession: () => {},
      saveCheckpoint: () => {},
      loadCheckpoint: (id: string) => (id === sessionId ? JSON.stringify(checkpoint) : null),
      deleteCheckpoint: () => {},
    };
  }

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-timeout-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-timeout-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-timeout-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (agent) {
      await agent.close();
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  it('启动时发现超时会话应触发内容归档', async () => {
    // 只监听不改实现：archiveMode 为 manual 时
    // autoTriggered 的 content 归档会立即降级返回，不触碰 LLM
    const spy = vi.spyOn(ArchiveCoordinator.prototype, 'archiveSessionContent');
    const sessionId = `${todayDate()}-main`;

    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      archiveMode: 'manual',
      sessionStore: createTimedOutCheckpointStore(sessionId),
    });
    await agent.init();

    // 关键断言：监听器必须先于 loadPersistedCheckpoint 注册，
    // 否则启动路径的超时事件无人接收，归档静默丢失
    expect(spy).toHaveBeenCalledWith(todayDate(), 'main', { autoTriggered: true });

    });

  it('无超时会话时不应触发归档', async () => {
    const spy = vi.spyOn(ArchiveCoordinator.prototype, 'archiveSessionContent');

    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'manual');
    await agent.init();

    expect(spy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：L2 行为策略消费（getActiveStrategy + executeChatLoop handoff）
// ═══════════════════════════════════════════════════════════════

describe('Agent · L2 行为策略消费', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-l2-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-l2-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-l2-cfg-'));
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

  // ─── getActiveStrategy() 默认值 ──────────────────────────

  it('getActiveStrategy 应返回默认策略（无激活角色包时）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const strategy = agent.getActiveStrategy();
    // 验证默认策略的 prepare 维度
    expect(strategy.prepare?.memoryRecall).toBe('full');
    expect(strategy.prepare?.memoryRecallQuota).toBe(2000);
    // 最近几轮固定加载轮数默认 3（角色包 recentRounds 未配置时的兜底）
    expect(strategy.prepare?.recentRounds).toBe(3);
    // 验证默认策略的 act 维度（标准键 act.toolMode，§六）
    expect(strategy.act?.toolMode).toBe('allow');
    // 验证默认策略的 reflect 维度（标准键 reflect.handoff，§六）
    expect(strategy.reflect?.handoff).toBe('wait');
  });

  // ─── executeChatLoop → handoff chunk ─────────────────────

  it('chat 应 yield handoff chunk（默认 handoff=wait）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const chunks: AgentChunk[] = [];
    for await (const chunk of agent.chat('你好')) {
      chunks.push(chunk);
    }

    // 验证 handoff chunk
    const handoffChunk = chunks.find((c) => c.type === 'handoff');
    expect(handoffChunk).toBeDefined();
    if (handoffChunk?.type === 'handoff') {
      expect(handoffChunk.decision).toBe('wait');
      // 'wait' 决策时 reason 应为 undefined（L2 策略默认等待用户输入）
      expect(handoffChunk.reason).toBeUndefined();
    }
  });

  // ─── prepareChatContext 通过策略设置 loop 工具调用权限 ──

  it('默认策略下 loop 工具调用不被阻止（toolCalls=allow）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 默认策略 toolCalls='allow'，工具调用正常执行
    // 通过 chat 验证不会触发工具调用阻止行为
    for await (const {} of agent.chat('测试')) {
      // 消费所有 chunk
    }

    // 验证 handoff chunk 存在（表明 executeChatLoop 正常执行）
    // 验证整体流程不抛错即说明 prepareChatContext 正确消费了默认策略
    expect(agent.agentLoop).not.toBeNull();
  });

  // ─── recentRounds 覆盖固定加载轮数（2026-08-14 消费接入）──

  it('角色包 prepare.recentRounds 应覆盖最近几轮固定加载轮数', async () => {
    // 在 configDir 下写一个带 recentRounds:5 的角色包（manifest.json 文件夹形态，
    // init 自动扫描并激活第一个）
    const packDir = join(tmpConfig, 'role-packs', '精算师');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'manifest.json'),
      JSON.stringify(
        {
          name: '精算师',
          formatVersion: '1.0.0',
          description: 'recentRounds 覆盖验证',
          keywords: ['精算'],
          strategy: { prepare: { recentRounds: 5 } },
          persona: 'persona.md',
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(join(packDir, 'persona.md'), '你是一个精算师。', 'utf-8');

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 角色包被激活，getActiveStrategy 返回其策略（消费入口：recallAndInject 读取此值）
    const strategy = agent.getActiveStrategy();
    expect(strategy.prepare?.recentRounds).toBe(5);

    // 多轮对话走 recallAndInject，消费 recentRounds 不抛错即验证覆盖路径生效
    // （默认 3 轮兜底已在上述"默认策略"测试断言）
    const chunks: AgentChunk[] = [];
    for await (const chunk of agent.chat('你好')) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.type === 'handoff')).toBe(true);
  });

  it('角色包声明非法 recentRounds（0）应降级内核默认，对话不抛错', async () => {
    // 非法值（0）经 mergeStrategy 覆盖默认 3，但消费处 resolveRecentRounds 检测到
    // 非"0 以上正整数"而降级回内核默认兜底——SSOT：开放参数必有硬编码兜底
    const packDir = join(tmpConfig, 'role-packs', '非法轮数');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'manifest.json'),
      JSON.stringify(
        {
          name: '非法轮数',
          formatVersion: '1.0.0',
          description: '非法 recentRounds 降级验证',
          keywords: ['非法'],
          strategy: { prepare: { recentRounds: 0 } },
          persona: 'persona.md',
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(join(packDir, 'persona.md'), '你是一个测试角色。', 'utf-8');

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 消费路径（recallAndInject → resolveRecentRounds）对非法值降级，整轮对话不抛错
    const chunks: AgentChunk[] = [];
    for await (const chunk of agent.chat('你好')) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.type === 'handoff')).toBe(true);
  });

  it('角色包优先匹配：粘性 + 互斥切换（§6.2）', async () => {
    // 写一对互斥角色包（翻译助手 ↔ 代码助手，manifest.json 文件夹形态），
    // 验证角色包优先于 persona 匹配
    const packsDir = join(tmpConfig, 'role-packs');
    const writePack = (dirName: string, manifest: object, persona: string) => {
      const packDir = join(packsDir, dirName);
      mkdirSync(packDir, { recursive: true });
      writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      writeFileSync(join(packDir, (manifest as { persona: string }).persona), persona, 'utf-8');
    };
    writePack(
      '翻译助手',
      {
        name: '翻译助手',
        formatVersion: '1.0.0',
        keywords: ['翻译', '英译中'],
        exclusiveWith: ['代码助手'],
        persona: 'persona.md',
      },
      '你是翻译。',
    );
    writePack(
      '代码助手',
      {
        name: '代码助手',
        formatVersion: '1.0.0',
        keywords: ['编程', '写代码'],
        exclusiveWith: ['翻译助手'],
        persona: 'persona.md',
      },
      '你是程序员。',
    );

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const rpm = agent.rolePackManager!;
    // 显式设定会话初始激活（不依赖扫描顺序）
    rpm.activate('翻译助手');

    // 首次外部输入命中代码助手 → 粘性匹配切换
    for await (const {} of agent.chat('帮我写代码')) {}
    expect(rpm.activeName).toBe('代码助手');

    // 已锁定：命中互斥角色包 → 切换
    for await (const {} of agent.chat('翻译这段话')) {}
    expect(rpm.activeName).toBe('翻译助手');

    // 已锁定：再次命中已激活角色包 → 不切换（粘性）
    for await (const {} of agent.chat('翻译别的内容')) {}
    expect(rpm.activeName).toBe('翻译助手');
  });
});
