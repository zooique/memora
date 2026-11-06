/**
 * 6.0.0 批 1 验收 ④：fork 后父子会话**同时各跑一轮**（20 次零差异）
 *
 * 背景（口径真源 = `tasks/6.0.0-落地排产表-临时.md` §2 批 1）：
 * ② 同会话第二写者被拒、③ kill 后锁自愈、① 两进程不同会话 20 轮零丢失，
 * 已由 `sessionLockAcceptance.test.ts` 逐条覆盖（① 另有 `sessionSplitAcceptance.test.ts` 同型用例）。
 * **唯独 ④ 从未被完整机判**：`roundRefFreezeAcceptance.test.ts` 有 fork，但「父子同时各跑一轮」
 * 是同一进程内顺序调用，不是并发；`multiInstanceSharedProject.test.ts` 有两 Agent 并发，
 * 但没有 fork 关系。
 *
 * 本文件只补这一条，判据逐字对齐原文：
 *   1. fork 后父子会话**同时**各跑一轮（两 Agent 并发 `chat`）；
 *   2. 两个会话轮次都完整（会话 `roundIds` 里的每个 ID 都能读回且为 `complete`）；
 *   3. 原 `complete` 仍 `complete`（无回滚）——以**轮文件 sha256 前后不变**为判据；
 *   4. GC 后**有引用轮不被误删**：`sweepOrphans(0)` 不回收任何被会话引用的轮；
 *      同时用一个人造孤儿反证「GC 仍能收无引用轮」（否则「不误删」可能是 GC 根本没工作）；
 *   5. **重复 20 次零差异**：每轮都做上述同一组断言（40 轮新增全部落在盘上且旧轮字节不变）。
 *
 * 铁律（memora-host-e2e-persistence）：宿主测试跑构建后的内核（dist），
 * 改过内核 src 须先 `npm run build`；store 必须先 load()；免 API Key 用桩 provider。
 */
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  setLogger,
  type AgentChunk,
  type IMemoryStorage,
  type LlmChunk,
  type LlmProvider,
  type Round,
} from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { resolveProjectDataDir } from '../projectDataDir.js';

// 宿主持久层间接依赖 vscode；本用例只走文件落盘链路，不需要真实 VS Code 运行时
vi.mock('vscode', () => ({
  Uri: { joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }), fsPath: '/mock' },
  window: {
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
}));

/** 父会话在测试内的固定标识（switchToSession 要求 YYYY-MM-DD-sessionName 格式） */
const PARENT_SESSION = '2026-11-06-parent';

/** 迭代次数（原文「重复 20 次零差异」） */
const ITERATIONS = 20;

/**
 * 回显 Provider：每轮吐一段正文后收尾（无工具调用，最小 turn）
 *
 * 内核只把 `LlmProvider` 作 type 导出（不能 extends），故用类 + `as unknown as LlmProvider`
 * （与 `multiInstanceSharedProject.test.ts` 同款写法）。
 */
class EchoProvider {
  /** Provider 名（日志/会话命名可见） */
  readonly name: string;
  /** 结构化输出能力声明（本用例不依赖） */
  readonly supportsStructuredOutput = false;

  /**
   * @param name Provider 名（区分父子两个实例的输出）
   */
  constructor(name: string) {
    this.name = name;
  }

  /**
   * 一轮回答：回显最后一条 user 内容
   *
   * @param messages 对话消息（只读最后一条 user）
   */
  async *chat(messages: Array<{ role: string; content?: string }>): AsyncIterable<LlmChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    yield { content: `echo(${this.name}):${lastUser?.content ?? ''}` };
    yield { finishReason: 'stop' };
  }
}

/**
 * 播种角色包目录（与既有宿主测试同形态，防装配期落兜底包失败）
 *
 * @param configDir Agent 配置目录
 */
function seedRolePacks(configDir: string): void {
  const pairs: Array<[string, string]> = [
    ['默认助手', JSON.stringify({ name: '默认助手', displayName: '默认助手', strategy: {} })],
    ['memora助手', JSON.stringify({ name: 'memora助手', formatVersion: '1.0.0' })],
  ];
  for (const [dirName, manifest] of pairs) {
    const dir = join(configDir, 'role-packs', dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), manifest, 'utf-8');
    writeFileSync(join(dir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  }
  mkdirSync(join(configDir, 'skills'), { recursive: true });
}

/**
 * 消费一个 Agent 的对话流，收集正文分片
 *
 * @param stream `agent.chat()` 返回的异步流
 */
async function drainChat(stream: AsyncIterable<AgentChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text') text += chunk.content;
    // 错误/中断必须显式抛出：否则吞掉错误会让「chat 没产出轮」看起来像空操作（假绿/假红）
    if (chunk.type === 'error') throw new Error(`chat error: ${chunk.category}: ${chunk.message}`);
    if (chunk.type === 'aborted')
      throw new Error(`chat aborted: ${chunk.stopReason}: ${chunk.reason}`);
  }
  return text;
}

