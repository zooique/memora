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

import { Agent, splitSessionId, type LlmChunk, type LlmProvider } from '@zooique/memora';
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
    // ⚠️ 这里喂的是**轮自己的 createdAt 日期前缀（UTC）**，不是生产宿主传的本地日期——
    // 即本用例刻意绕开了「本地日 vs UTC 日」的口径缺口（缺口由本文件最后一个 describe 锁定）。
    // 读这条用例时不要以为它证明了生产路径在任意时区都对。
    const date = roundStore.getById(crashedRoundId)!.createdAt.slice(0, 10);
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

    const date = roundStore.getById(crashedRoundId)!.createdAt.slice(0, 10);
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
 * ⚠️ 已知缺口锁定：「AI 已提问、用户未答」窗口崩溃 ⇒ **问题文本丢失（不可恢复）**
 *
 * 这是台账「交互轮落盘时机」存疑项的**实测定论**（2026-10-30）：**不可恢复**。
 *
 * 事实链：`handleAskUser` 把问题塞进内存 `pendingAsk` 后 yield `paused` 并结束本轮生成器
 * （进程空闲、等用户输入）。此刻 `appendAssistantToolCall` 虽已调用，但**没有把轮写回
 * RoundStore** ⇒ 磁盘上该轮只有 `userMessage`，`assistantMessage` 与 `processEvents` 双双缺失。
 * 崩溃重启后：轮能被打捞、能升级成 interrupted、用户能看到「我问过这句」，
 * **但 AI 问的那个问题（含候选项）彻底没了** —— 用户看到的是一个「没有问题的中断」。
 *
 * 修法方向（涉及内核落盘时机 + UI 恢复渲染，须单独立项，不在本条 e2e 里顺手改）：
 *   在 `handleAskUser` 进入挂起态之前，把「在途提问」持久化到该轮（processEvents 加
 *   question 事件，或 Round 加 pendingQuestion 字段），使重启后可重新渲染提问卡；
 *   同时要定「重启后提问卡是否可再次作答」的语义（答 = 续跑，不答 = 收场为中断）。
 */
describe('已知缺口：提问窗口崩溃 ⇒ 问题文本不可恢复', () => {
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

  it('盘面只有 userMessage：问题文本与过程事件都没落盘（这就是「不可恢复」）', () => {
    const index = JSON.parse(readFileSync(join(dataDir, 'rounds', 'index.json'), 'utf8')) as {
      id: string;
      status: string;
    }[];
    expect(index).toHaveLength(1);
    roundId = index[0]!.id;

    const round = JSON.parse(readFileSync(join(dataDir, 'rounds', `${roundId}.json`), 'utf8')) as {
      userMessage?: { content?: string };
      assistantMessage?: { content?: string; toolCalls?: unknown[] };
      processEvents?: unknown[];
    };
    // 用户那一句在（appendUser 即时落盘）
    expect(round.userMessage?.content).toBe('崩溃窗口测试提问');
    // 问题不在：assistantMessage 与 processEvents 都缺 ⇒ 恢复后无法重建提问卡
    expect(round.assistantMessage).toBeUndefined();
    expect(round.processEvents ?? []).toHaveLength(0);
    // 明确一点：整份 round 文本里搜不到提问内容（防「其实藏在某个字段里」的自我安慰）
    expect(readFileSync(join(dataDir, 'rounds', `${roundId}.json`), 'utf8')).not.toContain(
      '选哪个方案',
    );
  });

  it('但轮本身不丢：重启后仍可打捞并升级为 interrupted（用户至少看到「问过、被中断」）', async () => {
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

    const date = roundStore.getById(roundId)!.createdAt.slice(0, 10);
    const upgraded = await salvageInterruptedRounds({
      store: roundStore,
      history: agent.agentHistory!,
      sessionDate: date,
    });
    expect(upgraded).toBeGreaterThanOrEqual(1);
    expect(roundStore.getById(roundId)!.status).toBe('interrupted');
    // 不写空 assistantMessage（内核既有语义：无产出也按 stop 收场）
    expect(roundStore.getById(roundId)!.assistantMessage).toBeUndefined();

    await agent.close();
  }, 120_000);
});

/**
 * ⚠️ 已知口径缺口（不是本文件的期望行为，是**待修缺陷的锁定**，登记 `E2E-TZ-SALVAGE-1`）
 *
 * 两个日期口径在同一条链上各用各的：
 *   - 会话 ID 的日期 = **本地日期**（`_currentSessionId.slice(0, 10)`，用户看到的「今天」）；
 *   - 轮的 `createdAt` = **UTC ISO**（`toISOString()`）。
 *
 * 打捞口用 `createdAt.startsWith(date)` 前缀匹配 ⇒ 在 UTC+8 的**本地 00:00–08:00**
 * 创建的中断轮，其 `createdAt` 是 UTC 的**前一天**，按本地日期永远捞不到；该轮要等到
 * 24h 存活保护到点后被 GC 当孤儿回收 ⇒ **静默丢失**（用户视角：凌晨崩溃的那一轮答案没了，
 * 且没有任何提示）。
 *
 * 为什么单独用构造盘来测：真杀进程造不出「凌晨」这个时间条件（除非改系统时钟，那会污染
 * 其它用例）。`listInterruptedRecent` 是纯读接口，喂构造好的磁盘状态是合法输入。
 *
 * 修法待拍板（不在这条任务里顺手改，避免「修根因」与「补覆盖」混成一刀）：
 *   ① 打捞改**本地日区间**（`[D 00:00, D+1 00:00) 本地 → UTC` 后比较）——语义最正，
 *      但要给 `IRoundStore.listInterruptedRecent` 定新的入参契约；
 *   ② 或统一轮的时间戳口径（改动面最大，波及所有 createdAt 消费点，不建议）。
 */
describe('已知口径缺口：本地日期 vs UTC 时间戳，凌晨窗口的中断轮捞不到', () => {
  let ws: string;
  const roundId = 'round-tz-gap';

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), 'memora-tz-gap-'));
    const roundsDir = join(ws, '.memora', 'rounds');
    mkdirSync(roundsDir, { recursive: true });
    // 北京时间 2026-10-30 01:30 ⇒ createdAt 落在 UTC 2026-10-29T17:30Z
    const createdAt = '2026-10-29T17:30:00.000Z';
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

  it('按本地日期（宿主传入的 sessionDate）打捞 ⇒ 漏捞；按 UTC 日期 ⇒ 命中', () => {
    const roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();

    // 宿主传的是当前会话 ID 的本地日期前缀
    expect(roundStore.listInterruptedRecent?.('2026-10-30') ?? []).toHaveLength(0);
    // 轮自己的时间戳口径（UTC）才能命中 —— 两条口径不重合，就是缺口本身
    expect((roundStore.listInterruptedRecent?.('2026-10-29') ?? []).map((r) => r.id)).toContain(
      roundId,
    );
  });
});
