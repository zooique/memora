/**
 * 跨重启恢复 e2e（真杀进程，非优雅退出）
 *
 * 为什么必须单独存在：既有用例（`chatPanelHistory.test`）用 mock store 验了「打捞→升级」
 * 的业务逻辑，但**从未验过「进程被硬杀之后磁盘上到底是什么」**。“打捞逻辑对” 与
 * “崩溃真的会留下可打捞的轮” 是两个命题，前者绿不能推后者。
 *
 * 实测结论（本文件锁定的形态，2026-10-30）：
 *   进程被 SIGKILL 的瞬间，磁盘上是 —— `rounds/{id}.json` 存在、`index.json` 记为
 *   `status: 'pending', refCount: 0`，而 **`sessions.json` 根本还没写**（会话不认这一轮）。
 *   即：崩溃残留轮对「按会话列历史」的路径是**不可见**的，只能靠 `listInterruptedRecent`
 *   按 refCount=0 + pending 打捞。这正是打捞口存在的唯一理由。
 *
 * 铁律（来自 memora-host-e2e-persistence）：宿主测试跑的是**构建后的内核**（dist），
 * 改过内核 src 须先 `npm run build`；免 API Key 用桩 provider；store 必须先 load()。
 */
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 宿主持久层间接依赖 vscode；本用例只要文件落盘链路，不需要真实 VS Code 运行时
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
  },
  EventEmitter: vi.fn(),
}));

import {
  Agent,
  splitSessionId,
  formatDateKey,
  type LlmChunk,
  type LlmProvider,
} from '@zooique/memora';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
import { WorkspaceStorage } from '../workspaceStorage.js';
import { salvageInterruptedRounds } from '../interruptedSalvage.js';
import { deriveNarrateText } from '../../../shared/narrateText.js';

