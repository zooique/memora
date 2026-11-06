/**
 * 6.0.0 E3 验收：两 Agent 同 projectPath / 同 dataDir 并发实证（B 方案准入门槛）
 *
 * 背景：B 方案 = 「一会话一 Agent 实例」，多实例共享同一项目目录（`.memora/`）。
 * 本文件用**真实文件系统 + 真实 SQLite**（`createHostMemoryStorage` → `node:sqlite` WAL）
 * 起两个 Agent 实例各跑一轮对话，逐条验证落盘与并发安全：
 *
 *   ① 两轮会话文件都在（`sessions/<encodeURIComponent(sessionId)>.json`）
 *   ② 两个轮文件都在（`rounds/<roundId>.json`）
 *   ③ `.memora/memories.db` 可读无损坏
 *   ④ 全程无 `database is locked`（捕获内核 logger 全量消息后正则判否）
 *   ⑤ 两实例同时触发 GC / `sweepOrphans(0)` ⇒ 会不会互删对方轮次？（ROUNDSIDX-SHARED-1）
 *   ⑥ `.memora/.lock` 判据：**锁主人 pid ≠ 本进程 pid 才告警**（同 pid = 同进程多实例，
 *     共享 SQLite/WAL，不是冲突 ⇒ 必须零告警）。E1.5（2026-11-05 从 E6 提前）修正原误报。
 *
 * ## 用例分工
 * - 用例①「装配镜像」：共享 `sessionStore` / `roundStore` 单例（= 现有宿主装配形态，
 *   extension.ts 各建一份后注入），但每个 Agent 持有**独立的 SQLite 连接**（`assemble` 每次
 *   新建 `createHostMemoryStorage`）⇒ 记忆库真并发 + 断言 ①①③④⑥（同 pid 零告警）
 * - 用例①b「外 pid 真冲突」：`.lock` 写成**另一个真实存活进程**的 pid ⇒ 必须告警
 *   （证伪方向：不能把真冲突与同 pid 多开一并关掉）
 * - 用例②「最坏情形探针」：两实例各持**独立** `roundStore`（B 方案若按实例各建 store 就会这样）
 *   ⇒ 回答 ⑤；同时记录 `index.json` 覆盖写现象（供 ROUNDSIDX-SHARED-1，只记录不锁死缺陷）
 *
 * ## 判据口径
 * - 引用真源 = 会话 `roundIds`；`index.json` 是**派生缓存**（可重建），丢条目 ≠ 丢轮文件
 * - 「同时触发」= 同一 tick 内两实例各执行一次清扫（JS 单线程，顺序执行等价于同一时刻）
 * - `node:sqlite` 是同步 API ⇒ 单进程内单次写不重叠，并发压力来自两连接交替写 + WAL
 *
 * ⚠️ E3 只加测试、不改生产代码：本文件是 E4+ 的准入判据，红即停。
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  createNodeSqliteStorage,
  setLogger,
  type AgentChunk,
  type ILogger,
  type IMemoryStorage,
  type LlmChunk,
  type LlmProvider,
  type Memory,
} from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import { createHostMemoryStorage } from '../memoryStorage.js';
import { resolveProjectDataDir } from '../projectDataDir.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

// ─────────────────────────────────────────────────────────────
// 常量与助手
// ─────────────────────────────────────────────────────────────

/** 用例①的两个会话标识（格式约束：YYYY-MM-DD-sessionName） */
const SESSION_A = '2026-11-05-e3a';
/** 用例①的第二个会话标识 */
const SESSION_B = '2026-11-05-e3b';
/** 用例②的两个会话标识（与用例①分开建目录，这里只是语义对仗） */
const SESSION_C = '2026-11-05-e3c';
/** 用例②的第二个会话标识 */
const SESSION_D = '2026-11-05-e3d';

/**
 * 回显 Provider：每轮先吐一段正文、再吐 stop。
 *
 * 内核只把 `LlmProvider` 作 **type** 导出（不能 extends），故用类 + `as unknown as LlmProvider`
 * （与 `crossRestartRecovery.test.ts` 的 StubProvider 同款，仓库既有判据）。
 */
class EchoProvider {
  /** Provider 名（日志/标题生成可见） */
  readonly name: string;

  /**
   * @param name Provider 名（用于区分两个实例的输出）
   */
  constructor(name: string) {
    this.name = name;
  }

