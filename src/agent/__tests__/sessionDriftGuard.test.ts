/**
 * E2 验收：turn 内会话漂移判据（**防御性判据**，不是已知 bug 的修复）
 *
 * ## 勘察结论（写代码前已完成）
 * - **有闸面**：`SessionManager.switchSession` / `forkSession` / `switchToSession` 均经
 *   `assertSessionReplaceable`（`isChatBusy` + 状态机）⇒ 正常宿主路径在 turn 内切会话会被挡住。
 * - **绕过面（真实存在）**：`Agent.agentHistory` 是**公开 getter**，其暴露的
 *   `MessageHistory.switchSession` / `MessageHistory.forkSession` **自身不判忙**（闸在 SessionManager）
 *   ⇒ 调用方可绕过闸直接改 `currentSession`。
 * - 故本判据是「把隐含前提显式化 + 拦截绕过面」，**不是**修复某条已知生产 bug；
 *   注释与错误文案不得写成「修复了漂移 bug」。
 *
 * ## 判据
 * `chat()` 持锁后快照 `history.currentSessionName`；turn 内身份写点（appendUser /
 * createCheckpoint / clearPlanOnTurnEnd）逐点比对，不等即抛 `sessionDriftError`。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import type { AgentChunk } from '@/agent/types.js';
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';

/**
 * 漂移 Provider：首次被调用时执行一次注入回调（模拟「绕过闸直接改会话」），
 * 之后正常回显收尾，让 turn 走完直到末写点判据触发。
 */
class DriftProvider extends LlmProvider {
  readonly name = 'drift';

  /** chat 被调用次数（只在第一次注入漂移） */
  private callCount = 0;

  /**
   * @param onFirstCall 首次 chat 调用时执行的注入动作（由用例提供）
   */
  constructor(private readonly onFirstCall: () => void) {
    super();
  }

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    if (this.callCount === 0) this.onFirstCall();
    this.callCount += 1;
    yield { content: '漂移测试回答' };
    yield { finishReason: 'stop' };
  }
}

/** 正常回显 Provider（无漂移对照） */
class EchoProvider extends LlmProvider {
  readonly name = 'echo';

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    yield { content: `echo:${lastUser?.content ?? ''}` };
    yield { finishReason: 'stop' };
  }
}

/**
 * 播种角色包（与 `agent.test.ts` 的 seedProject 同形态）
 *
 * @param configDir 配置目录
 */
function seedProject(configDir: string): void {
  const defaultDir = join(configDir, 'role-packs', '默认助手');
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(
    join(defaultDir, 'manifest.json'),
    JSON.stringify({ name: '默认助手', displayName: '默认助手', strategy: {} }),
    'utf-8',
  );
  writeFileSync(join(defaultDir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  const fallbackDir = join(configDir, 'role-packs', 'memora助手');
  mkdirSync(fallbackDir, { recursive: true });
  writeFileSync(
    join(fallbackDir, 'manifest.json'),
    JSON.stringify({ name: 'memora助手', formatVersion: '1.0.0' }),
    'utf-8',
  );
  writeFileSync(join(fallbackDir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  mkdirSync(join(configDir, 'skills'), { recursive: true });
}

/**
 * 构造 Agent（测试用最小装配）
 *
 * @param projectPath 项目根（临时目录）
 * @param configDir 配置目录
 * @param dataDir 数据目录
 * @param provider LLM provider
 */
function makeAgent(
  projectPath: string,
  configDir: string,
  dataDir: string,
  provider: LlmProvider,
): Agent {
  return new Agent({
    projectPath,
    provider,
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
    },
  });
}

/**
 * 消费对话流（收集正文分片，供「不抛错」对照用）
 *
 * @param stream `agent.chat()` 返回的异步流
 */
async function drainChat(stream: AsyncIterable<AgentChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text') text += chunk.content;
  }
  return text;
}

describe('E2 · turn 内会话漂移判据', () => {
  /** 项目临时目录 */
  let projectPath: string;
  /** 配置临时目录 */
  let configDir: string;
  /** 数据临时目录 */
  let dataDir: string;
  /** 当前用例的 Agent */
  let agent: Agent | null = null;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'memora-drift-proj-'));
    configDir = mkdtempSync(join(tmpdir(), 'memora-drift-cfg-'));
    dataDir = mkdtempSync(join(tmpdir(), 'memora-drift-data-'));
    seedProject(configDir);
  });

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = null;
    }
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('对照：正常 turn 无漂移，快照不误报且结束后清空', async () => {
    agent = makeAgent(projectPath, configDir, dataDir, new EchoProvider());
    await agent.init();

    const text = await drainChat(agent.chat('你好'));
    // 输入会被包进 `<user_input>` 标签，故只断言回显前缀与用户原文都在
    expect(text).toContain('echo:');
    expect(text).toContain('你好');
    // turn 结束后快照已清：此时再比对是零副作用（不抛错）
    expect(() => agent!.agentHistory!.assertTurnSessionStable('turn 结束后探针')).not.toThrow();
  }, 30_000);

  it('漂移：turn 内绕过 busy 闸直接 switchSession ⇒ 抛会话漂移', async () => {
    // 注入动作引用 agent（构造后才可用）：绕过 SessionManager，直接改 MessageHistory 的当前会话
    let injected: string | null = null;
    const provider = new DriftProvider(() => {
      injected = agent!.agentHistory!.switchSession('drifted');
    });
    agent = makeAgent(projectPath, configDir, dataDir, provider);
    await agent.init();

    // 末写点（clearPlanOnTurnEnd）比对快照 ⇒ 抛 sessionDriftError
    await expect(drainChat(agent.chat('会漂移的输入'))).rejects.toThrow(/会话漂移/);
    expect(injected).not.toBeNull();
  }, 30_000);
});
