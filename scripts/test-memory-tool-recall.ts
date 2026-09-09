/**
 * 记忆纯工具化召回 阶段1 · 工具升级（步进D/E）—— 演示脚本
 *
 * 用法：
 *   npx tsx scripts/test-memory-tool-recall.ts
 *
 * 演示内容（对照 memory-tool-recall-design §3.3/§3.4/§5.2 定案）：
 *   1. search_memories 语义混合后端（searchHybrid）：返回结构化字段
 *      similarity / accessedAt / sessionId / roundId（round-summary 溯源揭示，LLM 零解析直用 trace_summary）
 *   2. supersededBy 过滤：被取代的摘要不作为当前事实返回（仍可溯源）
 *   3. 命中即 touch：search_memories 命中后 fire-and-forget 刷新 accessedAt（score 已随阶段3 退役）
 *   4. memoryRecalled 事件：LLM 查询记忆命中 N 条 → 宿主感知（§2.4「保留改语义」）
 *   5. touchScores（warmRecall 收敛，§5.2）：仅刷新 accessedAt，无 score 写位
 *
 * 验收：脚本输出全部 ✅，process.exitCode = 0。
 * 注：本脚本是「机制实测」脚手架（验证链路可运行、字段可观测），不替代设计 §阶段1 的
 * A/B 模型行为验收（想起率/命中率需真实 LLM + 问题集 + 人工判答案优劣）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '../src/memory/inMemoryStorage.js';
import { MemoryInspector, type AgentSearchHit } from '../src/agent/managers/memoryInspector.js';
import { BuiltinToolHandlers } from '../src/agent/builtinToolHandlers.js';
import { SecurityGuard } from '../src/security/pathGuard.js';
import { awaitBackgroundTasks } from '../src/utils/backgroundTask.js';
import { touchScores } from '../src/memory/recall.js';
import { nowIso } from '../src/utils/time.js';
import type { Memory } from '../src/memory/types.js';
import type { MessageHistory } from '../src/agent/messageHistory.js';
import type { AgentLoop } from '../src/agent/loop.js';
import type { IVectorStore } from '../src/memory/vectorStore.js';

// ─── 断言工具 ──────────────────────────────────────────

/** 断言工具函数：失败置 exitCode=1 但不中断后续演示 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  ❌ 断言失败: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✅ 断言通过: ${message}`);
  }
}

// ─── 测试夹具（复用内核测试的构造模式，SSOT：不造独立实现） ──

/** 构造 Memory 对象（默认 source=content） */
function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: '默认内容',
    source: 'content',
    name: 'default',
    createdAt: '2026-06-27T10:00:00.000Z',
    accessedAt: '2026-06-27T10:00:00.000Z',
    ...overrides,
  };
}

/** Mock AgentLoop（MemoryInspector 仅用到 getMessages） */
function createMockLoop(messages: unknown[] = []): AgentLoop {
  return { getMessages: () => messages } as unknown as AgentLoop;
}

/** Mock MessageHistory（MemoryInspector 仅用到 session/currentSessionName） */
function createMockHistory(): MessageHistory {
  return { session: 'main', currentSessionName: '2026-09-09-main' } as unknown as MessageHistory;
}

/** Mock VectorStore（可控命中集，验证 searchHybrid 融合 + superseded 过滤） */
function createMockVectorStore(
  searchResults: Array<{ id: string; similarity: number }>,
): IVectorStore {
  return {
    size: 10,
    search: async () => searchResults,
  } as unknown as IVectorStore;
}