  /**
   * 一轮回答：把最后一条 user 内容回显后收尾
   *
   * @param messages 对话消息（只读最后一条 user）
   */
  async *chat(messages: Array<{ role: string; content?: string }>): AsyncIterable<LlmChunk> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    yield { content: `echo(${this.name}):${lastUser?.content ?? ''}` };
    yield { finishReason: 'stop' };
  }
}

/** 捕获到的一条日志（供"无 database is locked"与 `.lock` 误告警判据） */
interface CapturedLog {
  /** 级别（只区分 warn/error 更常用，这里全收） */
  level: 'info' | 'warn' | 'error' | 'debug';
  /** 首参对象（双形态签名的对象形态；字符串形态为 null） */
  fields: Record<string, unknown> | null;
  /** 消息文本 */
  msg: string;
}

/**
 * 构造捕获型 logger（注入内核全局 logger 出口 `setLogger`）
 *
 * @param sink 落盘数组（调用方持有，断言后清零/换新）
 */
function makeCapturingLogger(sink: CapturedLog[]): ILogger {
  const record =
    (level: CapturedLog['level']) =>
    (objOrMsg: Record<string, unknown> | string, msg?: string): void => {
      if (typeof objOrMsg === 'string') {
        sink.push({ level, fields: null, msg: objOrMsg });
      } else {
        sink.push({ level, fields: objOrMsg, msg: msg ?? '' });
      }
    };
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
}

/**
 * 播种角色包目录（与内核 `agent.test.ts` 的 seedProject 同形态）
 *
 * @param configDir 宿主配置目录（Agent 的 `configDir`）
 */
function seedRolePacks(configDir: string): void {
  const defaultDir = join(configDir, 'role-packs', '默认助手');
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(
    join(defaultDir, 'manifest.json'),
    JSON.stringify({ name: '默认助手', displayName: '默认助手', strategy: {} }),
    'utf-8',
  );
  writeFileSync(join(defaultDir, 'persona.md'), '你是一个通用助手。', 'utf-8');
  // 兜底契约包（§4.1 单链：无 activePack 注入时落兜底包，非 items[0]）
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
 * 会话文件绝对路径（与 `WorkspaceSessionStore` 同口径：encodeURIComponent）
 *
 * @param projectPath 工作区根
 * @param sessionId 会话标识
 */
function sessionFilePath(projectPath: string, sessionId: string): string {
  return join(
    resolveProjectDataDir(projectPath),
    'sessions',
    `${encodeURIComponent(sessionId)}.json`,
  );
}

/**
 * 读会话文件里的 roundIds（数据完好性判据）
 *
 * @param projectPath 工作区根
 * @param sessionId 会话标识
 */
function readRoundIds(projectPath: string, sessionId: string): string[] {
  const data = JSON.parse(readFileSync(sessionFilePath(projectPath, sessionId), 'utf8')) as {
    roundIds?: string[];
  };
  return Array.isArray(data.roundIds) ? data.roundIds : [];
}

/**
 * 轮文件绝对路径（`WorkspaceRoundStore` 口径：`rounds/<roundId>.json`）
 *
 * @param projectPath 工作区根
 * @param roundId 轮标识
 */
function roundFilePath(projectPath: string, roundId: string): string {
  return join(resolveProjectDataDir(projectPath), 'rounds', `${roundId}.json`);
}

/**
 * 构造一条**合法**的记忆（用于跨连接并发写库 - 断言 ③ 的非空读回）
 *
 * @param id 记忆 ID（`source:name` 形态）
 * @param content 内容
 */
function makeMemory(id: string, content: string): Memory {
  const now = new Date().toISOString();
  return {
    id,
    content,
    source: 'round-summary',
    name: `E3-${id}`,
    createdAt: now,
    accessedAt: now,
  };
}

/**
 * 消费一个 Agent 的对话流，收集正文分片
 *
 * @param stream `agent.chat()` 返回的异步流
 */
async function drainChat(stream: AsyncIterable<AgentChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    // AgentChunk 是判别联合：只累加正文分片，thinking / tool 事件一律跳过
    if (chunk.type === 'text') text += chunk.content;
  }
  return text;
}

