/**
 * 端到端集成测试：Round 引用生命周期闭环
 *
 * 覆盖真实生产写点组合链路（不经 mock，直接使用内核实现）：
 *   MessageHistory（appendUser/appendAssistant/forkSession）
 *   + InMemorySessionStore（appendRoundId/deleteSession 引用递减）
 *   + InMemoryRoundStore（物理轮 + refCount）
 *   + InMemoryStorage（round-summary 记忆 + purge）
 *   + GCService（孤儿回收 + 摘要物理清理）
 *
 * 核心验证：
 *   - 分叉复制 ID 列表 + 共享轮 refCount 正确递增（1 → 2）
 *   - 删除源会话：共享轮存活、独占轮 refCount 归零成孤儿
 *   - GC 只清孤儿轮 + 其摘要（purge），共享轮及其摘要保留
 *   - 双删后引用归零，GC 全量清理（无双写残留）
 *   - 分叉后源会话续聊的新轮不进入分叉会话，引用计数准确
 */
import { describe, expect, it } from 'vitest';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
import { MessageHistory } from '@/agent/messageHistory.js';
import { GCService } from '@/memory/gcService.js';
import { generateRoundId, generateSummaryId } from '@/memory/roundStore.js';
import { todayDate } from '@/utils/time.js';
import type { Memory } from '@/memory/types.js';

/** 模拟 LLM 已生成的 round-summary（以 roundId 溯源） */
function seedSummary(storage: InMemoryStorage, roundId: string): void {
  storage.upsert({
    id: generateSummaryId(roundId),
    content: `摘要：${roundId}`,
    source: 'round-summary',
    name: roundId,
    createdAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
  } as Memory);
}

/** 创建 GC（minAgeMs=0 忽略存活时间，聚焦引用计数语义） */
function createGC(roundStore: InMemoryRoundStore, storage: InMemoryStorage): GCService {
  return new GCService(roundStore, storage, {
    minAgeMs: 0,
    batchSize: 10,
    cleanUpMemory: true,
    verbose: false,
  });
}

/** 造一轮问答：appendUser 写 pending（refCount=0）→ appendAssistant complete 才登记引用（0→1） */
async function appendRound(history: MessageHistory, content: string): Promise<string> {
  const roundId = generateRoundId();
  await history.appendUser(content, roundId);
  await history.appendAssistant(`回答：${content}`, roundId);
  return roundId;
}

/**
 * 创建 MessageHistory + 初始会话 meta（forkSession 的 getCurrentSessionMeta 要求 meta 存在，
 * 与 Agent switchToSession 的空会话建 meta 语义对齐）
 *
 * 日期锚点取 `todayDate()` 而非硬编码日期：`forkSession` 按设计会把 currentDate 同步为今天
 * （分叉键 = todayDate()-newSession，防跨天后写入错位），硬编码日期会让「分叉后切回源会话」
 * 落到「今天-同名」的新会话上，使本测试成为日期敏感用例（仅写入当天能过）。
 */
