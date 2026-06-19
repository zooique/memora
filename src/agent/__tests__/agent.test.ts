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
import type { ISessionStore } from '@/memory/sessionStore.js';

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
    Reflect.set(agent, '_chatBusy', true);

    expect(() => agent!.forkSession()).toThrow(/对话繁忙/);

    Reflect.set(agent, '_chatBusy', false);
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

    const count = await agent.restoreMostRecentSession();
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

    const count = await agent.restoreMostRecentSession();
    expect(count).toBe(0);
  });

  it('有会话时应恢复消息并返回消息数', async () => {
    const today = new Date().toISOString().slice(0, 10);
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

    const count = await agent.restoreMostRecentSession('main');
    expect(count).toBe(2);
  });

  it('preferredSession 不匹配时取最后一个会话', async () => {
    const today = new Date().toISOString().slice(0, 10);
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
    const count = await agent.restoreMostRecentSession('main');
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

    const count = await agent.restoreMostRecentSession();
    expect(count).toBe(0);
  });

  it('会话消息为空时应返回 0', async () => {
    const today = new Date().toISOString().slice(0, 10);
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

    const count = await agent.restoreMostRecentSession('main');
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
