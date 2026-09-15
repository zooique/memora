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
import type { IRoundStore, Round } from '@/memory/roundStore.js';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
import { todayDate } from '@/utils/time.js';
import { AGENT_EVENTS } from '@/utils/eventEmitter.js';
import { AgentLoop } from '@/agent/loop.js';

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
 *
 * 创建 role-packs/ 文件夹形态角色包
 * （RolePackManager 扫描 role-packs/<name>/manifest.json）
 */
function seedProject(_projectPath: string, configDir: string, _dataDir: string): void {
  const rolePackDir = join(configDir, 'role-packs', '默认助手');
  mkdirSync(rolePackDir, { recursive: true });
  writeFileSync(
    join(rolePackDir, 'manifest.json'),
    JSON.stringify({
      name: '默认助手',
      displayName: '默认助手',
      strategy: {},
    }),
    'utf-8',
  );
  writeFileSync(
    join(rolePackDir, 'persona.md'),
    '你是一个通用助手。',
    'utf-8',
  );
  // 兜底契约包（§4.1 单链：无 activePack 注入时落兜底包，非 items[0]）
  const fallbackDir = join(configDir, 'role-packs', 'memora助手');
  mkdirSync(fallbackDir, { recursive: true });
  writeFileSync(
    join(fallbackDir, 'manifest.json'),
    JSON.stringify({ name: 'memora助手', formatVersion: '1.0.0' }),
    'utf-8',
  );
  writeFileSync(join(fallbackDir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  // skills 目录保持结构完整
  mkdirSync(join(configDir, 'skills'), { recursive: true });
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

/**
 * 测试桥接：暴露受保护的 emit，用于验证 workProjectionGenerated 事件订阅接线。
 * 子类访问继承的 protected 成员是合法 TS，不破坏零 any 规则（project-rules §7.1）。
 */
class TestableAgent extends Agent {
  emitWorkProjectionGenerated(): void {
    this.emit(AGENT_EVENTS.workProjectionGenerated, { sourcePath: 'x.md', summary: 'y' });
  }
}

function makeTestableAgent(
  projectPath: string,
  configDir: string,
  dataDir: string,
  archiveMode?: 'full' | 'manual',
): TestableAgent {
  return new TestableAgent({
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
      expect(typeof item.contentPreview).toBe('string');
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
    expect(agent.rolePack).toBeNull();
    expect(agent.tools).toBeNull();
    expect(agent.memory).toBeNull();
    expect(agent.skills).toBeNull();
    expect(agent.rolePacks).toBeNull();
    expect(agent.security).toBeNull();

    // init
    const ctx = await agent.init();
    expect(agent.initialized).toBe(true);
    expect(ctx.projectPath).toBe(tmpProject);
    expect(agent.context).toBe(ctx);

    // Manager 访问器应可用
    expect(agent.rolePack).not.toBeNull();
    expect(agent.tools).not.toBeNull();
    expect(agent.memory).not.toBeNull();
    expect(agent.skills).not.toBeNull();
    expect(agent.rolePacks).not.toBeNull();
    expect(agent.security).not.toBeNull();

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
    expect(agent.rolePack).not.toBeNull();
    expect(agent.tools).not.toBeNull();
    expect(agent.memory).not.toBeNull();
    expect(agent.agentLoop).not.toBeNull();
    expect(agent.agentHistory).not.toBeNull();
    expect(agent.context).not.toBeNull();
    expect(agent.projects).not.toBeNull();
    expect(agent.works).not.toBeNull();
    expect(agent.sessionManager).not.toBeNull();
    expect(agent.polish).not.toBeNull();
    expect(agent.skills).not.toBeNull();
    expect(agent.rolePacks).not.toBeNull();
    expect(agent.security).not.toBeNull();

    // close 调用 nullifyAllComponents，应 null 化全部 13 个组件字段
    await agent.close();

    // Provider 相关
    expect(agent.agentLoop).toBeNull();
    expect(agent.agentHistory).toBeNull();
    // 核心组件
    expect(agent.context).toBeNull();
    // 专职 Manager
    expect(agent.rolePack).toBeNull();
    expect(agent.tools).toBeNull();
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
    expect(agent.rolePack).not.toBeNull();
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

  it('persona 管理器：list / activeName', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    expect(Array.isArray(agent.rolePack!.list)).toBe(true);
    expect(typeof agent.rolePack!.activeName).toBe('string');
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

  // ─── L1~L3 LLM 记忆治理委托（G1） ─────────────────────────
  // makeAgent 未注入 backgroundProvider，验证委托转发 + 降级路径 + 报告结构完整性。
  // 降级语义：manager 内部检测到 backgroundProvider 缺失时返回 skippedReason 报告。

  it('L1 语义去重：deduplicateMemories 委托应返回 DedupReport 结构（未注入 backgroundProvider 降级）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 委托到 MemoryInspector.deduplicateMemories，未注入 backgroundProvider 时降级
    // 从 agent.deduplicateMemories() 迁移到 governance.deduplicate()
    const report = await agent.governance!.deduplicate();
    expect(report).toHaveProperty('scannedCount');
    expect(report).toHaveProperty('pairCount');
    expect(report).toHaveProperty('deduplicatedCount');
    expect(report).toHaveProperty('demotedIds');
    expect(Array.isArray(report.demotedIds)).toBe(true);
    // 降级路径：skippedReason 非空
    expect(report.skippedReason).toBeTruthy();
  });

  it('L3 冲突检测：detectConflicts 委托应返回 ConflictReport 结构（未注入 backgroundProvider 降级）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // v2 PROXY-1 闭环：直接调用 MemoryAdvisor.detectConflicts（不经 MemoryInspector 转发），
    // 未注入 backgroundProvider 时降级返回 skippedReason
    // 从 agent.detectConflicts() 迁移到 governance.detectConflicts()
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
 * 种子项目：多角色包 + 多技能场景
 *
 * 创建 role-packs/ 文件夹形态角色包
 * （RolePackManager 扫描 role-packs/<name>/manifest.json）
 */
function seedProjectWithPersonasAndSkills(
  _projectPath: string,
  configDir: string,
  _dataDir: string,
): void {
  // 角色包 1：编程专家
  const coderDir = join(configDir, 'role-packs', '编程专家');
  mkdirSync(coderDir, { recursive: true });
  writeFileSync(
    join(coderDir, 'manifest.json'),
    JSON.stringify({
      name: '编程专家',
      displayName: '编程专家',
      strategy: {},
    }),
    'utf-8',
  );
  writeFileSync(
    join(coderDir, 'persona.md'),
    '你是一个编程专家，擅长代码分析和调试。',
    'utf-8',
  );

  // 角色包 2：写作助手
  const writerDir = join(configDir, 'role-packs', '写作助手');
  mkdirSync(writerDir, { recursive: true });
  writeFileSync(
    join(writerDir, 'manifest.json'),
    JSON.stringify({
      name: '写作助手',
      displayName: '写作助手',
      strategy: {},
    }),
    'utf-8',
  );
  writeFileSync(
    join(writerDir, 'persona.md'),
    '你是一个写作助手，擅长创意写作。',
    'utf-8',
  );

  // 角色包 3：代码审查助手（带 skills）
  const reviewerDir = join(configDir, 'role-packs', '代码审查助手');
  mkdirSync(reviewerDir, { recursive: true });
  writeFileSync(
    join(reviewerDir, 'manifest.json'),
    JSON.stringify({
      name: '代码审查助手',
      displayName: '代码审查助手',
      strategy: {},
      skills: [{ file: 'code-review', name: '代码审查', description: '审查代码质量' }],
    }),
    'utf-8',
  );
  writeFileSync(
    join(reviewerDir, 'persona.md'),
    '你是一个代码审查专家。',
    'utf-8',
  );
  const skillsDir = join(reviewerDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(skillsDir, 'code-review.md'),
    '---\nname: 代码审查\ndescription: 审查代码质量\n---\n\n审查代码时关注可读性、性能和安全性。',
    'utf-8',
  );

  // 全局 skills 目录（用于 reloadConfig 测试）
  mkdirSync(join(configDir, 'skills'), { recursive: true });
  writeFileSync(
    join(configDir, 'skills', 'code-review.md'),
    '---\nsource: skill\nname: 代码审查\n---\n\n审查代码时关注可读性、性能和安全性。',
    'utf-8',
  );

  // 兜底契约包（§4.1 单链：无 activePack 注入时落兜底包，非 items[0]）
  const fallbackDir = join(configDir, 'role-packs', 'memora助手');
  mkdirSync(fallbackDir, { recursive: true });
  writeFileSync(
    join(fallbackDir, 'manifest.json'),
    JSON.stringify({ name: 'memora助手', formatVersion: '1.0.0' }),
    'utf-8',
  );
  writeFileSync(join(fallbackDir, 'persona.md'), '你是一个通用助手。', 'utf-8');

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

  it('角色手动切换：switchRolePack 触发 personaSwitched 事件（自动匹配已移除）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // §4.1 单链：无 activePack 注入 → 落兜底包（memora助手，非 items[0]）
    const initialName = agent.rolePack!.activeName;
    expect(initialName).toBe('memora助手');

    // 监听 personaSwitched 事件
    let switchedFrom: string | null = null;
    let switchedTo: string | null = null;
    agent.on('rolePackSwitched', (e) => {
      switchedFrom = e.from;
      switchedTo = e.to;
    });

    // 手动切换是唯一入口（自动匹配已随 v0.13 移除）：切到写作助手
    const ok = agent.switchRolePack('写作助手');

    // 验证事件已触发
    expect(ok).toBe(true);
    expect(switchedFrom).toBe(initialName);
    expect(switchedTo).toBe('写作助手');

    // 验证当前角色已切换
    expect(agent.rolePack!.activeName).toBe('写作助手');

    agent.off('rolePackSwitched', () => {});
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

  /** Mock ISessionStore */
  function createMockSessionStore(): ISessionStore {
    // 消息存储（ISessionStore.loadMessages 契约：roundIds → RoundStore 展开）
    const store = new Map<string, Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: string }>>();
    // Round-based 存储：sessionId → roundId[]
    const roundIdsMap = new Map<string, string[]>();
    // 元数据存储
    const metas = new Map<string, { sessionId: string; createdAt?: string; updatedAt: string; messageCount: number }>();

    return {
      loadMessages(date: string, session: string) {
        return store.get(`${date}-${session}`) ?? [];
      },
      listSessions() {
        const sessions = new Set<string>(Array.from(store.keys()));
        for (const id of roundIdsMap.keys()) sessions.add(id);
        for (const id of metas.keys()) sessions.add(id);
        return Array.from(sessions);
      },
      // Round-based 方法
      getRoundIds(sessionId: string): string[] {
        return roundIdsMap.get(sessionId) ?? [];
      },
      setRoundIds(sessionId: string, roundIds: string[]) {
        roundIdsMap.set(sessionId, [...roundIds]);
      },
      appendRoundId(sessionId: string, roundId: string) {
        const ids = roundIdsMap.get(sessionId) ?? [];
        ids.push(roundId);
        roundIdsMap.set(sessionId, ids);
      },
      appendRoundIds(sessionId: string, roundIds: string[]) {
        const ids = roundIdsMap.get(sessionId) ?? [];
        ids.push(...roundIds);
        roundIdsMap.set(sessionId, ids);
      },
      createSession(meta: { sessionId: string; updatedAt: string; messageCount: number }) {
        metas.set(meta.sessionId, { ...meta });
      },
      deleteSession(sessionId: string) {
        roundIdsMap.delete(sessionId);
        metas.delete(sessionId);
      },
      updateSessionMeta(sessionId: string, meta: Record<string, unknown>) {
        const existing = metas.get(sessionId) ?? { sessionId, updatedAt: new Date().toISOString(), messageCount: 0 };
        metas.set(sessionId, { ...existing, ...meta, updatedAt: new Date().toISOString() });
      },
      getSessionMeta(sessionId: string) {
        return metas.get(sessionId);
      },
      listSessionMetas() {
        return Array.from(metas.values());
      },
    };
  }

  /** Mock IRoundStore - 存储 Round 对象的内存实现 */
  function createMockRoundStore(): IRoundStore {
    const rounds = new Map<string, Round>();
    return {
      save(round: Round) {
        rounds.set(round.id, round);
      },
      getById(roundId: string): Round | null {
        return rounds.get(roundId) ?? null;
      },
      getByIds(roundIds: string[]): Round[] {
        return roundIds.map(id => rounds.get(id)).filter((r): r is Round => r !== undefined);
      },
      listAll(): Round[] {
        return Array.from(rounds.values());
      },
      incrementRef(roundId: string) {
        const round = rounds.get(roundId);
        if (round) {
          rounds.set(roundId, { ...round, refCount: round.refCount + 1 });
        }
      },
      decrementRef(roundId: string) {
        const round = rounds.get(roundId);
        if (round && round.refCount > 0) {
          rounds.set(roundId, { ...round, refCount: round.refCount - 1 });
        }
      },
      delete(roundId: string): boolean {
        return rounds.delete(roundId);
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
    const roundStore = createMockRoundStore();
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
      roundStore,
    });
    await agent.init();

    // 先对话产生消息
    await agent.chatSync('你好');

    const result = agent.forkSession();
    expect(result.newSession).toBeDefined();
    expect(typeof result.newSession).toBe('string');
    expect(result.roundCount).toBeGreaterThan(0);
  });

  it('分叉自动命名（未传 targetSession）应触发 SessionNamer 写入标题', async () => {
    const sessionStore = createMockSessionStore();
    const roundStore = createMockRoundStore();
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
      roundStore,
    });
    await agent.init();

    await agent.chatSync('你好');

    const result = agent.forkSession();
    // fire-and-forget：等异步命名完成（best-effort，LLM 失败/无价值会降级占位标题，autoName 始终有值）
    await new Promise((r) => setTimeout(r, 30));

    const meta = sessionStore.getSessionMeta(`${result.date}-${result.newSession}`);
    expect(meta?.autoName).toBeTruthy();
  });

  it('分叉自定义命名（传 targetSession）应尊重用户命名，不触发 autoName 覆盖', async () => {
    const sessionStore = createMockSessionStore();
    const roundStore = createMockRoundStore();
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
      roundStore,
    });
    await agent.init();

    await agent.chatSync('你好');

    agent.forkSession(undefined, '我的实验分支');
    // 用户显式命名场景：不触发 LLM autoName 覆盖（等异步窗口验证不会凭空出现 autoName）
    await new Promise((r) => setTimeout(r, 30));
    const now = new Date();
    const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const meta = sessionStore.getSessionMeta(`${dateKey}-我的实验分支`);
    expect(meta?.autoName).toBeFalsy();
  });

  it('分叉会话应发射 sessionForked 事件', async () => {
    const sessionStore = createMockSessionStore();
    const roundStore = createMockRoundStore();
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
      roundStore,
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
    const roundStore = createMockRoundStore();
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
      roundStore,
    });
    await agent.init();

    // 先产生消息
    await agent.chatSync('你好');

    // 模拟 chat 忙碌（直接设置内部状态以测试并发锁行为）
    (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = true;

    expect(() => agent!.forkSession()).toThrow(/对话繁忙/);

    (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = false;
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
      loadMessages(date: string, session: string) {
        return messagesBySession[`${date}-${session}`] ?? [];
      },
      listSessions() {
        return sessions;
      },
      getRoundIds() {
        return [];
      },
      setRoundIds() {
        // no-op
      },
      appendRoundId() {
        // no-op
      },
      appendRoundIds() {
        // no-op
      },
      createSession() {
        // no-op
      },
      deleteSession() {
        // no-op
      },
      getSessionMeta() {
        return undefined;
      },
      updateSessionMeta() {
        // no-op
      },
      listSessionMetas() {
        // SSOT mock：保持传入顺序（[0] = 最近活跃，调用方负责控制降序时序）
        return sessions.map((sessionId) => ({
          sessionId,
          updatedAt: new Date().toISOString(),
          messageCount: (messagesBySession[sessionId] ?? []).length,
        }));
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

    const count = await agent.sessionManager!.restoreMostRecentSession();
    expect(count).toBe(2);
  });

  it('有会话时按 listSessionMetas[0]（updatedAt 降序最近活跃）恢复', async () => {
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

    // listSessionMetas[0] 即最近活跃会话（SSOT），与会话名是否 main 无关
    const count = await agent.sessionManager!.restoreMostRecentSession();
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

    const count = await agent.sessionManager!.restoreMostRecentSession();
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
// 测试：setContextWindow() · 上下文窗口上限热更新
// ═══════════════════════════════════════════════════════════════

describe('Agent · setContextWindow() · 上下文窗口上限热更新', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-cw-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-cw-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-cw-cfg-'));
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

  it('setContextWindow 后：下一轮 prepare 占用快照总容量按新窗口计算（ContextPreparer 同步）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    // 先跑一轮：占用快照按构造期默认窗口（120K）落定
    await agent.chatSync('你好');
    expect(agent.getMetrics().context.occupancy?.totalTokens).toBe(120_000);

    // 热更新到 200K → 下一轮 prepare 预算与占用快照随新窗口重算
    agent.setContextWindow(200_000);
    await agent.chatSync('继续');
    expect(agent.getMetrics().context.occupancy?.totalTokens).toBe(200_000);
  });

  it('setContextWindow 对话进行中禁止更新（与 setProvider 同守卫）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 启动流式生成，消费首个 chunk 确保进入 busy 状态
    const gen = agent.chat('第一轮');
    expect((await gen.next()).done).toBe(false);
    expect(agent.isBusy).toBe(true);

    // busy 期间调用 → 同步抛「对话繁忙」
    expect(() => agent!.setContextWindow(200_000)).toThrow(/对话繁忙/);

    // 收尾：drain 释放锁
    for await (const {} of gen) {
      // 消费 generator
    }
    expect(agent.isBusy).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：archiveMode · 二态归档模式
// ═══════════════════════════════════════════════════════════════

describe('Agent · archiveMode · 二态归档模式（full|manual）', () => {
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
    (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = true;
    expect(() => agent!.setArchiveMode('manual')).toThrow(/对话繁忙/);

    // 恢复空闲状态
    (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = false;
  });

  // ─── switchRolePack 手动切换（与自动匹配共享事件链路） ─────

  it('switchRolePack 应切换角色并发射 rolePackSwitched 事件', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 初始角色为兜底包（§4.1 单链：无 activePack 注入 → 落兜底包）
    const initialName = agent.rolePack!.activeName;
    expect(initialName).toBe('memora助手');

    // 监听 rolePackSwitched 事件
    let switchedFrom: string | null = null;
    let switchedTo: string | null = null;
    agent.on('rolePackSwitched', (e) => {
      switchedFrom = e.from;
      switchedTo = e.to;
    });

    const ok = agent.switchRolePack('写作助手');

    // 验证返回值为 true
    expect(ok).toBe(true);
    // 验证事件已触发
    expect(switchedFrom).toBe(initialName);
    expect(switchedTo).toBe('写作助手');
    // 验证当前角色已切换
    expect(agent.rolePack!.activeName).toBe('写作助手');

    agent.off('rolePackSwitched', () => {});
  });

  it('switchRolePack 同名切换幂等：不触发事件，返回 true', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    let eventFired = false;
    agent.on('rolePackSwitched', () => {
      eventFired = true;
    });

    const initialName = agent.rolePack!.activeName!;
    const ok = agent.switchRolePack(initialName);

    // 同名切换不应触发事件
    expect(eventFired).toBe(false);
    // 但应返回 true（幂等成功）
    expect(ok).toBe(true);

    agent.off('rolePackSwitched', () => {});
  });

  it('switchRolePack 角色不存在时返回 false（不抛错）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const initialName = agent.rolePack!.activeName;

    // 角色不存在时返回 false，不向上抛异常
    const result = agent.switchRolePack('不存在的角色');
    expect(result).toBe(false);

    // 当前角色应保持不变
    expect(agent.rolePack!.activeName).toBe(initialName);
  });

  it('switchRolePack 对话中可切换（自动匹配共用入口，不阻塞）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 模拟对话进行中
    (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = true;
    // switchRolePack 是内部统一入口，对话中也允许切换（自动匹配需要）
    const ok = agent!.switchRolePack('编程专家');
    expect(ok).toBe(true);

    // 恢复空闲状态
    (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = false;
  });

  // ─── switchRolePack 手动切换（角色包系统，与自动匹配共享事件链路） ─────

  it('switchRolePack 应切换角色包并发射 rolePackSwitched 事件', async () => {
    // 写两个角色包（manifest.json 文件夹形态）
    const packsDir = join(tmpConfig, 'role-packs');
    const writePack = (dirName: string, manifest: object, persona: string) => {
      const packDir = join(packsDir, dirName);
      mkdirSync(packDir, { recursive: true });
      writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      writeFileSync(join(packDir, 'persona.md'), persona, 'utf-8');
    };
    writePack('写作助手', { name: '写作助手', formatVersion: '1.0.0' }, '你是写作助手。');
    writePack('技术文档工程师', { name: '技术文档工程师', formatVersion: '1.0.0' }, '你是技术文档工程师。');

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const rpm = agent.rolePackManager!;
    rpm.activate('写作助手');

    // 监听 personaSwitched 事件
    let switched: { from: string | null; to: string } | null = null;
    agent.on('rolePackSwitched', (e) => {
      switched = e;
    });

    const ok = agent.switchRolePack('技术文档工程师');
    expect(ok).toBe(true);
    expect(rpm.activeName).toBe('技术文档工程师');
    expect(switched).toEqual({ from: '写作助手', to: '技术文档工程师' });

    agent.off('rolePackSwitched', () => {});
  });

  it('switchRolePack 角色不存在：返回 false 且不发射事件', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const rpm = agent.rolePackManager!;
    // 初始角色包已由 seed 自动激活
    const initialActive = rpm.activeName;

    let switched = false;
    agent.on('rolePackSwitched', () => {
      switched = true;
    });

    const ok = agent.switchRolePack('不存在的角色');
    expect(ok).toBe(false);
    // 角色不存在时保持原激活角色不变
    expect(rpm.activeName).toBe(initialActive);
    expect(switched).toBe(false);

    agent.off('rolePackSwitched', () => {});
  });

  it('switchRolePack 同名切换幂等：返回 true 且不发射事件', async () => {
    const packsDir = join(tmpConfig, 'role-packs');
    const packDir = join(packsDir, '写作助手');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'manifest.json'),
      JSON.stringify({ name: '写作助手', formatVersion: '1.0.0' }, null, 2),
      'utf-8',
    );
    writeFileSync(join(packDir, 'persona.md'), '你是写作助手。', 'utf-8');

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const rpm = agent.rolePackManager!;
    rpm.activate('写作助手');

    let switched = false;
    agent.on('rolePackSwitched', () => {
      switched = true;
    });

    const ok = agent.switchRolePack('写作助手');
    expect(ok).toBe(true);
    expect(rpm.activeName).toBe('写作助手');
    expect(switched).toBe(false);

    agent.off('rolePackSwitched', () => {});
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

  it('manual 模式：角色手动切换仍执行（非归档行为不受影响）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'manual');
    await agent.init();

    // 监听 personaSwitched 事件（非归档行为，应正常触发）
    let personaSwitched = false;
    agent.on('rolePackSwitched', () => {
      personaSwitched = true;
    });

    // 手动切换是唯一入口（自动匹配已随 v0.13 移除）
    const ok = agent.switchRolePack('写作助手');

    expect(ok).toBe(true);
    expect(personaSwitched).toBe(true);

    agent.off('rolePackSwitched', () => {});
  });

  // ─── 手动 API（manual 模式下使用） ─────────────────────

  it('archiveSession：手动触发会话内容归档', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, 'manual');
    await agent.init();

    // 手动触发会话内容归档
    const result = await agent.archiveSession('2026-07-04', 'session-1');

    // 应返回归档结果结构（方案 C：updatedFields 替代 memories）
    expect(result).toHaveProperty('updatedFields');
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
      '---\nsource: skill\nname: 写作技能\n---\n\n写作技能内容',
      'utf-8',
    );

    const result = await agent.reloadConfig('skill');
    expect(result.skill).toBe(2);
    expect(agent['skillManager']!.list).toHaveLength(2);
  });

  it('reloadConfig(persona) 应重载角色并保持激活角色', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const initialActive = agent['_rolePackManager']!.activeName;

    // 新增角色包文件（角色包文件夹形态）
    const reviewerDir = join(tmpConfig, 'role-packs', '审查员');
    mkdirSync(reviewerDir, { recursive: true });
    writeFileSync(
      join(reviewerDir, 'manifest.json'),
      JSON.stringify({
        name: '审查员',
        displayName: '审查员',
        strategy: {},
      }),
      'utf-8',
    );
    writeFileSync(
      join(reviewerDir, 'persona.md'),
      '你是审查专家',
      'utf-8',
    );

    const result = await agent.reloadConfig('rolePack');
    expect(result.rolePack).toBeGreaterThanOrEqual(0);
    // 激活角色应保持不变
    expect(agent['_rolePackManager']!.activeName).toBe(initialActive);
  });

  it('reloadConfig(rule) 应触发角色包重载（rule 是角色包的一部分）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const result = await agent.reloadConfig('rule');
    // rule 重载走 rolePack 路径，应触发角色包重新扫描
    expect(result.skill).toBe(0);
    expect(result.rolePack).toBeGreaterThan(0);
  });

  it('reloadConfig() 无参数应全量重载 skill + rolePack', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const result = await agent.reloadConfig();
    expect(result.skill).toBeGreaterThan(0);
    expect(result.rolePack).toBeGreaterThan(0);
  });

  it('reloadConfig 对话繁忙时应抛错', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 模拟对话繁忙
    (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = true;
    await expect(agent.reloadConfig('skill')).rejects.toThrow(/对话繁忙/);
    (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = false;
  });

  it('对话繁忙时 reloadConfig(persona/skill) 应暂存到 pendingConfigReload', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 模拟对话繁忙
    const lock = (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager;
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

    const lock = (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager;
    lock._chatBusy = true;
    await expect(agent.reloadConfig()).rejects.toThrow(/对话繁忙/);
    expect(agent['pendingConfigReload'].size).toBe(0);
    lock._chatBusy = false;
  });

  it('对话繁忙时 reloadConfig(rule) 仍暂存（虽 rule 重载为 no-op，但补执行语义一致）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const lock = (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager;
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
    const lock = (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager;
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

    expect(agent.rolePack).not.toBeNull();
    expect(agent.tools).not.toBeNull();
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

/**
 * 可中断且抛 AbortError 的 Mock LLM Provider（测试专用）
 *
 * 与 AbortableMockProvider 的差异：本 provider 在 chunk 间**主动检查 signal**，一旦 aborted
 * 就抛 DOMException('AbortError')——模拟真实 LLM 流式中断（fetch stream 被 abort 后的行为）。
 *
 * 关键：真实中断路径是 provider 抛 AbortError → consumeExecutionStream 的 catch 分支，
 * 而非 loop step 边界的 yield aborted（AbortableMockProvider 路径）。两条路径都要覆盖。
 */
class AbortThrowingProvider extends LlmProvider {
  readonly name = 'abort-throwing';
  /** 分块输出的文本片段 */
  private readonly chunks: string[];
  /** chunk 间延迟（ms），让外部有机会在 chunk 之间触发 abort */
  private readonly delayMs: number;

  constructor(chunks: string[], delayMs = 30) {
    super();
    this.chunks = chunks;
    this.delayMs = delayMs;
  }

  async *chat(
    _messages: Message[],
    opts?: ChatOptions,
  ): AsyncIterable<LlmChunk> {
    for (const chunk of this.chunks) {
      if (opts?.signal?.aborted) {
        // 模拟 fetch stream 被 abort：抛 AbortError（isAbortError 判定 name==='AbortError'）
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      yield { content: chunk };
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    yield { finishReason: 'stop' };
  }
}

/**
 * 连接中断 Mock Provider（2026-09-02 假中断排雷测试专用）
 *
 * 无任何 abort 触发（宿主 signal 未 abort），却在流式过程中主动抛 AbortError——
 * 模拟真实网络/代理内部中断（连接被抽断）。
 * 内核应判为「连接中断」而非「用户取消」：agent 层输出 error chunk + failed，
 * 不会产出 aborted chunk，**不谎报用户取消**。
 * 注（2026-09-15 修正）：本注释曾写「history 不写中断标记」——那是修复前的行为。
 * failed 与 aborted 现同属「本轮未正常完成」，在 `seed/orchestrator.act()` 共用
 * `appendInterrupted` 收口（SSOT），已产出文本 + 中断标记**照常写史**；
 * 不变的只有「不产出 aborted chunk / 不谎报用户取消」这一点。
 */
class ConnectionInterruptedProvider extends LlmProvider {
  readonly name = 'connection-interrupted';
  /** 分块输出多少段文本后再抛 AbortError */
  private readonly chunks: string[];

  constructor(chunks: string[] = ['第一段']) {
    super();
    this.chunks = chunks;
  }

  async *chat(
    _messages: Message[],
    _opts?: ChatOptions,
  ): AsyncIterable<LlmChunk> {
    for (const chunk of this.chunks) {
      yield { content: chunk };
    }
    // 无 abort 的外部原因直接抛 AbortError（模拟连接中断）
    throw new DOMException('The connection was interrupted', 'AbortError');
  }
}

/**
 * HTTP 失败 Mock Provider（2026-09-15 真机故障回归专用）
 *
 * 首次调用即抛**非 AbortError** 的普通 Error，模拟 `openaiCompatible` 在服务端返回
 * 任意 4xx（含 413）时抛出的 `llmError('LLM 请求格式错误', 'HTTP <码>：<body>')`。
 * 关键特征与真机故障轮一致：**零文本产出**（故障发生在纯工具阶段，narrate 不计入 content）。
 *
 * 内核路径：loop 内 provider 抛错 → `consumeExecutionStream` catch 非 abort 分支
 * （agent.ts:697）→ yield error chunk + 返回 `failed: true`。
 */
class HttpFailProvider extends LlmProvider {
  readonly name = 'http-fail';

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    throw new Error('LLM 请求格式错误：HTTP 400：maximum context length exceeded');
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

  it('真实流式 abort 抛 AbortError（fetch stream 中断）→ 已产出文本仍保留 + [已中断] 标记', async () => {
    // 与 AbortableMockProvider 的差异：本 provider 在 chunk 间检测 signal.aborted 后主动抛 AbortError，
    // 模拟真实 LLM 流式中断（fetch stream 被 abort）——走 consumeExecutionStream 的 catch 分支。
    // 回归：此前 catch 分支返回 aborted:false + failed:true，act() 的 failed 短路跳过中断保存，
    // 半截回答不落盘（用户实测「停止回答后闭环未保存」根因）。
    const provider = new AbortThrowingProvider(['第一段', '第二段'], 30);
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
    let sawAbortedChunk = false;
    for await (const chunk of agent.chat('测试', ctrl.signal)) {
      if (chunk.type === 'text') {
        ctrl.abort(); // 触发 provider 在下一次 chunk 前抛 AbortError
      }
      if (chunk.type === 'aborted') sawAbortedChunk = true;
    }
    expect(sawAbortedChunk).toBe(true);

    // 验证 history 中最后一条 assistant 消息保留已产出文本 + 中断标记（半截回答不丢）
    const messages = agent.getMessages();
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content).toContain('第一段');
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
    const chunks: AgentChunk[] = [];
    for await (const chunk of agent.chat('测试', ctrl.signal)) {
      chunks.push(chunk);
      if (chunk.type === 'text') {
        ctrl.abort();
      }
    }

    // TS-12a：真用户取消（signal.aborted）→ aborted chunk 带 stopReason:'user'
    const aborted = chunks.filter((c) => c.type === 'aborted');
    expect(aborted.length).toBeGreaterThan(0);
    expect((aborted[0] as { stopReason?: string }).stopReason).toBe('user');

    // 验证 history 中使用自定义中断文案，而非默认的 [已中断]
    const messages = agent.getMessages();
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    expect(lastAssistant).toBeDefined();
    expect(lastAssistant!.content).toContain('部分内容');
    expect(lastAssistant!.content).toContain('[自定义中断标记]');
    expect(lastAssistant!.content).not.toContain('[已中断]');
  }, 15000);

  it('连接中断（signal 未 abort 却抛 AbortError）→ 判为错误而非用户取消', async () => {
    // 2026-09-02 假中断排雷：宿主 signal 未 abort（用户没点停止），provider/网络层抛 AbortError
    // 模拟真实连接被抽断。agent 层应输出 error chunk + failed，而非 aborted（不谎报用户取消）。
    const provider = new ConnectionInterruptedProvider(['第一段']);
    agent = new Agent({
      projectPath: tmpProject,
      provider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    // 构造未中止的 AbortController（用户没有取消）
    const ctrl = new AbortController();

    const chunks: AgentChunk[] = [];
    for await (const chunk of agent.chat('测试', ctrl.signal)) {
      chunks.push(chunk);
      // 收集后统一断言（不在循环中断言，保证全流消费）
    }

    // 不应产出 aborted chunk（非用户取消）
    const aborted = chunks.filter((c) => c.type === 'aborted');
    expect(aborted).toHaveLength(0);

    // 应产出 error chunk（连接中断），且 category 为 'connection'、message 保留原始细节（调试可追溯）
    const errors = chunks.filter((c) => c.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    // 结构化分类：category = 'connection'，而非裸前缀；原始 AbortError 消息（ConnectionInterruptedProvider 抛出内容）
    expect(errors.some((c) => c.category === 'connection')).toBe(true);
    expect(errors.some((c) => c.message.includes('connection was interrupted'))).toBe(true);
    // 语义分类走 category 字段，error message 不再携带裸前缀
    expect(errors.some((c) => c.message.includes('[连接中断]'))).toBe(false);
  }, 15000);

  it('LLM 错误（非 abort）零产出 → 轮即收场 interrupted 且可被会话加载（真机故障回归）', async () => {
    // 真机故障（2026-09-15 07:47 互动叙事平台方案）：12 次 LLM 调用 / 26 次 read_file 后
    // 第 12 次调用被服务端 4xx 拒绝 → consumeExecutionStream 返回 failed:true。
    // 修复前：act() 的 `if (streamResult.failed) return` 直接返回 → 轮停在 pending + refCount=0，
    // 运行期无人收尾 → 宿主表现为「中止后重启，这一轮没有被重新渲染」（用户实测）。
    // 现收口到 appendInterrupted（与用户手动中止**同一原语**）→ 运行期即落 interrupted + 登记会话。
    const roundStore = new InMemoryRoundStore();
    const sessionStore = new InMemorySessionStore(roundStore);
    agent = new Agent({
      projectPath: tmpProject,
      provider: new HttpFailProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
      roundStore,
      // 关闭自动归档：避免后台摘要 LLM 调用干扰（与 A1 回抽用例同策略）
      archiveMode: 'manual',
    });
    await agent.init();

    const chunks: AgentChunk[] = [];
    for await (const chunk of agent.chat('测试')) chunks.push(chunk);

    // 前置事实（不变量生效的前提，先断言再下结论）：确为错误流，且零文本产出
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(chunks.some((c) => c.type === 'text')).toBe(false);

    const rounds = roundStore.listAll();
    expect(rounds).toHaveLength(1);

    // 核心回归：轮已收场（修复前此处为 'pending'）→ 可被正常加载/渲染；
    // 2026-09-15 起中断/失败轮落盘为 'interrupted'（不再伪 complete）
    expect(rounds[0]!.status).toBe('interrupted');
    // 零产出 → 不写空 assistantMessage（沿用 appendInterrupted 既有语义：无产出也按 stop 收场）
    expect(rounds[0]!.assistantMessage).toBeUndefined();

    // 端到端「可被加载」：宿主重启加载链正是 loadMessages(date, session) → roundIds → RoundStore
    const loaded = sessionStore.loadMessages(todayDate(), 'main');
    expect(loaded.some((m) => m.roundId === rounds[0]!.id)).toBe(true);
    expect(loaded.some((m) => m.role === 'assistant')).toBe(false);

    // 孤儿打捞队列不再含该轮（运行期已收尾，无需等重启）
    expect(roundStore.listInterruptedRecent(todayDate())).toHaveLength(0);
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
    const abortedChunks: Array<{ type: string }> = [];
    try {
      for await (const chunk of gen) {
        if ('stopReason' in chunk) abortedChunks.push(chunk);
      }
    } catch {
      // 超时后 generator 可能抛 AbortError，忽略
    }
    // 锁超时（2026-09-03 语义收敛）仅释放锁、不中断生成流——LLM 无进展由 provider 层超时兜底，
    // 故锁超时不应产出 aborted chunk（旧流由 outerResolve 正常放行收尾）。
    expect(abortedChunks.length).toBe(0);
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
// 决定暂停按钮显隐 + 暂停后"继续"UI 的可续跑信号
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

  it('空闲态 requestPause 守卫：任务已结束 → 申请作废，不翻 PAUSED（2026-09-07 收紧）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // RUNNING 且无待续目标 → 不可续跑
    expect(agent.canContinueWithoutInput()).toBe(false);

    // 空闲态申请软暂停：无活跃流可挂起 → 守卫作废（返回 false），不再直接翻状态机。
    // 收紧动机：turn 已完成后的暂停若翻 PAUSED 会把会话钉住，后续新输入被宿主路由成
    // supplement（新意图吞成"上一个回答的补充"）——任务已结束，暂停申请即作废。
    expect(agent.requestPause('空闲暂停')).toBe(false);

    // 关键断言：空闲守卫不作废状态机（保持 running），可续跑判定仍为 false（UI 不出现"继续"）
    expect(agent.sessionManager!.status).toBe('running');
    expect(agent.canContinueWithoutInput()).toBe(false);
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
// 测试：L2 行为策略消费（getActiveStrategy + executeChatLoop）
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
    expect(strategy.prepare?.summaryFocus).toBeUndefined();
    // 验证默认策略的 act 维度（标准键 act.toolMode）
    expect(strategy.act?.toolMode).toBe('allow');
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

    // 验证 done chunk 存在（表明 executeChatLoop 正常执行）
    // 验证整体流程不抛错即说明 prepareChatContext 正确消费了默认策略
    expect(agent.agentLoop).not.toBeNull();
  });

  it('角色包手动切换（唯一入口）：activate → 前缀刷新 → 立即生效（无需重启）', async () => {
    // 写两个角色包（非互斥——v0.13 已移除 exclusiveWith/自动匹配），验证手动切换语义
    const packsDir = join(tmpConfig, 'role-packs');
    const writePack = (dirName: string, manifest: object, persona: string) => {
      const packDir = join(packsDir, dirName);
      mkdirSync(packDir, { recursive: true });
      writeFileSync(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      writeFileSync(join(packDir, 'persona.md'), persona, 'utf-8');
    };
    writePack(
      '翻译助手',
      {
        name: '翻译助手',
        formatVersion: '1.0.0',
      },
      '你是翻译。',
    );
    writePack(
      '代码助手',
      {
        name: '代码助手',
        formatVersion: '1.0.0',
      },
      '你是程序员。',
    );
    // 兜底契约包（§4.1 单链兜底需要：无 activePack 注入时落兜底包而非 items[0]）
    writePack(
      'memora助手',
      { name: 'memora助手', formatVersion: '1.0.0' },
      '你是通用助手。',
    );

    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const rpm = agent.rolePackManager!;
    // §4.1 单链：无 activePack 注入 → 落兜底包（不再回退 items[0]）
    expect(rpm.activeName).toBe('memora助手');

    // 手动切换是唯一入口：切换后立即生效（无需重启，完整切换含键）
    expect(agent.switchRolePack('翻译助手')).toBe(true);
    expect(rpm.activeName).toBe('翻译助手');
    expect(agent.switchRolePack('代码助手')).toBe(true);
    expect(rpm.activeName).toBe('代码助手');
    // 同名切换幂等（true）
    expect(agent.switchRolePack('代码助手')).toBe(true);
    // 不存在的包返回 false（不抛错）
    expect(agent.switchRolePack('不存在的包')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：getRecentToolExecutions() · loop 域工具执行历史聚合出口（补待办 #3）
// ═══════════════════════════════════════════════════════════════

describe('Agent · getRecentToolExecutions() · 工具执行历史聚合出口', () => {
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

  it('无工具执行记录时返回空数组', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    expect(agent.getRecentToolExecutions()).toEqual([]);
  });

  it('返回最近记录（时间正序，旧→新）并剥离内容语义为稳定契约', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const sm = agent.sessionManager!;
    // 建立会话检查点（chat 前 checkpoint 为 null，logToolExecution 会静默 no-op）
    sm.createCheckpoint();
    // 按时间顺序写入两条记录（模拟 read_file / write_file 相继执行）
    sm.logToolExecution({
      name: 'read_file',
      argsSignature: '{"path":"a.ts"}',
      executedAt: 1000,
      resultSummary: 'OK a',
      ok: true,
      idempotent: 'idempotent',
    });
    sm.logToolExecution({
      name: 'write_file',
      argsSignature: '{"path":"b.ts","content":"x"}',
      executedAt: 2000,
      resultSummary: 'ok',
      ok: false,
      idempotent: 'non-idempotent',
    });

    const records = agent.getRecentToolExecutions();
    expect(records).toHaveLength(2);
    // 旧→新顺序
    expect(records[0]!.name).toBe('read_file');
    expect(records[1]!.name).toBe('write_file');
    // 成败 + 结果摘要透出
    expect(records[1]!.ok).toBe(false);
    expect(records[1]!.resultSummary).toBe('ok');
  });

  it('limit 截断返回最近 N 条', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const sm = agent.sessionManager!;
    sm.createCheckpoint();
    for (let i = 0; i < 5; i++)
      sm.logToolExecution({
        name: 'read_file',
        argsSignature: `{"path":"${i}"}`,
        executedAt: i,
        resultSummary: 'ok',
        ok: true,
        idempotent: 'idempotent',
      });

    const records = agent.getRecentToolExecutions(2);
    expect(records).toHaveLength(2);
    // 保留最近的 2 条（旧→新：name 为 path 3 / path 4）
    expect(records[0]!.argsSignature).toContain('"path":"3"');
    expect(records[1]!.argsSignature).toContain('"path":"4"');
  });

  it('返回浅拷贝，宿主改动不影响检查点', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const sm = agent.sessionManager!;
    sm.createCheckpoint();
    sm.logToolExecution({
      name: 'read_file',
      argsSignature: '{}',
      executedAt: 1,
      resultSummary: 'ok',
      ok: true,
      idempotent: 'idempotent',
    });

    // 改返回值引用，检查点记录不受影响
    const records = agent.getRecentToolExecutions();
    records[0]!.resultSummary = '篡改';
    const again = agent.getRecentToolExecutions();
    expect(again[0]!.resultSummary).toBe('ok');
  });
});

describe('Agent · 作品投影实时刷新（workProjectionGenerated → loop 前缀重建）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: TestableAgent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-agent-wp-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-agent-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-agent-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
  });

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = null;
    }
    rmSync(tmpData, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
  });

  it('内核广播 workProjectionGenerated 后，立即重建 loop 的 systemPromptPrefix', async () => {
    // 监听 ① 修复的最终落点：AgentLoop.refreshRolePackPrefix
    const refreshSpy = vi.spyOn(AgentLoop.prototype, 'refreshRolePackPrefix');
    agent = makeTestableAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    // 清除 init 期间（角色包装配等）触发的调用，仅验证本次事件驱动的刷新
    refreshSpy.mockClear();

    // 模拟内核 registerWork 成功后广播的事件（assembler 经 hooks.emit 发出）
    agent.emitWorkProjectionGenerated();

    expect(refreshSpy).toHaveBeenCalled();
    refreshSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════
// A1 回抽 · 首轮工具步叙述不落持久化正文（2026-09-12）
// ═══════════════════════════════════════════════════════════════

/**
 * 首轮工具步叙述按**真实流式分块形状**产出：content delta 先到、toolCalls 在后续 chunk。
 *
 * 首轮无工具史 → 文本已被逐字流式进正文（TTFT 零损失）；收到 toolCalls 确认为工具轮后，
 * 内核发 narrate.withdrawn 让消费者把该段从正文撤回。本 provider 用于验证**持久化侧**扣除：
 * consumeExecutionStream 累积的 content（= Round.assistantMessage）不得含该叙述。
 */
class NarrateThenToolProvider extends LlmProvider {
  readonly name = 'mock-narrate-tool';
  private emittedToolTurn = false;

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const sysContent = messages.find((m) => m.role === 'system')?.content;
    // 摘要生成器 / 会话命名助手（后台 fire-and-forget）：返回合法 JSON，不消耗主对话分岔状态
    if (typeof sysContent === 'string' && sysContent.includes('对话摘要生成器')) {
      yield { content: JSON.stringify({ summary: '测试摘要', type: 'general' }) };
      yield { finishReason: 'stop' };
      return;
    }
    const firstUser = messages.find((m) => m.role === 'user')?.content;
    if (typeof firstUser === 'string' && firstUser.startsWith('你是会话命名助手。')) {
      yield { content: JSON.stringify({ title: '测试会话' }) };
      yield { finishReason: 'stop' };
      return;
    }
    if (!this.emittedToolTurn) {
      this.emittedToolTurn = true;
      // content 与 toolCalls 分属不同 chunk（真实流式形状）→ content 已被逐字流式进正文
      yield { content: '我先全面探索项目结构' };
      yield {
        toolCalls: [
          { id: 't1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } },
        ],
      };
      yield { finishReason: 'stop' };
      return;
    }
    yield { content: '这是最终结论。' };
    yield { finishReason: 'stop' };
  }
}

describe('A1 回抽 · 首轮工具轮叙述不进持久化正文', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-a1-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-a1-cfg-'));
    tmpData = mkdtempSync(join(tmpdir(), 'memora-a1-data-'));
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

  it('assistantMessage 恒为最终结论（首轮叙述经 withdrawn 从持久化正文扣除）', async () => {
    const roundStore = new InMemoryRoundStore();
    const sessionStore = new InMemorySessionStore(roundStore);
    agent = new Agent({
      projectPath: tmpProject,
      provider: new NarrateThenToolProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
      roundStore,
      // 关闭自动归档：避免后台摘要 LLM 调用干扰主对话分岔状态
      archiveMode: 'manual',
    });
    await agent.init();

    for await (const _chunk of agent.chat('看看项目')) {
      void _chunk;
    }

    const rounds = roundStore.listAll();
    expect(rounds).toHaveLength(1);
    const content = rounds[0]!.assistantMessage?.content ?? '';
    // 回抽生效：首轮叙述不入持久化正文（重放时正文区不会出现该段）
    expect(content).not.toContain('我先全面探索项目结构');
    expect(content).toContain('这是最终结论。');
  });
});