function createHistory(roundStore: InMemoryRoundStore, sessionStore: InMemorySessionStore): MessageHistory {
  const history = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
  sessionStore.createSession({
    sessionId: history.currentSessionName,
    roundIds: [],
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return history;
}

describe('Round 引用生命周期端到端', () => {
  it('分叉 → 删源会话共享轮存活 → GC 清孤儿与其摘要 → 双删后全清', async () => {
    const roundStore = new InMemoryRoundStore();
    const storage = new InMemoryStorage();
    const sessionStore = new InMemorySessionStore(roundStore);
    // 全链路真实组件（非 mock），初始会话 main
    const history = createHistory(roundStore, sessionStore);

    // 1. 造 3 轮 + 3 条摘要（模拟 LLM 已生成）：仅 complete 轮登记会话（refCount 0→1）
    const r1 = await appendRound(history, '第一问');
    const r2 = await appendRound(history, '第二问');
    const r3 = await appendRound(history, '第三问');
    for (const id of [r1, r2, r3]) seedSummary(storage, id);

    const sourceSessionId = history.currentSessionName;
    expect(sessionStore.getRoundIds(sourceSessionId)).toEqual([r1, r2, r3]);
    expect(roundStore.getById(r1)!.refCount).toBe(1); // 仅源会话引用

    // 2. 从 r2 分叉：新会话 roundIds = [r1, r2]，共享轮 refCount 1→2
    const fork = history.forkSession(r2);
    const forkSessionId = `${fork.date}-${fork.newSession}`;
    expect(sessionStore.getRoundIds(forkSessionId)).toEqual([r1, r2]);
    expect(roundStore.getById(r1)!.refCount).toBe(2);
    expect(roundStore.getById(r2)!.refCount).toBe(2);
    expect(roundStore.getById(r3)!.refCount).toBe(1); // 独占轮不受影响

    // 3. 删除源会话：共享轮 refCount→1 存活，独占轮 r3→0 成孤儿
    sessionStore.deleteSession(sourceSessionId);
    expect(sessionStore.getSessionMeta(sourceSessionId)).toBeUndefined(); // 删除契约：meta 不复现
    expect(roundStore.getById(r1)).not.toBeNull(); // 共享轮存活
    expect(roundStore.getById(r2)).not.toBeNull();
    expect(roundStore.getById(r3)!.refCount).toBe(0); // 独占轮成孤儿

    // 4. GC：只清孤儿 r3 + 其摘要（purge），共享轮及其摘要保留
    const gc = createGC(roundStore, storage);
    const first = gc.run();
    expect(first.deleted).toBe(1);
    expect(roundStore.getById(r1)).not.toBeNull();
    expect(roundStore.getById(r2)).not.toBeNull();
    expect(roundStore.getById(r3)).toBeNull();
    expect(storage.getById(generateSummaryId(r1))).not.toBeNull();
    expect(storage.getById(generateSummaryId(r3))).toBeNull(); // 摘要随孤儿物理清理

    // 5. 删除分叉会话：共享轮 refCount→0，双双成孤儿
    sessionStore.deleteSession(forkSessionId);
    expect(roundStore.getById(r1)!.refCount).toBe(0);

    // 6. 再 GC：全量清理共享轮 + 其摘要（无双写残留）
    const second = gc.run();
    expect(second.deleted).toBe(2);
    expect(second.memoryCleaned).toBe(2);
    expect(roundStore.size()).toBe(0);
    expect(storage.getById(generateSummaryId(r2))).toBeNull();
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
    expect(roundStore.getById(rA)!.refCount).toBe(2); // 源会话 + 分叉会话

    // 切回源会话续聊新轮：新轮只属于源会话，分叉会话 roundIds 不变。
    // 注：switchSession 只切 session 名、保持日期锚点；本用例锚点即 todayDate()，与 forkSession
    // 同步后的日期一致故可直接切回（跨日期切回须走 openSession 的 loadSessionMessages 路径）。
    history.switchSession('main');
    const rNew = await appendRound(history, '问题C');
    const sourceSessionId = history.currentSessionName;
    expect(sessionStore.getRoundIds(sourceSessionId)).toEqual([rA, rB, rNew]);
    expect(sessionStore.getRoundIds(forkSessionId)).toEqual([rA, rB]); // 分叉快照不受续聊影响
    expect(roundStore.getById(rNew)!.refCount).toBe(1);

    // 删除分叉会话：共享轮 refCount 2→1，新轮不受影响
    sessionStore.deleteSession(forkSessionId);
    expect(roundStore.getById(rA)!.refCount).toBe(1);
    expect(roundStore.getById(rB)!.refCount).toBe(1);
    expect(roundStore.getById(rNew)).not.toBeNull();

    // 删除源会话后全部归零，GC 全清（rA + rB + rNew）
    sessionStore.deleteSession(sourceSessionId);
    const gc = createGC(roundStore, storage);
    const result = gc.run();
    expect(result.deleted).toBe(3);
    expect(roundStore.size()).toBe(0);
  });
});