/**
 * 构造一个 Agent（宿主装配镜像：外部注入 storage / sessionStore / roundStore）
 *
 * @param projectPath 工作区根
 * @param configDir 配置目录
 * @param provider 该实例的 LLM provider
 * @param storage 该实例独有的记忆存储连接
 * @param sessionStore 注入的会话存储（用例①共享单例）
 * @param roundStore 注入的轮次存储（用例①共享单例）
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
    // archiveMode='manual'：本轮只看落盘与并发写，不引入后台摘要 LLM 调用的时序噪声
    archiveMode: 'manual',
    permission: 'owner',
    allowedPaths: [projectPath],
    storage,
    sessionStore,
    roundStore,
  });
}

// ─────────────────────────────────────────────────────────────
// 用例①：装配镜像（共享 store 单例 + 独立 SQLite 连接）
// ─────────────────────────────────────────────────────────────

describe('E3 · 两 Agent 同 dataDir（共享 store 单例）', () => {
  /** 本用例捕获的内核日志 */
  let captured: CapturedLog[] = [];
  /** 待清理的 Agent（afterEach 逆序 close，防用例失败漏关） */
  let agents: Agent[] = [];

  beforeEach(() => {
    captured = [];
    agents = [];
    setLogger(makeCapturingLogger(captured));
  });

  afterEach(async () => {
    for (const agent of agents.reverse()) {
      await agent.close().catch(() => {
        // 关闭失败不影响判据结论（资源在临时目录，随目录删除回收）
      });
    }
    setLogger(undefined);
  });

  it('两轮并发落盘：会话 / 轮文件 / memories.db 均正常，且无 database is locked', async () => {
    const projectPath = makeTempDir('memora-e3-shared-');
    const configDir = join(projectPath, 'config');
    seedRolePacks(configDir);

    // 共享单例：先建 roundStore 并 load，再建 sessionStore（构造时注入 referencedIds 真源）
    const roundStore = new WorkspaceRoundStore(projectPath);
    roundStore.load();
    const sessionStore = new WorkspaceSessionStore(projectPath, roundStore);
    sessionStore.load();
    // 每个 Agent 独立记忆连接（生产 assemble 每次新建 createHostMemoryStorage）
    const storageA = createHostMemoryStorage(projectPath);
    const storageB = createHostMemoryStorage(projectPath);

    const agentA = makeAgent(
      projectPath,
      configDir,
      new EchoProvider('A') as unknown as LlmProvider,
      storageA,
      sessionStore,
      roundStore,
    );
    const agentB = makeAgent(
      projectPath,
      configDir,
      new EchoProvider('B') as unknown as LlmProvider,
      storageB,
      sessionStore,
      roundStore,
    );
    agents.push(agentA, agentB);

    await agentA.init();
    await agentB.init();

    // ── 断言⑥：`.lock` 同 pid **零告警**（同进程多实例共享 SQLite/WAL，不是冲突） ──
    const lockFile = JSON.parse(
      readFileSync(join(resolveProjectDataDir(projectPath), '.lock'), 'utf8'),
    ) as { pid?: number };
    expect(lockFile.pid).toBe(process.pid);
    const lockWarns = captured.filter((l) => l.msg.includes('项目已被其他进程打开'));
    expect(lockWarns).toHaveLength(0);
    console.log('[E3] .lock 同 pid 告警数 =', lockWarns.length);

    // 两个 Agent 切到不同会话后**同时**跑一轮
    await agentA.sessionManager!.switchToSession(SESSION_A);
    await agentB.sessionManager!.switchToSession(SESSION_B);
    const [textA, textB] = await Promise.all([
      drainChat(agentA.chat('会话 A 的消息')),
      drainChat(agentB.chat('会话 B 的消息')),
    ]);
    expect(textA).toContain('echo(A)');
    expect(textB).toContain('echo(B)');

    // ── 断言①：两轮会话文件都在 ──
    expect(existsSync(sessionFilePath(projectPath, SESSION_A))).toBe(true);
    expect(existsSync(sessionFilePath(projectPath, SESSION_B))).toBe(true);
    const idsA = readRoundIds(projectPath, SESSION_A);
    const idsB = readRoundIds(projectPath, SESSION_B);
    expect(idsA.length).toBeGreaterThanOrEqual(1);
    expect(idsB.length).toBeGreaterThanOrEqual(1);

    // ── 断言②：rounds/ 两个轮文件都在，且内容可被共享 store 读回 ──
    for (const id of [...idsA, ...idsB]) {
      expect(existsSync(roundFilePath(projectPath, id))).toBe(true);
    }
    for (const id of [...idsA, ...idsB]) {
      expect(roundStore.getById(id)).not.toBeNull();
    }

    // ── 断言③：memories.db 可读无损坏（两连接已写过：显式并发写验证 + 读回） ──
    const dbPath = join(resolveProjectDataDir(projectPath), 'memories.db');
    expect(existsSync(dbPath)).toBe(true);
    storageA.upsert(makeMemory('round-summary:e3:a', '连接 A 写入'));
    storageB.upsert(makeMemory('round-summary:e3:b', '连接 B 写入'));
    const reader = createNodeSqliteStorage(dbPath);
    expect(reader.count()).toBeGreaterThanOrEqual(2);
    expect(reader.getById('round-summary:e3:a')).not.toBeNull();
    expect(reader.getById('round-summary:e3:b')).not.toBeNull();
    reader.close?.();

    // ── 断言④：无 SQLite `database is locked`（含 chat 全程 + 显式并发写） ──
    const lockedLogs = captured.filter(
      (l) =>
        /database is locked/i.test(l.msg) ||
        /database is locked/i.test(JSON.stringify(l.fields ?? {})),
    );
    expect(lockedLogs).toHaveLength(0);

    // ── 断言⑤（共享单例口径）：两实例同时触发 GC，不删对方轮次 ──
    const gcA = agentA.gcNow();
    const gcB = agentB.gcNow();
    expect(gcA.deleted).toBe(0);
    expect(gcB.deleted).toBe(0);
    // 最严口径（关存活保护）：共享索引 + 会话引用集合同时覆盖两轮 ⇒ 仍应为空
    expect(roundStore.sweepOrphans(0)).toEqual([]);
    expect(roundStore.sweepOrphans(0)).toEqual([]);
    for (const id of [...idsA, ...idsB]) {
      expect(existsSync(roundFilePath(projectPath, id))).toBe(true);
    }
  }, 120_000);

  it('.lock 锁主人 pid ≠ 本进程 ⇒ 仍告警（同 pid 免告警不得把真冲突一并关掉）', async () => {
    const projectPath = makeTempDir('memora-e1-5-foreign-');
    const configDir = join(projectPath, 'config');
    seedRolePacks(configDir);
    const dataDir = resolveProjectDataDir(projectPath);
    mkdirSync(dataDir, { recursive: true });

    // 起一个**真实存活**的外部进程作"锁主人"（60s 后自然退出；finally 强制清理）
    // 用它而不是伪造一个随机 pid：`isProcessAlive` 若判 false 会走"清理残留"分支，
    // 用例就会因判据走错分支而失去意义。
    const foreign = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      stdio: 'ignore',
    });
    const foreignPid = foreign.pid;
    expect(typeof foreignPid).toBe('number');
    writeFileSync(
      join(dataDir, '.lock'),
      JSON.stringify({
        pid: foreignPid,
        acquiredAt: new Date().toISOString(),
        hostname: hostname(),
      }),
      'utf-8',
    );

    try {
      const roundStore = new WorkspaceRoundStore(projectPath);
      roundStore.load();
      const sessionStore = new WorkspaceSessionStore(projectPath, roundStore);
      sessionStore.load();
      const agent = makeAgent(
        projectPath,
        configDir,
        new EchoProvider('foreign') as unknown as LlmProvider,
        createHostMemoryStorage(projectPath),
        sessionStore,
        roundStore,
      );
      agents.push(agent);
      await agent.init();

      // ── 判据：外 pid 存活 ⇒ 必须告警，且告警字段里的 pid 就是外进程 pid ──
      const foreignWarns = captured.filter((l) => l.msg.includes('项目已被其他进程打开'));
      expect(foreignWarns.length).toBeGreaterThanOrEqual(1);
      expect(foreignWarns[0]!.fields?.['pid']).toBe(foreignPid);
      console.log('[E1.5] .lock 外 pid 告警数 =', foreignWarns.length, '（pid =', foreignPid, '）');
    } finally {
      // Windows 用 taskkill 强杀；其他平台走 SIGKILL（避免残留 60s 挂起进程）
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/PID', String(foreignPid)], { stdio: 'ignore' });
      } else {
        foreign.kill('SIGKILL');
      }
    }
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────
// 用例②：最坏情形探针（两实例各持独立 roundStore）
// ─────────────────────────────────────────────────────────────

