/**
 * 端到端集成测试：Round 引用生命周期闭环
 *
 * 覆盖真实生产写点组合链路（不经 mock，直接使用内核实现）：
 *   MessageHistory（appendUser/appendAssistant/forkSession）
 *   + InMemorySessionStore（appendRoundId/deleteSession 现场派生引用集合）
 *   + InMemoryRoundStore（物理轮；refCount 仅作存在性标记）
 *   + InMemoryStorage（round-summary 记忆 + purge）
 *   + GCService（孤儿回收 + 摘要物理清理）
 *
 * 核心验证（6.0.0 批 1 口径）：
 *   - **引用真源 = 会话 roundIds**：分叉只复制指针，不改轮次文件、不改 refCount
 *   - 删除源会话：共享轮存活、独占轮按派生集合判 0 回收
 *   - GC：只清「不在任何会话 roundIds 中」的轮 + 其摘要（purge）
 *   - 接受判据：10 轮（5 引用 / 5 孤儿）sweep 后引用轮全在、孤儿全收
 */
import { describe, expect, it } from 'vitest';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
import { MessageHistory } from '@/agent/messageHistory.js';
import { GCService } from '@/memory/gcService.js';
import { completeRound, generateRoundId } from '@/memory/roundStore.js';
import { createPendingRoundFixture } from './helpers/roundFixture.js';
import { todayDate } from '@/utils/time.js';
import type { Memory } from '@/memory/types.js';

/**
 * 模拟 LLM 已生成的 round-summary（以 roundId 溯源）
 *
 * ID 采用**规范两段式** `round-summary:{session}:{roundId}`（与 roundSummaryGenerator
 * 实际写入形态一致）；GC 按 `roundId` 顶层字段反查清理，故 roundId 必须落顶层。
 */
const TEST_SESSION = '2026-09-10-main';

function summaryIdOf(roundId: string): string {
  return `round-summary:${TEST_SESSION}:${roundId}`;
}

function seedSummary(storage: InMemoryStorage, roundId: string): void {
  storage.upsert({
    id: summaryIdOf(roundId),
    content: `摘要：${roundId}`,
    source: 'round-summary',
    name: roundId,
    roundId,
    createdAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
  } as Memory);
}

/** 创建 GC（minAgeMs=0 忽略存活时间，聚焦引用集合派生语义） */
function createGC(roundStore: InMemoryRoundStore, storage: InMemoryStorage): GCService {
  return new GCService(roundStore, storage, {
    minAgeMs: 0,
    batchSize: 10,
    cleanUpMemory: true,
    verbose: false,
  });
}

/** 造一轮问答：appendUser 建 pending 并登记会话 → appendAssistant 收场 */
async function appendRound(history: MessageHistory, content: string): Promise<string> {
  const roundId = generateRoundId();
  await history.appendUser(content, roundId);
  await history.appendAssistant(`回答：${content}`, roundId);
  return roundId;
}

/** 直接造一个「无会话引用」的 complete 轮（模拟崩溃残留 / 存量孤儿） */
function seedOrphanRound(roundStore: InMemoryRoundStore, content: string): string {
  const round = createPendingRoundFixture(content);
  const completed = completeRound(round, `回答：${content}`);
  roundStore.save(completed);
  return completed.id;
}

/**
 * 创建 MessageHistory + 初始会话 meta（forkSession 的 getCurrentSessionMeta 要求 meta 存在，
 * 与 Agent switchToSession 的空会话建 meta 语义对齐）
 *
 * 日期锚点取 `todayDate()`：`forkSession` 按设计会把 currentDate 同步为今天
 * （分叉键 = todayDate()-newSession，防跨天后写入错位）。
 */