/** 宿主根（本文件在 src/extension/host/__tests__ 下） */
const HOST_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const REPO_ROOT = join(HOST_ROOT, '..', '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'crashChild.ts');

/** 重启用桩：init 不调 provider.chat，安全 */
class StubProvider {
  readonly name = 'stub';
  readonly supportsStructuredOutput = false;
  // eslint-disable-next-line require-yield
  async *chat(): AsyncIterable<LlmChunk> {}
}

interface CrashOutcome {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function seedConfig(configDir: string): void {
  mkdirSync(join(configDir, 'personas'), { recursive: true });
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(
    join(configDir, 'personas', 'default.md'),
    '---\nid: persona:default\nsource: persona\nname: 默认人格\nscore: 1\n---\n\n你是一个测试助手。',
    'utf-8',
  );
}

/** 起子进程跑真 Agent，在崩溃窗口自杀（tsx 直跑 TS 源，免预编译） */
function runCrashingChild(
  ws: string,
  configDir: string,
  dataDir: string,
  mode: 'text' | 'ask' = 'text',
): CrashOutcome {
  const res = spawnSync(
    process.execPath,
    [TSX_CLI, FIXTURE, ws, configDir, dataDir, '崩溃窗口测试提问', mode],
    {
      cwd: HOST_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    },
  );
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('跨重启恢复：真杀进程 → 重启打捞 → 升级为正常 stop turn', () => {
  let ws: string;
  let configDir: string;
  let dataDir: string;
  let crash: CrashOutcome;
  let crashedRoundId: string;

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), 'memora-cross-restart-'));
    configDir = join(ws, 'config');
    dataDir = join(ws, '.memora');
    seedConfig(configDir);
    crash = runCrashingChild(ws, configDir, dataDir);
  });

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('子进程真的跑到了崩溃窗口才死（前置事实，防环境问题被误读成行为缺陷）', () => {
    // 子进程打印 TEXT_CHUNK 才自杀；没这行说明它压根没进 LLM 阶段，后续断言全部无意义
    expect(crash.stdout).toContain('TEXT_CHUNK');
    // 非优雅退出：不能是 0（正常退出），且不能是 3（fixture 自报错误）或 4（没拿到正文）
    expect(crash.status).not.toBe(0);
    expect(crash.status).not.toBe(3);
    expect(crash.status).not.toBe(4);
  });

  it('崩溃瞬间的磁盘形态：轮文件在（pending/refCount 0），会话不认它', () => {
    const indexPath = join(dataDir, 'rounds', 'index.json');
    expect(existsSync(indexPath)).toBe(true);
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      id: string;
      status: string;
      refCount: number;
    }[];
    expect(index).toHaveLength(1);
    expect(index[0]!.status).toBe('pending');
    expect(index[0]!.refCount).toBe(0);
    crashedRoundId = index[0]!.id;
    // 轮文件本体必须在（只有索引没有文件 = 打捞时会拿到 null，属另一种坏）
    expect(existsSync(join(dataDir, 'rounds', `${crashedRoundId}.json`))).toBe(true);

    // 核心事实：崩溃时会话侧还没有这一轮的登记 ⇒「按会话列历史」完全看不见它，
    // 这正是 listInterruptedRecent 存在的唯一理由（也解释了为什么用户重启后
    // 会发现「那一轮没了」）
    const sessionsPath = join(dataDir, 'sessions.json');
    if (existsSync(sessionsPath)) {
      const raw = readFileSync(sessionsPath, 'utf8');
      expect(raw).not.toContain(crashedRoundId);
    }
  });

  it('重启后按会话日期打捞到该轮，且叙述派生走 shared 单点', () => {
    const roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();
    // 喂轮自己 createdAt 的**本地日期**（formatDateKey）——与生产宿主传的 sessionDate
    //（会话 ID 本地日期前缀）同口径（E2E-TZ-SALVAGE-1 修复后两侧同判据，不再绕缺口）。
    const date = formatDateKey(new Date(roundStore.getById(crashedRoundId)!.createdAt));
    const interrupted = roundStore.listInterruptedRecent?.(date) ?? [];
    expect(interrupted.map((r) => r.id)).toContain(crashedRoundId);

    // 本崩溃形态 = 首个**正文**分片即被杀，尚无工具迭代 ⇒ 没有 narrate 段 ⇒ 派生为空串
    //（非空派生 + 换行口径由 `shared/__tests__/narrateText.test.ts` 用真实形态覆盖）
    const round = interrupted.find((r) => r.id === crashedRoundId)!;
    expect(deriveNarrateText(round.processEvents)).toBe('');
  });

  it('升级后成为正常 stop turn：interrupted + refCount 1 + 可被会话加载 + 退出打捞队列', async () => {
    const roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();
    const sessionStore = new WorkspaceSessionStore(ws, roundStore);
    sessionStore.load();
    const storage = new WorkspaceStorage(ws);
    storage.load();

    const agent = new Agent({
      projectPath: ws,
      dataDir,
      configDir,
      provider: new StubProvider() as unknown as LlmProvider,
      storage,
      sessionStore,
      roundStore,
      permission: 'owner',
      allowedPaths: [dataDir],
      archiveMode: 'manual',
    });
    await agent.init();

    const date = formatDateKey(new Date(roundStore.getById(crashedRoundId)!.createdAt));
    // 走**生产同一份实现**（chatPanel 也调它），不是测试里另写一遍
    const history = agent.agentHistory;
    expect(history).not.toBeNull();
    const upgraded = await salvageInterruptedRounds({
      store: roundStore,
      history: history!,
      sessionDate: date,
    });
    expect(upgraded).toBeGreaterThanOrEqual(1);

    // 终态：interrupted（不是 complete——崩溃轮不能伪装成正常完成）
    const after = roundStore.getById(crashedRoundId)!;
    expect(after.status).toBe('interrupted');
    expect(after.refCount).toBeGreaterThan(0);
    expect(after.completedAt).toBeTruthy();

    // 端到端「重启后能看见」：宿主加载链正是 loadMessages → roundIds → RoundStore。
    // 注意 loadMessages 收的是 (date, session) 两段，内部再拼回 `date-session`（buildSessionId
    // 双向一致契约）——直接喂完整 sessionId 会拼成 `2026-10-30-2026-10-30-main`，恒空。
    const { date: localDate, session } = splitSessionId(history!.currentSessionName);
    const messages = sessionStore.loadMessages(localDate, session);
    expect(messages.some((m) => m.roundId === crashedRoundId)).toBe(true);

    // 打捞队列不再含它（已收场 ⇒ refCount>0，不再符合崩溃孤儿条件，重复打捞无意义）
    expect((roundStore.listInterruptedRecent?.(date) ?? []).map((r) => r.id)).not.toContain(
      crashedRoundId,
    );

    await agent.close();
  }, 120_000);
});

