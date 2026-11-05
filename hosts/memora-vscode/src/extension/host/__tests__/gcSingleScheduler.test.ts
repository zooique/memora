/**
 * 6.0.0 E6 验收：孤儿 Round GC 单点驱动（两实例共存 ⇒ 每周期只扫描一次）
 *
 * 背景：内核每个 Agent 实例各挂一个周期 GC 定时器（`GCService.startPeriodic`）；
 * B 方案下 N 个实例共享同一对 `sessionStore` / `roundStore` 单例（E3 硬约束），
 * 于是 N 个定时器会重复扫同一份存储。E6 的收口方式：
 *   1. 内核新增 `AgentOptions.autoStartGc`（false = 只登记不启动，`gcNow()` 仍可手动调用）；
 *   2. 宿主 `MemoryGcScheduler` 单点驱动，扫描对象 = 首个装配的 Agent（共享存储，扫一次覆盖全量）。
 *
 * 本用例的真实判据（计数断言，不靠肉眼）：
 *   ① 两实例以 `autoStartGc: false` 装配 ⇒ init 完成后**零扫描**（证明没有各自起定时器）；
 *   ② 单点调度器跑 3 个周期 ⇒ `listOrphaned` 恰好被调用 3 次（1 次 / 周期），
 *      而不是 6 次（两实例 × 3 周期）；
 *   ③ 两实例写入的轮文件零误删（引用集在扫描时现读，不因单点驱动漏删仍被引用的轮）；
 *   ④ `stopPeriodic` 后不再扫描（定时器解绑生效）。
 *
 * ⚠️ 使用假定时器推进周期；Agent 装配 / 对话在真实定时器下完成（避免 init 内部时序被篡改）。
 */
// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Agent,
  type AgentChunk,
  type IMemoryStorage,
  type LlmChunk,
  type LlmProvider,
  type Round,
} from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore, DEFAULT_SWEEP_MIN_AGE_MS } from '../workspaceRoundStore.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { resolveProjectDataDir } from '../projectDataDir.js';
import { MemoryGcScheduler } from '../memoryGcScheduler.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

/** 用例的两个会话标识（格式约束：YYYY-MM-DD-sessionName） */
const SESSION_A = '2026-11-05-e6a';
const SESSION_B = '2026-11-05-e6b';

/**
 * 计数型 RoundStore：把「一次 GC 扫描」的入口 `listOrphaned` 调用次数记下来
 *
 * 这是本用例唯一的扫描次数观测面——`GcService.run()` 每执行一次必调一次
 * `listOrphaned`，故计数即扫描次数。
 */
class CountingRoundStore extends WorkspaceRoundStore {
  /** 累计 `listOrphaned` 调用次数（= GC 扫描次数） */
  scanCalls = 0;

  /** 覆盖扫描入口：先计数，再走真实现（判据接线不改行为） */
  override listOrphaned(minAgeMs: number = DEFAULT_SWEEP_MIN_AGE_MS): Round[] {
    this.scanCalls += 1;
    return super.listOrphaned(minAgeMs);
  }
}

/** 极简 echo provider：只回显最后一条用户消息（本用例不关心模型输出） */
class EchoProvider {
  /** 实例标签（区分两个 Agent 的流） */
  constructor(private readonly name: string) {}

  /** 生成一条正文分片后结束 */
  async *chat(messages: Array<{ role: string; content?: string }>): AsyncIterable<LlmChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    yield { content: `echo(${this.name}):${lastUser?.content ?? ''}` };
    yield { finishReason: 'stop' };
  }
}

/** 播种最小角色包目录（Agent.init 需要兜底角色包） */
function seedRolePacks(configDir: string): void {
  // 兜底契约包：无 activePack 注入时内核落该包
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

/** 轮文件绝对路径（与 WorkspaceRoundStore 同口径） */
function roundFilePath(projectPath: string, roundId: string): string {
  return join(resolveProjectDataDir(projectPath), 'rounds', `${roundId}.json`);
}

/** 消费对话流，收集正文分片（判据只需要「跑完一轮」，不断言具体文案） */
async function drainChat(stream: AsyncIterable<AgentChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text') text += chunk.content;
  }
  return text;
}

/**
 * 构造一个 Agent（宿主装配镜像；GC 自启关闭 = E6 生产形态）
 *
 * @param projectPath 工作区根
 * @param configDir 配置目录
 * @param provider 该实例的 LLM provider
 * @param storage 该实例独有的记忆存储连接
 * @param sessionStore 共享会话存储单例
 * @param roundStore 共享轮次存储单例（计数型）
 */