// ─── 主函数 ──────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🔍 记忆纯工具化召回 · 阶段1 工具升级（步进 D/E）—— 演示\n');

  // 临时项目目录（BuiltinToolHandlers 需要 projectPath + SecurityGuard 白名单）
  const projectPath = await mkdtemp(join(tmpdir(), 'memora-recall-demo-'));

  try {
    // ─── 数据准备：语义记忆 / round-summary（含溯源）/ 已被取代的旧摘要 ──
    const storage = new InMemoryStorage();
    storage.upsert(
      createMemory({
        id: 'content:leak',
        name: 'heap 溢出排查',
        content: '上次线上内存泄漏：根因是 EventEmitter 监听未移除，逐事件解除后稳定。',
      }),
    );
    storage.upsert(
      createMemory({
        id: 'round-summary:2026-09-01-main:r5',
        source: 'round-summary',
        name: '轮次摘要 2026-09-01-main r5',
        content: '用户决定采用检索增强方案替代自动注入（决策摘要）。',
        sessionName: '2026-09-01-main',
        roundId: 'r5',
      }),
    );
    // 旧摘要被新摘要取代：supersededBy 指向新条目 → searchHybrid 应过滤
    storage.upsert(
      createMemory({
        id: 'content:superseded-old',
        name: '旧偏好',
        content: '旧的用户偏好（已被新偏好取代，不应作为当前事实返回）。',
        supersededBy: 'content:superseded-new',
      }),
    );

    // 注入 MemoryInspector + 语义后端（vectorStore 返回上述三者的可控命中）
    const inspector = new MemoryInspector(
      storage,
      createMockLoop(),
      createMockHistory(),
    );
    inspector.setVectorStore(
      createMockVectorStore([
        { id: 'content:leak', similarity: 0.9 },
        { id: 'round-summary:2026-09-01-main:r5', similarity: 0.85 },
        { id: 'content:superseded-old', similarity: 0.8 },
      ]),
    );

    // ─── 1. searchHybrid 结构化字段 + superseded 过滤 ──────────
    console.log('📋 1. searchHybrid：结构化溯源字段 + superseded 过滤');
    const hits = await inspector.searchHybrid('内存泄漏 检索方案 偏好', 10);

    const ids = hits.map((h) => h.id);
    assert(ids.includes('content:leak'), `语义命中 content:leak（实际: ${ids.join(', ')}）`);
    assert(ids.includes('round-summary:2026-09-01-main:r5'), `round-summary 命中（实际: ${ids.join(', ')}）`);
    assert(!ids.includes('content:superseded-old'), 'supersededBy 旧摘要被过滤（不作为当前事实）');

    const rs = hits.find((h) => h.id === 'round-summary:2026-09-01-main:r5') as AgentSearchHit;
    assert(rs.similarity !== undefined, `round-summary 带 similarity（实际: ${rs.similarity}）`);
    assert(rs.accessedAt !== undefined, `round-summary 带 accessedAt 事实字段`);
    assert(rs.sessionId === '2026-09-01-main', `round-summary 溯源 sessionId（实际: ${rs.sessionId}，trace_summary 直通）`);
    assert(rs.roundId === 'r5', `round-summary 溯源 roundId（实际: ${rs.roundId}，trace_summary 直通）`);

    // ─── 2. BuiltinToolHandlers.searchMemories 端到端：touch + 事件 + 溯源揭示 ──
    console.log('\n📋 2. search_memories 端到端：命中 touch + memoryRecalled 事件 + 溯源揭示');
    const security = new SecurityGuard(projectPath, projectPath);
    const handlers = new BuiltinToolHandlers(projectPath, security, storage);
    // 语义后端注入（§3.3：未注入回退旧关键词，注入后走 searchHybrid）
    handlers.setMemoryInspector(inspector);

    // memoryRecalled 事件捕获（§2.4 保留改语义定案）
    let recalledEvent: { count: number; query: string } | null = null;
    handlers.setOnMemoryRecalled((info) => {
      recalledEvent = info;
    });

    // 记录 touch 前状态
    const leakBefore = storage.getById('content:leak');
    const leakedId = leakBefore?.id;

    const toolResult = await handlers.searchMemories('内存泄漏', '10', 'match');
    console.log(`  📜 工具返回（摘要）:\n  ${toolResult.replace(/\n/g, '\n  ')}`);

    // touch 经 backgroundTask 异步刷新，需等待其完成
    await awaitBackgroundTasks(2000);

    const leakAfter = storage.getById(leakedId ?? 'content:leak');
    assert(leakAfter !== null, 'content:leak 仍存在');
    assert(
      leakAfter !== null && leakAfter.accessedAt !== leakBefore?.accessedAt,
      `touch 刷新 accessedAt（前=${leakBefore?.accessedAt} 后=${leakAfter?.accessedAt}）`,
    );
    assert(
      recalledEvent !== null && recalledEvent.count > 0 && recalledEvent.query === '内存泄漏',
      `memoryRecalled 事件发射（count=${recalledEvent?.count} query=${recalledEvent?.query}）`,
    );

    // ─── 3. touchScores（warmRecall 收敛 §5.2）：只刷 accessedAt（score 已随阶段3 退役） ──
    console.log('\n📋 3. touchScores（warmRecall 收敛）：touch → 只刷 accessedAt');
    const target = storage.getById('round-summary:2026-09-01-main:r5');
    await touchScores(storage, [target?.id ?? ''], '2099-01-01T00:00:00.000Z');
    const touched = storage.getById('round-summary:2026-09-01-main:r5');
    assert(
      touched?.accessedAt === '2099-01-01T00:00:00.000Z',
      `touchScores 刷新 accessedAt（实际: ${touched?.accessedAt}）`,
    );

    console.log(`\n🎉 演示完成（now=${nowIso()}）。`);
    console.log('说明：本脚本验证「机制可运行 + 字段可观测」；A/B 模型行为验收（想起率/命中率）');
    console.log('     需真实 LLM + 问题集 + 人工判答案优劣，见设计 §阶段1 出口条件。');
  } finally {
    // 清理临时目录
    await rm(projectPath, { recursive: true, force: true });
  }
}

// 执行主函数
main().catch((err) => {
  console.error('演示脚本异常:', err);
  process.exit(1);
});