/**
 * 「AI 已提问、用户未答」窗口崩溃 ⇒ 问题文本可恢复（E2E-ASK-LOSS-1 修复后的行为锁定）
 *
 * 修复前实测定论（2026-10-30，缺口已修，留此作对照）：问题文本只活在内存 `pendingAsk`，
 * 崩溃后盘面搜不到提问内容，用户重启只能看到「没有问题的中断」。
 *
 * 修复后事实链（本 describe 锁定）：
 *   `handleAskUser` 在 yield paused 之前经装配层 `markPendingAsk` 把提问快照写进当前轮
 *   （`Round.pendingAsk`，随轮落盘）⇒ SIGKILL 后盘面就有 question/options；
 *   重启打捞 `appendInterrupted` 收场时把残留 pendingAsk 转化成 `kind:'unanswered'`
 *   交互输入并清字段 ⇒ 恢复后的历史轮带「问 + 未回答」行（渲染复用 timeout 同型形态）。
 *
 * 作答语义定案（E2E-ASK-LOSS-1 判据③）：**重启后不可再作答**——内核续跑链依赖进程内
 * 现场（pendingAsk + toolCallIds + 生成器现场），重启后 `agent.answerQuestion` 无在途内存
 * 提问恒 false；恢复面只做诚实记录（unanswered 行），不伪造「可作答提问卡」。
 * 「不答 = 收场为 interrupted」由本组 + 主链组覆盖；「答 = 续跑」不提供（见上）。
 */