function makeAgent(
  projectPath: string,
  configDir: string,
  provider: LlmProvider,
  storage: IMemoryStorage,
  sessionStore: WorkspaceSessionStore,
  roundStore: WorkspaceRoundStore,
): Agent {
  return new Agent({
    projectPath,
    dataDir: resolveProjectDataDir(projectPath),
    configDir,
    provider,
    // 只测 GC 调度：归档走 manual，避免后台摘要 LLM 调用引入时序噪声
    archiveMode: 'manual',
    permission: 'owner',
    allowedPaths: [projectPath],
    storage,
    sessionStore,
    roundStore,
    // E6 核心开关：只登记不启动——周期定时器由宿主单点调度器负责
    autoStartGc: false,
  });
}

describe('E6 · 孤儿 Round GC 单点驱动', () => {
  /** 待清理的 Agent（afterEach 逆序 close，防用例失败漏关） */
  const agents: Agent[] = [];

  afterEach(async () => {
    // 恢复真实定时器，防假定时器泄漏到其他测试文件（同进程复用）
    vi.useRealTimers();
    for (const agent of agents.reverse()) {
      await agent.close().catch(() => {
        // 关闭失败不影响判据结论（资源在临时目录，随目录删除回收）
      });
    }
    agents.length = 0;
  });

  it('两实例共存：每周期只扫描一次，且轮文件零误删', async () => {
    const projectPath = makeTempDir('memora-e6-gc-');
    const configDir = join(projectPath, 'config');
    seedRolePacks(configDir);

    // 共享单例（E3 硬约束）：先建 roundStore 并 load，再建 sessionStore（注入 referencedIds 真源）
    const roundStore = new CountingRoundStore(projectPath);
    roundStore.load();
    const sessionStore = new WorkspaceSessionStore(projectPath, roundStore);
    sessionStore.load();

    const agentA = makeAgent(
      projectPath,
      configDir,
      new EchoProvider('A') as unknown as LlmProvider,
      createHostMemoryStorage(projectPath),
      sessionStore,
      roundStore,
    );
    const agentB = makeAgent(
      projectPath,
      configDir,
      new EchoProvider('B') as unknown as LlmProvider,
      createHostMemoryStorage(projectPath),
      sessionStore,
      roundStore,
    );
    agents.push(agentA, agentB);

    await agentA.init();
    await agentB.init();

    // ── 断言①：autoStartGc:false ⇒ init 后零扫描（两实例都没挂自己的定时器） ──
    expect(roundStore.scanCalls).toBe(0);

    // 两个实例各写一轮（制造被引用、不可删的轮）
    await agentA.sessionManager!.switchToSession(SESSION_A);
    await agentB.sessionManager!.switchToSession(SESSION_B);
    await drainChat(agentA.chat('会话 A 的消息'));
    await drainChat(agentB.chat('会话 B 的消息'));

    const idsA = sessionStore.getRoundIds(SESSION_A);
    const idsB = sessionStore.getRoundIds(SESSION_B);
    expect(idsA.length).toBeGreaterThanOrEqual(1);
    expect(idsB.length).toBeGreaterThanOrEqual(1);
    const allRoundIds = [...idsA, ...idsB];

    // 装配/对话结束后切假定时器，用确定性的「周期推进」取代真实等待
    vi.useFakeTimers();

    // 单点调度器：扫描对象 = 首个实例（共享同一份存储，扫一次覆盖全量）
    const scheduler = new MemoryGcScheduler(() => agentA.gcNow());
    scheduler.startPeriodic(50);
    // 启动即扫一次（对齐内核 startPeriodic 语义）
    expect(roundStore.scanCalls).toBe(1);
    expect(scheduler.scanCount).toBe(1);

    // ── 断言②：推进 2 个周期 ⇒ 共 3 次扫描（1 次 / 周期；两实例不会翻倍成 6） ──
    vi.advanceTimersByTime(100);
    expect(roundStore.scanCalls).toBe(3);
    expect(scheduler.scanCount).toBe(3);

    // ── 断言③：被会话引用的轮零误删（引用集在扫描时现读，单点驱动不漏删） ──
    for (const roundId of allRoundIds) {
      expect(roundStore.getById(roundId)).not.toBeNull();
      expect(existsSync(roundFilePath(projectPath, roundId))).toBe(true);
    }

    // ── 断言④：停止后不再扫描（定时器解绑生效） ──
    scheduler.stopPeriodic();
    vi.advanceTimersByTime(200);
    expect(roundStore.scanCalls).toBe(3);
  }, 120_000);
});
