/**
 * EvalRunner 单元测试
 *
 * 覆盖：
 * - 构造 + 选项默认值
 * - runScenario 成功/失败/超时/Agent 抛错路径
 * - runScenarios 批量执行 + 部分失败 + EvalSummary 字段完整性
 *
 * 测试范式：用真实 Agent + MockProvider（不调用真实 LLM），
 * 每个场景创建独立 tmpDir，不污染真实文件系统。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import { EvalRunner } from '@/eval/evalRunner.js';
import type { EvalScenario } from '@/eval/evalTypes.js';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Provider
// ═══════════════════════════════════════════════════════════════

class MockProvider extends LlmProvider {
  readonly name = 'mock';

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const reply = `Mock 响应：${lastUser?.content ?? '(empty)'}`;
    yield { content: reply };
    yield { finishReason: 'stop' };
  }
}

/** 慢速 Provider，延迟后才返回，用于测试超时 */
class SlowProvider extends LlmProvider {
  readonly name = 'slow';

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    // 延迟超过 scenarioTimeoutMs，确保触发超时
    await new Promise((r) => setTimeout(r, 500));
    yield { content: '慢响应' };
    yield { finishReason: 'stop' };
  }
}

/** init 抛错的 Agent，用于测试错误隔离 */
class InitThrowingAgent extends Agent {
  override async init(): Promise<never> {
    throw new Error('init 故意抛错');
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/** 写入项目骨架文件，让 init() 能正常加载 */
function seedProject(configDir: string): void {
  mkdirSync(join(configDir, 'personas'), { recursive: true });
  writeFileSync(
    join(configDir, 'personas', 'default.md'),
    '---\nsource: persona\nname: 默认人格\nkeywords: 测试\n---\n\n你是一个测试助手。',
    'utf-8',
  );
}

/** 临时目录跟踪列表（afterEach 统一清理） */
const tmpDirs: string[] = [];

/**
 * 创建 Agent 工厂函数
 * @param provider 可选的 LLM Provider（默认 MockProvider）
 * @returns 每次调用创建新 Agent 的工厂函数
 */
function createAgentFactory(provider?: LlmProvider): () => Agent {
  return () => {
    const tmpData = mkdtempSync(join(tmpdir(), 'eval-runner-data-'));
    const tmpProject = mkdtempSync(join(tmpdir(), 'eval-runner-proj-'));
    const tmpConfig = mkdtempSync(join(tmpdir(), 'eval-runner-cfg-'));
    tmpDirs.push(tmpData, tmpProject, tmpConfig);
    seedProject(tmpConfig);
    return new Agent({
      projectPath: tmpProject,
      provider: provider ?? new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
  };
}

/** 创建 init 抛错的 Agent 工厂 */
function createThrowingAgentFactory(): () => Agent {
  return () => {
    const tmpData = mkdtempSync(join(tmpdir(), 'eval-throw-data-'));
    const tmpProject = mkdtempSync(join(tmpdir(), 'eval-throw-proj-'));
    const tmpConfig = mkdtempSync(join(tmpdir(), 'eval-throw-cfg-'));
    tmpDirs.push(tmpData, tmpProject, tmpConfig);
    seedProject(tmpConfig);
    return new InitThrowingAgent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
  };
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

describe('EvalRunner', () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  // ─── 构造 + 选项 ────────────────────────────────────────

  it('构造时应接受 createAgent 和可选的 scenarioTimeoutMs', () => {
    const runner = new EvalRunner({ createAgent: createAgentFactory() });
    expect(runner).toBeDefined();
    expect(typeof runner.runScenario).toBe('function');
    expect(typeof runner.runScenarios).toBe('function');
  });

  it('不传 scenarioTimeoutMs 时应使用默认值（不抛错）', () => {
    const runner = new EvalRunner({ createAgent: createAgentFactory() });
    expect(runner).toBeDefined();
  });

  // ─── runScenario 成功路径 ───────────────────────────────

  it('runScenario 成功路径：正常对话应通过 done 检查', { timeout: 30000 }, async () => {
    const runner = new EvalRunner({ createAgent: createAgentFactory() });
    const scenario: EvalScenario = {
      name: 'success-test',
      description: '正常对话应完成',
      input: '你好',
      expect: { done: true },
    };
    const result = await runner.runScenario(scenario);
    expect(result.passed).toBe(true);
    expect(result.name).toBe('success-test');
    expect(result.failures).toEqual([]);
    expect(result.collected.done).toBe(true);
  });

  // ─── runScenario 失败路径 ───────────────────────────────

  it('runScenario 失败路径：期望未满足时应返回 passed=false', { timeout: 30000 }, async () => {
    const runner = new EvalRunner({ createAgent: createAgentFactory() });
    const scenario: EvalScenario = {
      name: 'fail-test',
      description: '期望调用不存在的工具',
      input: '你好',
      expect: { toolsCalled: ['non_existent_tool'] },
    };
    const result = await runner.runScenario(scenario);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toContain('non_existent_tool');
  });

  // ─── runScenario 超时 ───────────────────────────────────

  it('runScenario 超时：scenarioTimeoutMs 触发后返回 passed=false', { timeout: 15000 }, async () => {
    const runner = new EvalRunner({
      createAgent: createAgentFactory(new SlowProvider()),
      scenarioTimeoutMs: 50,
    });
    const scenario: EvalScenario = {
      name: 'timeout-test',
      description: '应超时',
      input: '你好',
      expect: { done: true },
    };
    const result = await runner.runScenario(scenario);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toContain('超时');
  });

  // ─── runScenario Agent 抛错 ─────────────────────────────

  it('runScenario Agent 抛错：错误隔离，返回 passed=false', { timeout: 15000 }, async () => {
    const runner = new EvalRunner({ createAgent: createThrowingAgentFactory() });
    const scenario: EvalScenario = {
      name: 'error-test',
      description: 'Agent init 抛错',
      input: '你好',
      expect: { done: true },
    };
    const result = await runner.runScenario(scenario);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toContain('场景执行异常');
    expect(result.failures[0]).toContain('init 故意抛错');
  });

  // ─── runScenarios 批量执行 ──────────────────────────────

  it('runScenarios 批量执行：汇总 passed/failed/total', { timeout: 30000 }, async () => {
    const runner = new EvalRunner({ createAgent: createAgentFactory() });
    const scenarios: EvalScenario[] = [
      { name: 's1', description: '完成', input: '你好', expect: { done: true } },
      { name: 's2', description: '完成', input: '测试', expect: { done: true } },
    ];
    const summary = await runner.runScenarios(scenarios);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.results).toHaveLength(2);
    expect(summary.failedScenarios).toEqual([]);
  });

  // ─── runScenarios 部分失败 ──────────────────────────────

  it('runScenarios 部分失败：不中断其他场景', { timeout: 30000 }, async () => {
    const runner = new EvalRunner({ createAgent: createAgentFactory() });
    const scenarios: EvalScenario[] = [
      { name: 'pass-1', description: '通过', input: '你好', expect: { done: true } },
      {
        name: 'fail-1',
        description: '失败',
        input: '你好',
        expect: { toolsCalled: ['non_existent'] },
      },
      { name: 'pass-2', description: '通过', input: '测试', expect: { done: true } },
    ];
    const summary = await runner.runScenarios(scenarios);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failedScenarios).toEqual(['fail-1']);
    // 验证所有场景都执行了（即使中间有失败）
    expect(summary.results).toHaveLength(3);
    const names = summary.results.map((r) => r.name);
    expect(names).toEqual(['pass-1', 'fail-1', 'pass-2']);
  });

  // ─── EvalSummary 字段完整性 ─────────────────────────────

  it('EvalSummary 应包含完整字段', { timeout: 30000 }, async () => {
    const runner = new EvalRunner({ createAgent: createAgentFactory() });
    const summary = await runner.runScenarios([
      { name: 's1', description: '测试', input: '你好', expect: { done: true } },
    ]);
    expect(summary).toHaveProperty('results');
    expect(summary).toHaveProperty('passed');
    expect(summary).toHaveProperty('failed');
    expect(summary).toHaveProperty('total');
    expect(summary).toHaveProperty('durationMs');
    expect(summary).toHaveProperty('failedScenarios');
    expect(Array.isArray(summary.results)).toBe(true);
    expect(typeof summary.passed).toBe('number');
    expect(typeof summary.failed).toBe('number');
    expect(typeof summary.total).toBe('number');
    expect(typeof summary.durationMs).toBe('number');
    expect(Array.isArray(summary.failedScenarios)).toBe(true);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── 空场景列表 ─────────────────────────────────────────

  it('runScenarios 空列表应返回全零汇总', async () => {
    const runner = new EvalRunner({ createAgent: createAgentFactory() });
    const summary = await runner.runScenarios([]);
    expect(summary.total).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results).toEqual([]);
    expect(summary.failedScenarios).toEqual([]);
  });
});