describe('提问窗口崩溃 ⇒ 问题文本可恢复（E2E-ASK-LOSS-1）', () => {
  let ws: string;
  let configDir: string;
  let dataDir: string;
  let crash: CrashOutcome;
  let roundId: string;

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), 'memora-ask-gap-'));
    configDir = join(ws, 'config');
    dataDir = join(ws, '.memora');
    seedConfig(configDir);
    crash = runCrashingChild(ws, configDir, dataDir, 'ask');
  });

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('子进程确实在 paused（AI 已提问、等回答）之后才被杀', () => {
    expect(crash.stdout).toContain('ASK_PENDING');
    expect(crash.status).not.toBe(0);
    expect(crash.status).not.toBe(4);
  });

  it('挂起前提问已落盘：盘面 pendingAsk 含 question 与 options（修复前这里搜不到任何提问内容）', () => {
    const index = JSON.parse(readFileSync(join(dataDir, 'rounds', 'index.json'), 'utf8')) as {
      id: string;
      status: string;
    }[];
    expect(index).toHaveLength(1);
    roundId = index[0]!.id;

    const round = JSON.parse(readFileSync(join(dataDir, 'rounds', `${roundId}.json`), 'utf8')) as {
      userMessage?: { content?: string };
      pendingAsk?: { question?: string; options?: string[] }[];
      assistantMessage?: { content?: string };
      processEvents?: unknown[];
    };
    // 用户那一句在（appendUser 即时落盘）
    expect(round.userMessage?.content).toBe('崩溃窗口测试提问');
    // 修复点本体：挂起（yield paused）之前提问快照已随轮落盘
    expect(round.pendingAsk).toEqual([{ question: '选哪个方案？', options: ['A', 'B'] }]);
    // assistantMessage / processEvents 仍缺（提问轮无产出叙述——这是诚实形态，非缺陷）
    expect(round.assistantMessage).toBeUndefined();
    expect(round.processEvents ?? []).toHaveLength(0);
  });

  it('重启后不可再作答（语义定案）：answerQuestion 无在途内存提问恒 false', async () => {
    const roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();
    const sessionStore = new WorkspaceSessionStore(ws, roundStore);
    sessionStore.load();
    const agent = new Agent({
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

    // 进程死亡后 pendingAsk 内存现场不可重建 ⇒ 不提供「答 = 续跑」；答案无处回填
    expect(agent.answerQuestion(['A'])).toBe(false);

    await agent.close();
  }, 120_000);

  it('打捞收场把提问转化成 unanswered 交互输入并清字段（恢复面 = 诚实记录，非活提问卡）', async () => {
    const roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();
    const sessionStore = new WorkspaceSessionStore(ws, roundStore);
    sessionStore.load();
    const agent = new Agent({
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

    const date = formatDateKey(new Date(roundStore.getById(roundId)!.createdAt));
    const upgraded = await salvageInterruptedRounds({
      store: roundStore,
      history: agent.agentHistory!,
      sessionDate: date,
    });
    expect(upgraded).toBeGreaterThanOrEqual(1);
    const round = roundStore.getById(roundId)!;
    expect(round.status).toBe('interrupted');
    // 无产出也按 stop 收场（内核既有语义不变）
    expect(round.assistantMessage).toBeUndefined();
    // 转化产物：「问 + 未回答」行数据齐备，渲染复用 timeout 同型形态
    const input = round.interactiveInputs?.[0];
    expect(input?.kind).toBe('unanswered');
    expect(input?.question).toBe('选哪个方案？');
    expect(input?.options).toEqual(['A', 'B']);
    // 生命周期不变量收口：终态轮不残留 pendingAsk
    expect(round.pendingAsk).toBeUndefined();

    await agent.close();
  }, 120_000);
});

/**
 * 本地日期口径锁定（E2E-TZ-SALVAGE-1 · 2026-10-30 修复后断言——修复前本 describe 锁的是缺口：
 * 「按本地日期漏捞 / 按 UTC 日期命中」，修好后按台账判据②翻转）。
 *
 * 同一条链上的两个日期口径：
 *   - 会话 ID 的日期 = **本地日期**（`_currentSessionId.slice(0, 10)`，用户看到的「今天」）；
 *   - 轮的 `createdAt` = **UTC ISO**（`toISOString()`）。
 *
 * 修复前打捞用 `createdAt.startsWith(date)` 前缀匹配 ⇒ UTC+8 本地 00:00–08:00 创建的中断轮
 * 其 UTC 日期头是前一天，按本地日期永远捞不到，24h 后被 GC 当孤儿回收 = **静默丢失**。
 * 修复后按本地日区间 `[D 00:00, D+1 00:00)` 换算 UTC 比较——判据单点 = 内核
 * `isWithinLocalDay`，宿主 `WorkspaceRoundStore` 与内核 `InMemoryRoundStore` 同源消费。
 *
 * 为什么用构造盘测：真杀进程造不出「凌晨」这个时间条件（除非改系统时钟，那会污染其它用例）。
 * 构造按**本地墙上时钟**（`new Date('2026-10-30T01:30:00')`）：在 UTC+8 下其 UTC 时间戳的
 * 日期头正是 2026-10-29（修复前漏捞的形态）；在 UTC 环境下断言仍同契约成立（时区无关）。
 */
describe('本地日期口径：凌晨窗口的中断轮按本地日期也能捞到（E2E-TZ-SALVAGE-1 修复锁定）', () => {
  let ws: string;
  const roundId = 'round-tz-gap';

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), 'memora-tz-gap-'));
    const roundsDir = join(ws, '.memora', 'rounds');
    mkdirSync(roundsDir, { recursive: true });
    // 本地 2026-10-30 01:30（UTC+8 下 ⇒ createdAt = 2026-10-29T17:30Z，日期头为前一天）
    const createdAt = new Date('2026-10-30T01:30:00').toISOString();
    writeFileSync(
      join(roundsDir, 'index.json'),
      JSON.stringify([
        { id: roundId, status: 'pending', refCount: 0, createdAt, file: `${roundId}.json` },
      ]),
      'utf-8',
    );
    writeFileSync(
      join(roundsDir, `${roundId}.json`),
      JSON.stringify({
        id: roundId,
        status: 'pending',
        refCount: 0,
        createdAt,
        userMessage: { id: 'm1', role: 'user', content: '凌晨的提问', timestamp: createdAt },
        processEvents: [],
      }),
      'utf-8',
    );
  });

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('按本地日期（宿主传入的 sessionDate）打捞 ⇒ 凌晨窗口命中；相邻本地日不中', () => {
    const roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();

    // 宿主传的是当前会话 ID 的本地日期前缀——修复后凌晨窗口必须命中（缺口断言已翻转）
    expect((roundStore.listInterruptedRecent?.('2026-10-30') ?? []).map((r) => r.id)).toContain(
      roundId,
    );
    // 半开区间边界：相邻两日本地日均不中（UTC+8 下 '2026-10-29' 正是该轮 UTC 日期头——
    // 修复前它才是唯一命中项，现在必须落空，否则说明又退回了前缀匹配）
    expect(roundStore.listInterruptedRecent?.('2026-10-29') ?? []).toHaveLength(0);
    expect(roundStore.listInterruptedRecent?.('2026-10-31') ?? []).toHaveLength(0);
  });
});
