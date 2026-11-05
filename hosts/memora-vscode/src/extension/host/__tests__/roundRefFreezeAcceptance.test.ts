/**
 * 6.0.0 批 1 验收：引用真相移出轮次文件（宿主真实文件系统）
 *
 * 严格对应派发单的三条验收（不扩范围）：
 *   1. 分叉前后 `rounds/*.json` 全量 sha256 逐一比对：**字节与文件集合均不变**
 *   2. GC：10 轮（5 引用 / 5 孤儿）sweep 后引用 5/5 仍在、孤儿全收；**父会话删除后子会话共享轮仍在**
 *   3. 同进程 20 次「分叉 / 删会话 / 截断」零丢失
 *
 * 明确**不在本步范围**：跨进程并发零丢失（属加锁子步）。
 *
 * 铁律（memora-host-e2e-persistence）：宿主测试跑构建后的内核（dist），
 * 改过内核 src 须先 `npm run build`；store 必须先 load()；免 API Key 用桩 provider。
 */
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type LlmChunk, type LlmProvider, type Round } from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';

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

/** 桩 provider：init 不调 chat，安全 */
class StubProvider {
  readonly name = 'stub';
  readonly supportsStructuredOutput = false;
  // eslint-disable-next-line require-yield
  async *chat(): AsyncIterable<LlmChunk> {}
}