function createHistory(
  roundStore: InMemoryRoundStore,
  sessionStore: InMemorySessionStore,
): MessageHistory {
  const history = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
  sessionStore.createSession({
    sessionId: history.currentSessionName,
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return history;
}

describe('Round 引用生命周期端到端', () => {
  it('分叉 → 删源会话共享轮存活 → 删分叉后共享轮才回收', async () => {
    const roundStore = new InMemoryRoundStore();
    const storage = new InMemoryStorage();
    const sessionStore = new InMemorySessionStore(roundStore);
    const history = createHistory(roundStore, sessionStore);

    // 1. 造 3 轮
    const r1 = await appendRound(history, '第一问');
    const r2 = await appendRound(history, '第二问');
    const r3 = await appendRound(history, '第三问');
    for (const id of [r1, r2, r3]) seedSummary(storage, id);

    const sourceSessionId = history.currentSessionName;
    expect(sessionStore.getRoundIds(sourceSessionId)).toEqual([r1, r2, r3]);
    // 引用真源：三张轮各自只被源会话引用一次
    expect(sessionStore.referencedIds().sort()).toEqual([r1, r2, r3].sort());

    // 2. 从 r2 分叉：共享轮仍只有一份物理文件，引用集合多出一个会话
    const fork = history.forkSession(r2);
    const forkSessionId = `${fork.date}-${fork.newSession}`;
    expect(sessionStore.getRoundIds(forkSessionId)).toEqual([r1, r2]);
    // refCount 冻结：分叉不改写轮次文件
    expect(roundStore.getById(r1)!.refCount).toBe(1);
    expect(roundStore.getById(r2)!.refCount).toBe(1);
    expect(roundStore.getById(r3)!.refCount).toBe(1);

    // 3. 删除源会话：共享轮 r1/r2 仍被分叉会话引用 ⇒ 存活；独占轮 r3 无人引用 ⇒ 当场回收
    sessionStore.deleteSession(sourceSessionId);
    expect(sessionStore.getSessionMeta(sourceSessionId)).toBeUndefined();
    expect(roundStore.getById(r1)).not.toBeNull();
    expect(roundStore.getById(r2)).not.toBeNull();
    expect(roundStore.getById(r3)).toBeNull();
    expect(sessionStore.referencedIds().sort()).toEqual([r1, r2].sort());

    // 4. GC 无孤儿可清（引用集合派生已在上一步完成回收）
    const gc = createGC(roundStore, storage);
    const first = gc.run();
    expect(first.deleted).toBe(0);

    // 5. 删除分叉会话：共享轮也失去全部引用 ⇒ 当场回收
    sessionStore.deleteSession(forkSessionId);
    expect(roundStore.getById(r1)).toBeNull();
    expect(roundStore.getById(r2)).toBeNull();
    expect(roundStore.size()).toBe(0);
    expect(sessionStore.referencedIds()).toEqual([]);
  });

  it('GC：10 轮（5 引用 / 5 孤儿）sweep 后引用轮全在、孤儿全收（含摘要）', () => {
    const roundStore = new InMemoryRoundStore();
    const storage = new InMemoryStorage();
    const sessionStore = new InMemorySessionStore(roundStore);
    sessionStore.createSession({
      sessionId: TEST_SESSION,
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const referenced: string[] = [];
    const orphaned: string[] = [];
    // 5 个被会话引用的轮
    for (let i = 0; i < 5; i++) {
      const id = seedOrphanRound(roundStore, `引用轮 ${i}`);
      sessionStore.appendRoundId(TEST_SESSION, id);
      seedSummary(storage, id);
      referenced.push(id);
    }
    // 5 个孤儿轮（不在任何会话 roundIds 中）
    for (let i = 0; i < 5; i++) {
      const id = seedOrphanRound(roundStore, `孤儿轮 ${i}`);
      seedSummary(storage, id);
      orphaned.push(id);
    }
    expect(roundStore.size()).toBe(10);

    const gc = createGC(roundStore, storage);
    const result = gc.run();

    // 验收判据：引用 5/5 仍在、孤儿全收
    expect(result.deleted).toBe(5);
    expect(result.memoryCleaned).toBe(5);
    for (const id of referenced) expect(roundStore.getById(id)).not.toBeNull();
    for (const id of orphaned) expect(roundStore.getById(id)).toBeNull();
    for (const id of referenced) expect(storage.getById(summaryIdOf(id))).not.toBeNull();
    for (const id of orphaned) expect(storage.getById(summaryIdOf(id))).toBeNull();
  });

  it('分叉后源会话续聊的新轮不进入分叉会话；删分叉后新轮仍存活', async () => {
    const roundStore = new InMemoryRoundStore();
    const storage = new InMemoryStorage();
    const sessionStore = new InMemorySessionStore(roundStore);
    const history = createHistory(roundStore, sessionStore);

    // 2 轮后分叉（不传 roundId = 等效全量分叉）
    const rA = await appendRound(history, '问题A');
    const rB = await appendRound(history, '问题B');
    const fork = history.forkSession();
    const forkSessionId = `${fork.date}-${fork.newSession}`;
    expect(fork.roundIds).toEqual([rA, rB]);

    // 切回源会话续聊新轮：新轮只属于源会话，分叉会话 roundIds 不变
    history.switchSession('main');
    const rNew = await appendRound(history, '问题C');
    const sourceSessionId = history.currentSessionName;
    expect(sessionStore.getRoundIds(sourceSessionId)).toEqual([rA, rB, rNew]);
    expect(sessionStore.getRoundIds(forkSessionId)).toEqual([rA, rB]);

    // 删除分叉会话：共享轮仍被源会话引用 ⇒ 存活；新轮不受影响
    sessionStore.deleteSession(forkSessionId);
    expect(roundStore.getById(rA)).not.toBeNull();
    expect(roundStore.getById(rB)).not.toBeNull();
    expect(roundStore.getById(rNew)).not.toBeNull();

    // 删除源会话后全部失去引用 ⇒ 全量回收
    sessionStore.deleteSession(sourceSessionId);
    expect(roundStore.size()).toBe(0);
    expect(createGC(roundStore, storage).run().deleted).toBe(0);
  });
});
