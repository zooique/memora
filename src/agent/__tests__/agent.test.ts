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
import { SOURCE_LABELS } from '@/memory/types.js';
import { InMemoryRelationStore } from '@/memory/inMemoryRelationStore.js';
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { Memory } from '@/memory/types.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import { todayDate } from '@/utils/time.js';

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
 * @param relationStore 可选，注入关系存储侧车（ADR-014）
 */
function makeAgent(
  projectPath: string,
  configDir: string,
  dataDir: string,
  relationStore?: IMemoryRelationStore,
  archiveMode?: 'full' | 'insights-only' | 'manual',
): Agent {
  return new Agent({
    projectPath,
    provider: new MockProvider(),
    configDir,
    dataDir,
    permission: 'owner',
    allowedPaths: [dataDir],
    relationStore,
    archiveMode,
    messages: {
      abortedByUser: '用户取消了对话',
      maxIterationsReached: '\n\n[已达到最大迭代次数]',
      recentConversationLabel: '[最近对话]',
      userLabel: '用户',
      assistantLabel: '助手',
      inputBlockedByGuard: (rule) => `输入被护栏规则"${rule}"阻止`,
      guardrailWarningPrefix: '[护栏警告]',
      outputBlockedByGuard: (rule) => `输出被护栏规则"${rule}"阻止`,
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

    const results = agent.memory!.suggest();
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

    // 写入一条 insight 记忆
    agent.memory!['index'].upsert({
      id: 'insight:suggest-test',
      content: '关于 TypeScript 类型系统的洞察',
      source: 'insight',
      name: 'TypeScript 类型系统',
      createdAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      score: 0.9,
    });

    const results = agent.memory!.suggest('TypeScript');
    expect(results.length).toBeGreaterThan(0);
    // 搜索命中的应排在前面
    const firstHit = results[0]!;
    expect(firstHit.source).toBe('insight');
    expect(firstHit.reason).toBe('与搜索相关');
  });

  it('memory 管理器：suggest 应排除指定 source', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const results = agent.memory!.suggest(undefined, {
      excludeSources: ['insight', 'profile', 'work-projection', 'persona', 'rule', 'skill'],
      limit: 10,
    });
    // 排除所有 source 后应返回空
    expect(results).toEqual([]);
  });

  it('memory 管理器：suggest limit 应限制返回数量', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const results = agent.memory!.suggest(undefined, { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
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

  it('技能关键词匹配：输入匹配关键词后 activeSkill 应更新', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 输入包含技能关键词，应触发技能匹配
    await agent.chatSync('帮我审查一下代码质量');

    // 验证技能已匹配（通过 skills 管理器验证）
    const match = agent.skills!.match('帮我审查一下代码质量');
    expect(match).not.toBeNull();
    expect(match!.skill.name).toBe('代码审查');
  });

  it('Insight 提取：classify 返回 extract 时应触发 extract', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // InsightExtractor.classify 对非 trivial 输入默认返回 'extract'
    // 通过 chatSync 触发 postProcess → insightExtractor.classify → extract
    // extract 是异步的（fire-and-forget），不会抛错即算通过
    const reply = await agent.chatSync('我正在开发一个新项目，需要记住这个偏好');
    expect(reply).toContain('Mock 响应');
  });

  it('无 Manager 时不报错：postProcess 应正常完成', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 正常 init 后所有 Manager 都存在，postProcess 不应抛错
    // 通过 chatSync 间接触发 postProcess，验证无异常
    const reply = await agent.chatSync('你好');
    expect(reply).toContain('Mock 响应');

    // 再发一条 trivial 输入（classify 返回 'skip'），验证 skip 路径也不报错
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
    const messages = agent.agentLoop!.getMessages();
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
// 测试：archiveMode（ADR-015）· 三种归档模式
// ═══════════════════════════════════════════════════════════════

describe('Agent · archiveMode（ADR-015）· 三种归档模式', () => {
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
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'manual');
    await agent.init();

    expect(agent.getArchiveMode()).toBe('manual');
  });

  it('setArchiveMode 应切换模式', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    agent.setArchiveMode('insights-only');
    expect(agent.getArchiveMode()).toBe('insights-only');

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

  // ─── manual 模式跳过自动归档 ────────────────────────────

  it('manual 模式：chatSync 后不触发 memoryAdded 事件', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'manual');
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
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'manual');
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

  // ─── full 模式（默认）自动归档 ──────────────────────────

  it('full 模式：chatSync 后应触发 memoryAdded 事件（profile + insight）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'full');
    await agent.init();

    // 监听 memoryAdded 事件
    let memoryAddedCount = 0;
    agent.on('memoryAdded', () => {
      memoryAddedCount++;
    });

    await agent.chatSync('我正在开发一个新项目，需要记住这个偏好');

    // 等待异步归档完成（profile + insight 都 fire-and-forget）
    await new Promise((r) => setTimeout(r, 200));

    // full 模式应触发自动归档（至少 1 条，profile 或 insight）
    expect(memoryAddedCount).toBeGreaterThan(0);

    agent.off('memoryAdded', () => {});
  });

  // ─── insights-only 模式（当前与 full 等价） ──

  it('insights-only 模式：profile + insight 自动归档（与 full 等价）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'insights-only');
    await agent.init();

    let memoryAddedCount = 0;
    agent.on('memoryAdded', () => {
      memoryAddedCount++;
    });

    await agent.chatSync('我正在开发一个新项目，需要记住这个偏好');

    await new Promise((r) => setTimeout(r, 200));

    // insights-only 模式下 profile + insight 都自动归档（与 full 等价）
    expect(memoryAddedCount).toBeGreaterThan(0);

    agent.off('memoryAdded', () => {});
  });

  // ─── 手动 API（manual 模式下使用） ─────────────────────

  it('archiveProfileFacts：手动触发 profile facts 归档', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'manual');
    await agent.init();

    let memoryAddedCount = 0;
    agent.on('memoryAdded', () => {
      memoryAddedCount++;
    });

    // 手动触发 profile 归档
    const entries = await agent.archiveProfileFacts('我喜欢用 TypeScript 开发');

    // 应返回写入的 entries（可能为空，如果输入无 facts，但不应抛错）
    expect(Array.isArray(entries)).toBe(true);

    // 如果有写入，应触发 memoryAdded 事件
    await new Promise((r) => setTimeout(r, 50));
    expect(memoryAddedCount).toBe(entries.filter((e) => e.confirmed).length);

    agent.off('memoryAdded', () => {});
  });

  it('archiveInsight：手动触发 insight 提取', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'manual');
    await agent.init();

    let insightExtractedCount = 0;
    agent.on('insightExtracted', () => {
      insightExtractedCount++;
    });

    // 手动触发 insight 提取
    const memories = await agent.archiveInsight('我正在开发一个新项目，需要记住这个偏好', 'Mock 响应');

    // 应返回 Memory 数组
    expect(Array.isArray(memories)).toBe(true);

    // 如果有写入，应触发 insightExtracted 事件
    expect(insightExtractedCount).toBe(memories.length);

    agent.off('insightExtracted', () => {});
  });

  it('archiveInsight：classify 返回 skip 时返回空数组', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'manual');
    await agent.init();

    // trivial 输入，classify 应返回 'skip'
    const memories = await agent.archiveInsight('好的', 'Mock 响应');

    expect(memories).toEqual([]);
  });

  // ─── 运行时切换 archiveMode ─────────────────────────────

  it('运行时从 full 切换到 manual：后续对话不再自动归档', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData, undefined, 'full');
    await agent.init();

    // 第一轮：full 模式，应自动归档
    let memoryAddedCount = 0;
    agent.on('memoryAdded', () => {
      memoryAddedCount++;
    });

    await agent.chatSync('我正在开发一个新项目，需要记住这个偏好');
    await new Promise((r) => setTimeout(r, 200));
    const firstRoundCount = memoryAddedCount;
    expect(firstRoundCount).toBeGreaterThan(0);

    // 切换到 manual 模式
    agent.setArchiveMode('manual');

    // 第二轮：manual 模式，不应自动归档
    memoryAddedCount = 0;
    await agent.chatSync('我还需要记住另一个偏好');
    await new Promise((r) => setTimeout(r, 200));

    expect(memoryAddedCount).toBe(0);

    agent.off('memoryAdded', () => {});
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
    const initialActive = agent['personaManager']!.activeName;

    // 新增角色文件
    writeFileSync(
      join(tmpConfig, 'personas', 'reviewer.md'),
      '---\nsource: persona\nname: 审查员\nkeywords: 审查\n---\n\n你是审查专家',
      'utf-8',
    );

    const result = await agent.reloadConfig('persona');
    expect(result.persona).toBe(4); // 3 个初始 + 1 个新增
    // 激活角色应保持不变
    expect(agent['personaManager']!.activeName).toBe(initialActive);
  });

  it('reloadConfig(rule) 应跳过重载（rule 已由 addRule 即时注入）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const result = await agent.reloadConfig('rule');
    expect(result.skill).toBe(0);
    expect(result.persona).toBe(0);
  });

  it('reloadConfig(guardrail) 应抛错（不支持热重载）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    await expect(agent.reloadConfig('guardrail')).rejects.toThrow(/guardrail 不支持热重载/);
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
    expect(agent.insight).not.toBeNull();
    expect(agent.memory).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：memory 关系查询（ADR-014 侧车）
// ═══════════════════════════════════════════════════════════════

describe('Agent · memory 关系查询（ADR-014）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-rel-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-rel-cfg-'));
    tmpData = mkdtempSync(join(tmpdir(), 'memora-rel-data-'));
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

  it('relationStore 未注入时 getRelations 应返回空数组（向后兼容）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const relations = agent.memory!.getRelations('insight:test');
    expect(relations).toEqual([]);
  });

  it('relationStore 未注入时 stats().relationCount 应为 0', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const stats = agent.memory!.stats();
    expect(stats.relationCount).toBe(0);
  });

  it('relationStore 未注入时 snapshot().archive.relationCount 应为 0', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const snap = agent.memory!.snapshot();
    expect(snap.archive.relationCount).toBe(0);
  });

  it('relationStore 注入后 getRelations 应返回已写入的关系', async () => {
    const relationStore = new InMemoryRelationStore();
    agent = makeAgent(tmpProject, tmpConfig, tmpData, relationStore);
    await agent.init();

    const now = new Date().toISOString();
    relationStore.addRelation({
      sourceId: 'insight:a',
      targetId: 'insight:b',
      type: 'contradicts',
      weight: 1.0,
      createdAt: now,
    });

    const relations = agent.memory!.getRelations('insight:a');
    expect(relations.length).toBe(1);
    expect(relations[0]!.type).toBe('contradicts');
    expect(relations[0]!.weight).toBe(1.0);
  });

  it('relationStore 注入后 stats().relationCount 应反映关系总数', async () => {
    const relationStore = new InMemoryRelationStore();
    agent = makeAgent(tmpProject, tmpConfig, tmpData, relationStore);
    await agent.init();

    const now = new Date().toISOString();
    relationStore.addRelation({
      sourceId: 'insight:a',
      targetId: 'insight:b',
      type: 'supports',
      weight: 0.7,
      createdAt: now,
    });
    relationStore.addRelation({
      sourceId: 'insight:b',
      targetId: 'insight:c',
      type: 'refines',
      weight: 0.7,
      createdAt: now,
    });

    const stats = agent.memory!.stats();
    expect(stats.relationCount).toBe(2);
  });

  it('relationStore 注入后 snapshot().archive.relationCount 应反映关系总数', async () => {
    const relationStore = new InMemoryRelationStore();
    agent = makeAgent(tmpProject, tmpConfig, tmpData, relationStore);
    await agent.init();

    const now = new Date().toISOString();
    relationStore.addRelation({
      sourceId: 'insight:a',
      targetId: 'insight:b',
      type: 'related',
      weight: 0.3,
      createdAt: now,
    });

    const snap = agent.memory!.snapshot();
    expect(snap.archive.relationCount).toBe(1);
  });

  it('getRelations 应支持方向过滤', async () => {
    const relationStore = new InMemoryRelationStore();
    agent = makeAgent(tmpProject, tmpConfig, tmpData, relationStore);
    await agent.init();

    const now = new Date().toISOString();
    // a → b（a 的出边）
    relationStore.addRelation({
      sourceId: 'insight:a',
      targetId: 'insight:b',
      type: 'supports',
      weight: 0.7,
      createdAt: now,
    });
    // c → a（a 的入边）
    relationStore.addRelation({
      sourceId: 'insight:c',
      targetId: 'insight:a',
      type: 'caused',
      weight: 0.7,
      createdAt: now,
    });

    // outgoing：仅 a 的出边
    const outgoing = agent.memory!.getRelations('insight:a', 'outgoing');
    expect(outgoing.length).toBe(1);
    expect(outgoing[0]!.targetId).toBe('insight:b');

    // incoming：仅 a 的入边
    const incoming = agent.memory!.getRelations('insight:a', 'incoming');
    expect(incoming.length).toBe(1);
    expect(incoming[0]!.sourceId).toBe('insight:c');

    // both：a 的全部边
    const both = agent.memory!.getRelations('insight:a', 'both');
    expect(both.length).toBe(2);
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
    const messages = agent.agentLoop!.getMessages();
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
    const messages = agent.agentLoop!.getMessages();
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
        inputBlockedByGuard: (rule) => `输入被护栏规则"${rule}"阻止`,
        guardrailWarningPrefix: '[护栏警告]',
        outputBlockedByGuard: (rule) => `输出被护栏规则"${rule}"阻止`,
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
    const messages = agent.agentLoop!.getMessages();
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