describe('6.0.0 批 1 验收：refCount 冻结 / 引用真源 = 会话 roundIds', () => {
  /** 临时工作区 */
  let ws: string;
  /** 数据目录（Agent dataDir） */
  let dataDir: string;
  /** 配置目录（Agent configDir） */
  let configDir: string;
  /** 真实宿主轮存储 */
  let roundStore: WorkspaceRoundStore;
  /** 真实宿主会话存储 */
  let sessionStore: WorkspaceSessionStore;
  /** 内核 Agent（只用于取 agentHistory 做真实分叉/落盘） */
  let agent: Agent;
  /** 轮次自增序号（测试内唯一 ID） */
  let seq = 0;

  beforeAll(async () => {
    ws = mkdtempSync(join(tmpdir(), 'memora-ref-freeze-'));
    dataDir = join(ws, 'data');
    configDir = join(ws, 'config');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();
    sessionStore = new WorkspaceSessionStore(ws, roundStore);
    sessionStore.load();
    agent = new Agent({
      projectPath: ws,
      dataDir,
      configDir,
      provider: new StubProvider() as unknown as LlmProvider,
      sessionStore,
      roundStore,
      permission: 'owner',
      allowedPaths: [dataDir],
      archiveMode: 'manual',
    });
    await agent.init();
  }, 120_000);

  afterAll(async () => {
    await agent?.close();
    rmSync(ws, { recursive: true, force: true });
  });

  /** 造一轮问答（真实 appendUser + appendAssistant 落盘） */
  async function appendRound(content: string): Promise<string> {
    const history = agent.agentHistory!;
    const roundId = `round-accept-${++seq}`;
    await history.appendUser(content, roundId);
    await history.appendAssistant(`回答：${content}`, roundId);
    return roundId;
  }

  /** rounds 目录快照：文件名 → sha256（含 index.json；`.trash/` 是目录，不在 *.json 文件清单内） */
  function snapshotRounds(): Map<string, string> {
    const roundsDir = join(ws, '.memora', 'rounds');
    const names = readdirSync(roundsDir)
      .filter((n) => n.endsWith('.json') && statSync(join(roundsDir, n)).isFile())
      .sort();
    const map = new Map<string, string>();
    for (const name of names) {
      const hash = createHash('sha256')
        .update(readFileSync(join(roundsDir, name)))
        .digest('hex');
      map.set(name, hash);
    }
    return map;
  }

  it('验收 1：分叉前后 rounds/*.json 字节与文件集合均不变', async () => {
    const history = agent.agentHistory!;
    // 3 轮（写在当前 main 会话）
    await appendRound('第一问');
    await appendRound('第二问');
    const forkPoint = await appendRound('第三问');

    const before = snapshotRounds();

    // 分叉（真实生产路径：只复制会话 roundIds 指针）
    const fork = history.forkSession(forkPoint);
    expect(fork.roundIds.length).toBe(3);

    const after = snapshotRounds();

    // 文件集合不变
    expect([...after.keys()]).toEqual([...before.keys()]);
    // 逐文件字节（sha256）不变
    for (const [name, hash] of before) {
      expect(after.get(name)).toBe(hash);
    }

    // 清理视角：分叉后新会话确实拿到了共享指针
    const forkSessionId = `${fork.date}-${fork.newSession}`;
    expect(sessionStore.getRoundIds(forkSessionId)).toEqual(fork.roundIds);
  });

  it('验收 3：同进程 20 次「分叉 / 删会话 / 截断」零丢失', async () => {
    const history = agent.agentHistory!;
    // 回到 main（验收 1 的分叉已把 currentSession 切到子会话）
    history.switchSession('main');
    const mainId = history.currentSessionName;
    const date = history.currentDateValue;

    for (let i = 0; i < 20; i++) {
      // 每轮追加 2 个新轮
      const r1 = await appendRound(`迭代${i}-问1`);
      const r2 = await appendRound(`迭代${i}-问2`);
      // 分叉（新会话共享当前全部指针）
      const fork = history.forkSession(r2);
      const forkSessionId = `${fork.date}-${fork.newSession}`;
      // 切回 main，删除分叉会话（共享轮必须因 main 仍引用而存活）
      history.switchSession('main');
      sessionStore.deleteSession(forkSessionId);
      // 截断 main 到 r2（删 r2 及之后；r1 是被保留的锚点，必须仍在）
      const trunc = sessionStore.truncateFrom(date, 'main', r2);
      expect(trunc.ok).toBe(true);

      // 零丢失判据：main 当前 roundIds 全部可解析；r1 必在
      const kept = sessionStore.getRoundIds(mainId);
      expect(kept).toContain(r1);
      for (const id of kept) {
        expect(roundStore.getById(id)).not.toBeNull();
      }
      // 引用集合中的每个 ID 都能读到物理轮（不存在「引用指向已删文件」）
      for (const id of sessionStore.referencedIds()) {
        expect(roundStore.getById(id)).not.toBeNull();
      }
    }
  }, 120_000);

  it('验收 2：GC 10 轮（5 引用 / 5 孤儿）后引用 5/5 在、孤儿全收；父删后子共享轮仍在', async () => {
    const history = agent.agentHistory!;
    history.switchSession('main');
    const mainId = history.currentSessionName;

    // 5 个被 main 引用的轮（直接落盘 + 登记会话 roundIds）
    const referenced: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `round-accept-ref-${i}`;
      roundStore.save(makeRound(id, `引用轮 ${i}`));
      sessionStore.appendRoundId(mainId, id);
      referenced.push(id);
    }
    // 5 个孤儿轮（不在任何会话 roundIds 中）
    const orphaned: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `round-accept-orphan-${i}`;
      roundStore.save(makeRound(id, `孤儿轮 ${i}`));
      orphaned.push(id);
    }

    // sweep（minAgeMs=0，聚焦引用集合判据）：引用 5/5 仍在、孤儿全收（移入 .trash）
    const swept = roundStore.sweepOrphans(0);
    expect(swept.sort()).toEqual(orphaned.sort());
    for (const id of referenced) expect(roundStore.getById(id)).not.toBeNull();
    for (const id of orphaned) expect(roundStore.getById(id)).toBeNull();

    // 父会话删除后子会话共享轮仍在：以 main 最后一条轮为分叉点
    const last = sessionStore.getRoundIds(mainId).at(-1)!;
    const fork = history.forkSession(last);
    const forkSessionId = `${fork.date}-${fork.newSession}`;
    const shared = [...fork.roundIds];
    const removed = sessionStore.deleteSession(mainId);
    // 共享轮全部被分叉会话引用 ⇒ 一条都不回收
    expect(removed).toEqual([]);
    for (const id of shared) expect(roundStore.getById(id)).not.toBeNull();
    expect(sessionStore.getRoundIds(forkSessionId)).toEqual(shared);
  }, 120_000);

  /** 构造最小完整 Round（仅 GC 判据需要的字段） */
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