describe('E3 · 最坏情形探针（两实例各持独立 roundStore）', () => {
  /** 本用例捕获的内核日志 */
  let captured: CapturedLog[] = [];
  /** 待清理的 Agent */
  let agents: Agent[] = [];

  beforeEach(() => {
    captured = [];
    agents = [];
    setLogger(makeCapturingLogger(captured));
  });

  afterEach(async () => {
    for (const agent of agents.reverse()) {
      await agent.close().catch(() => {
        // 同用例①：关闭失败不影响判据
      });
    }
    setLogger(undefined);
  });

  it('两实例同时 sweepOrphans(0)/GC 不互删轮次；记录 index.json 覆盖写现象', async () => {
    const projectPath = makeTempDir('memora-e3-independent-');
    const configDir = join(projectPath, 'config');
    seedRolePacks(configDir);

    // 最坏情形：两套独立 store（都先 load 空索引，再分别写轮）
    const roundStoreA = new WorkspaceRoundStore(projectPath);
    roundStoreA.load();
    const sessionStoreA = new WorkspaceSessionStore(projectPath, roundStoreA);
    sessionStoreA.load();
    const roundStoreB = new WorkspaceRoundStore(projectPath);
    roundStoreB.load();
    const sessionStoreB = new WorkspaceSessionStore(projectPath, roundStoreB);
    sessionStoreB.load();

    const agentA = makeAgent(
      projectPath,
      configDir,
      new EchoProvider('A') as unknown as LlmProvider,
      createHostMemoryStorage(projectPath),
      sessionStoreA,
      roundStoreA,
    );
    const agentB = makeAgent(
      projectPath,
      configDir,
      new EchoProvider('B') as unknown as LlmProvider,
      createHostMemoryStorage(projectPath),
      sessionStoreB,
      roundStoreB,
    );
    agents.push(agentA, agentB);
    await agentA.init();
    await agentB.init();

    await agentA.sessionManager!.switchToSession(SESSION_C);
    await agentB.sessionManager!.switchToSession(SESSION_D);
    await Promise.all([
      drainChat(agentA.chat('独立 store A 的消息')),
      drainChat(agentB.chat('独立 store B 的消息')),
    ]);

    const idsA = readRoundIds(projectPath, SESSION_C);
    const idsB = readRoundIds(projectPath, SESSION_D);
    expect(idsA.length).toBeGreaterThanOrEqual(1);
    expect(idsB.length).toBeGreaterThanOrEqual(1);
    for (const id of [...idsA, ...idsB]) {
      expect(existsSync(roundFilePath(projectPath, id))).toBe(true);
    }

    // ── 断言⑤：同一 tick 内两实例各清扫一次（关存活保护，最严口径） ──
    const sweptA = roundStoreA.sweepOrphans(0);
    const sweptB = roundStoreB.sweepOrphans(0);
    expect(sweptA).toEqual([]);
    expect(sweptB).toEqual([]);
    // 两实例各自触发 GC（内核 5min 存活保护，已写入的轮不应被删）
    expect(agentA.gcNow().deleted).toBe(0);
    expect(agentB.gcNow().deleted).toBe(0);

    // 轮文件与会话引用一字不少
    for (const id of [...idsA, ...idsB]) {
      expect(existsSync(roundFilePath(projectPath, id))).toBe(true);
    }
    expect(readRoundIds(projectPath, SESSION_C)).toEqual(idsA);
    expect(readRoundIds(projectPath, SESSION_D)).toEqual(idsB);
    const trashDir = join(resolveProjectDataDir(projectPath), 'rounds', '.trash');
    expect(existsSync(trashDir) ? readdirSync(trashDir) : []).toEqual([]);

    // ── 记录（非断言）：index.json 覆盖写 → 后写者条目留存情况（供 ROUNDSIDX-SHARED-1） ──
    const indexPath = join(resolveProjectDataDir(projectPath), 'rounds', 'index.json');
    const indexEntries = JSON.parse(readFileSync(indexPath, 'utf8')) as Array<{ id: string }>;
    const freshStore = new WorkspaceRoundStore(projectPath);
    freshStore.load();
    const visibility = [...idsA, ...idsB].map((id) => ({
      id,
      fileExists: existsSync(roundFilePath(projectPath, id)),
      visibleViaFreshIndex: freshStore.getById(id) !== null,
    }));
    console.log('[E3] index.json 条目 =', JSON.stringify(indexEntries.map((e) => e.id)));
    console.log('[E3] 新实例可见性 =', JSON.stringify(visibility));
  }, 120_000);
});