describe('6.0.0 批 1 验收 ④：fork 父子会话同时各跑一轮', () => {
  /** 临时工作区根 */
  let ws: string;
  /** 配置目录 */
  let configDir: string;
  /** 共享轮存储（生产装配形态：单例注入多 Agent） */
  let roundStore: WorkspaceRoundStore;
  /** 共享会话存储 */
  let sessionStore: WorkspaceSessionStore;
  /** 父会话 Agent */
  let agentParent: Agent;
  /** 子会话 Agent（fork 出来的会话） */
  let agentChild: Agent;
  /** 每个 Agent 独立的记忆连接（生产 assemble 每次新建） */
  let storageParent: IMemoryStorage;
  let storageChild: IMemoryStorage;
  /** 父会话 ID（真实落盘名，fork 前读取，不硬编码日期） */
  let parentId: string;
  /** 子会话 ID（fork 返回，形如 `<date>-<newSession>`） */
  let childId: string;

  beforeAll(async () => {
    // 静默内核日志：本用例只看盘面判据，日志噪声会淹没失败原因
    setLogger({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

    ws = mkdtempSync(join(tmpdir(), 'memora-fork-concurrent-'));
    configDir = join(ws, 'config');
    seedRolePacks(configDir);

    // 共享单例：先建 roundStore 并 load，再建 sessionStore（构造时注入引用真源）
    roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();
    sessionStore = new WorkspaceSessionStore(ws, roundStore);
    sessionStore.load();

    storageParent = createHostMemoryStorage(ws);
    storageChild = createHostMemoryStorage(ws);

    agentParent = makeAgent(new EchoProvider('parent') as unknown as LlmProvider, storageParent);
    agentChild = makeAgent(new EchoProvider('child') as unknown as LlmProvider, storageChild);
    await agentParent.init();
    await agentChild.init();

    // 父会话切到测试自有会话（switchToSession 对不存在的会话按「新建空会话」处理）
    await agentParent.sessionManager!.switchToSession(PARENT_SESSION);
    const history = agentParent.agentHistory!;
    for (let i = 0; i < 3; i++) {
      const id = `round-fork-base-${i}`;
      await history.appendUser(`基准问 ${i}`, id);
      await history.appendAssistant(`基准答 ${i}`, id);
    }
    parentId = history.currentSessionName;

    // fork：以父会话末位轮为分叉点（真实生产路径，只复制 roundIds 指针）
    const forkPoint = sessionStore.getRoundIds(parentId).at(-1)!;
    const fork = history.forkSession(forkPoint);
    childId = `${fork.date}-${fork.newSession}`;
    expect(fork.roundIds.length).toBe(3);

    // 父子各回自己的会话，准备并发
    // 注：forkSession 会把 current 切到新会话，必须经 sessionManager 显式切回（只改 history 不生效）
    await agentParent.sessionManager!.switchToSession(parentId);
    await agentChild.sessionManager!.switchToSession(childId);

    // 前置事实：父子会话当前各持同一批 3 个轮（fork 语义 = 共享指针，不拷贝文件）
    expect(sessionStore.getRoundIds(parentId)).toEqual(fork.roundIds);
    expect(sessionStore.getRoundIds(childId)).toEqual(fork.roundIds);
  }, 120_000);

  afterAll(async () => {
    await agentParent?.close().catch(() => {});
    await agentChild?.close().catch(() => {});
    // 外部注入的存储在 Agent.close 后不归 Agent 关闭（所有权语义），测试自己释放
    storageParent?.close?.();
    storageChild?.close?.();
    setLogger(undefined);
    if (ws) rmSync(ws, { recursive: true, force: true });
  });

  /**
   * 构造一个 Agent（宿主装配镜像：外部注入 storage / sessionStore / roundStore）
   *
   * @param provider 该实例的 LLM provider
   * @param storage 该实例独有的记忆存储连接
   */
  function makeAgent(provider: LlmProvider, storage: IMemoryStorage): Agent {
    return new Agent({
      projectPath: ws,
      dataDir: resolveProjectDataDir(ws),
      configDir,
      provider,
      // manual：不引入后台摘要 LLM 调用的时序噪声（本判据只关注落盘与并发）
      archiveMode: 'manual',
      permission: 'owner',
      allowedPaths: [ws],
      storage,
      sessionStore,
      roundStore,
    });
  }

  /** rounds 目录快照：轮文件名 → sha256（排除 index.json 自身） */
  function snapshotRoundFiles(): Map<string, string> {
    const roundsDir = join(resolveProjectDataDir(ws), 'rounds');
    const map = new Map<string, string>();
    if (!existsSync(roundsDir)) return map;
    for (const name of readdirSync(roundsDir).sort()) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      map.set(
        name,
        createHash('sha256')
          .update(readFileSync(join(roundsDir, name)))
          .digest('hex'),
      );
    }
    return map;
  }

  it('20 次并发父子各跑一轮：轮次完整、原 complete 不回滚、GC 不误删引用轮', async () => {
    // 每轮迭代前后比对的基线：所有既有轮文件（旧轮字节必须一成不变）
    for (let i = 0; i < ITERATIONS; i++) {
      // ⚠️ 必须拷贝：getRoundIds 返回内部数组引用，直接持有会被后续 append 原地污染（前后快照相等）
      const beforeParent = [...sessionStore.getRoundIds(parentId)];
      const beforeChild = [...sessionStore.getRoundIds(childId)];
      const beforeFiles = snapshotRoundFiles();

      // 父子会话**同一 tick 并发**各跑一轮（两 Agent 共享 store 单例，各写各的轮文件）
      await Promise.all([
        drainChat(agentParent.chat(`第 ${i} 次：父会话的问题`)),
        drainChat(agentChild.chat(`第 ${i} 次：子会话的问题`)),
      ]);

      const afterParent = sessionStore.getRoundIds(parentId);
      const afterChild = sessionStore.getRoundIds(childId);

      // ① 轮次完整：每会话恰好新增 1 轮，且新 ID 不与他人撞车
      expect(afterParent.length).toBe(beforeParent.length + 1);
      expect(afterChild.length).toBe(beforeChild.length + 1);
      const newParent = afterParent.filter((id) => !beforeParent.includes(id));
      const newChild = afterChild.filter((id) => !beforeChild.includes(id));
      expect(newParent).toHaveLength(1);
      expect(newChild).toHaveLength(1);
      expect(newParent[0]).not.toBe(newChild[0]);

      // ② 新轮真的落在盘上，且已收场为 complete（不是 pending 半成品）
      for (const id of [newParent[0]!, newChild[0]!]) {
        const round = roundStore.getById(id);
        expect(round, `新轮 ${id} 读不回来`).not.toBeNull();
        expect(round!.status).toBe('complete');
      }

      // ③ 原 complete 不回滚：本次迭代开始前盘上的每个轮文件，字节 sha256 必须完全不变
      const afterFiles = snapshotRoundFiles();
      for (const [name, hash] of beforeFiles) {
        expect(afterFiles.get(name), `旧轮文件被改写：${name}`).toBe(hash);
      }

      // ④ 会话 roundIds 中的每个 ID 都可读回（引用不悬空）
      for (const id of [...afterParent, ...afterChild]) {
        expect(roundStore.getById(id), `引用悬空：${id}`).not.toBeNull();
      }
    }

    // ── 收尾判据：20 次后总量与状态 ──
    const parentIds = sessionStore.getRoundIds(parentId);
    const childIds = sessionStore.getRoundIds(childId);
    expect(parentIds.length).toBe(3 + ITERATIONS);
    expect(childIds.length).toBe(3 + ITERATIONS);

    // GC 正例（反证「不误删」不是「GC 没工作」）：人造一个无引用轮，sweep(0) 必须恰好收走它
    const orphanId = 'round-fork-orphan-probe';
    roundStore.save(makeRound(orphanId, '孤儿探针'));
    const swept = roundStore.sweepOrphans(0);
    expect(swept).toEqual([orphanId]);

    // GC 后：父子引用的轮一个都不能少（共享的 3 个 + 各自新增的 20 个）
    for (const id of [...parentIds, ...childIds]) {
      expect(roundStore.getById(id), `GC 误删了被引用轮：${id}`).not.toBeNull();
    }
    // 原 complete 仍是 complete（整轮扫描，覆盖共享轮与各自新增轮）
    for (const id of [...parentIds, ...childIds]) {
      expect(roundStore.getById(id)!.status).toBe('complete');
    }
  }, 120_000);

  /** 构造最小完整 Round（仅 GC 探针需要） */
  function makeRound(id: string, content: string): Round {
    const ts = new Date().toISOString();
    return {
      id,
      userMessage: { id: `${id}-u`, role: 'user', content, timestamp: ts },
      assistantMessage: {
        id: `${id}-a`,
        role: 'assistant',
        content: `回答：${content}`,
        timestamp: ts,
      },
      status: 'complete',
      createdAt: ts,
      completedAt: ts,
      refCount: 1,
    };
  }
});
