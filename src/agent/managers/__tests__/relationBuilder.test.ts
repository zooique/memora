/**
 * RelationBuilder 单元测试 — conflictDetected 事件链路端到端覆盖（P0-7）
 *
 * 覆盖 ADR-014 核心特性：contradicts 关系检测 → onConflict 回调 → Agent.emit('conflictDetected')。
 *
 * 实际事件链路（以代码为准，src/agent/managers/relationBuilder.ts + src/agent/agent.ts:859-861）：
 *   1. RelationBuilder.buildRelations() 解析 LLM 输出的 relations 字段
 *   2. 对每条 type === 'contradicts' 且 targetId 在候选列表中的关系，写入 IMemoryRelationStore
 *   3. 若 onConflict 回调已绑定，构造 ConflictInfo 并调用回调
 *   4. Agent.init() 通过 insightExtractor.bindOnConflict((info) => this.emit('conflictDetected', info)) 接线
 *   5. Agent.emit('conflictDetected') 触发宿主 agent.on('conflictDetected', cb) 监听器
 *
 * ConflictInfo payload（与 AgentEventMap.conflictDetected 类型一致）：
 *   { newMemoryId, newInsight, targetId, targetContent }
 *
 * 静默降级路径（ADR-014 降级优先）：
 *   - relationStore 未注入 → buildRelations 首行 return，不触发回调
 *   - onConflict 未绑定 → contradicts 关系仍写入，但跳过回调（不抛错）
 *   - targetId 不在候选列表 → 跳过该关系（不写入、不回调）
 *   - InsightExtractor.relationBuilder 未注入 → bindOnConflict 经可选链 no-op
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RelationBuilder, type ConflictInfo } from '@/agent/managers/relationBuilder.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { InMemoryRelationStore } from '@/memory/inMemoryRelationStore.js';
import { TypedEventEmitter, type AgentEventMap } from '@/utils/eventEmitter.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Memory } from '@/memory/types.js';

// ═══════════════════════════════════════════════════════════════
// 测试辅助：构造记忆对象
// ═══════════════════════════════════════════════════════════════

/**
 * 构造一条测试用记忆（默认 source=insight, score=0.5）
 *
 * @param id 记忆 ID
 * @param content 记忆内容
 * @returns 符合 Memory schema 的测试记忆
 */
function makeMemory(id: string, content: string): Memory {
  const now = new Date().toISOString();
  return {
    id,
    content,
    source: SOURCE_LABELS.INSIGHT,
    name: `test-${id}`,
    createdAt: now,
    accessedAt: now,
    score: 0.5,
  };
}

// ═══════════════════════════════════════════════════════════════
// 测试辅助：模拟 Agent 的事件发射宿主
// ═══════════════════════════════════════════════════════════════

/**
 * 测试用事件宿主 — 模拟 Agent 的事件发射能力
 *
 * Agent 继承 TypedEventEmitter<AgentEventMap>，内部通过 protected emit() 发射事件。
 * 本类暴露 emitEvent() 作为 public 入口调用 protected emit()，
 * 忠实复现 agent.ts:859-861 中 `this.emit('conflictDetected', info)` 的接线模式。
 */
class TestEventHost extends TypedEventEmitter<AgentEventMap> {
  /**
   * 模拟 Agent.emit（Agent 内部方法调用 protected emit）
   *
   * @param event 事件名
   * @param payload 事件载荷
   */
  emitEvent<K extends keyof AgentEventMap & string>(event: K, payload: AgentEventMap[K]): void {
    this.emit(event, payload);
  }
}

// ═══════════════════════════════════════════════════════════════
// 测试：conflictDetected 事件链路（ADR-014 核心特性）
// ═══════════════════════════════════════════════════════════════

describe('RelationBuilder · conflictDetected 事件链路', () => {
  /** 记忆存储（用于候选召回，本测试主要用作候选来源） */
  let storage: InMemoryStorage;
  /** 关系存储（接收 contradicts 关系写入） */
  let relationStore: InMemoryRelationStore;
  /** 被测 RelationBuilder 实例 */
  let builder: RelationBuilder;

  beforeEach(() => {
    storage = new InMemoryStorage();
    relationStore = new InMemoryRelationStore();
    builder = new RelationBuilder(storage, relationStore);
  });

  // ─── 场景 1：contradicts → onConflict 回调 ───────────────

  it('场景1：检测到 contradicts 关系时应调用 onConflict 回调，参数为 ConflictInfo 结构', () => {
    // 预置被矛盾的目标记忆，并加入候选列表（buildRelations 要求 targetId 在候选中）
    const targetMemory = makeMemory('insight:old-preference', '用户喜欢咖啡');
    storage.upsert(targetMemory);
    const candidates: Memory[] = [targetMemory];

    // 注入 onConflict 回调 spy
    const onConflict = vi.fn();
    builder.bindOnConflict(onConflict);

    // 触发关系构建：新 insight 与目标记忆矛盾
    builder.buildRelations(
      'insight:new-change',
      '用户不再喝咖啡了',
      [{ targetId: 'insight:old-preference', type: 'contradicts' }],
      candidates,
    );

    // 验证回调被调用恰好一次
    expect(onConflict).toHaveBeenCalledTimes(1);
    // 验证回调参数完整匹配 ConflictInfo 结构（四字段）
    expect(onConflict.mock.calls[0]![0]).toEqual({
      newMemoryId: 'insight:new-change',
      newInsight: '用户不再喝咖啡了',
      targetId: 'insight:old-preference',
      targetContent: '用户喜欢咖啡',
    });
  });

  // ─── 场景 2：Agent 接线 → 宿主 on(conflictDetected) 收到事件 ───

  it('场景2：onConflict 经 Agent 接线后，宿主 on(conflictDetected) 能收到正确事件', () => {
    // 模拟 Agent.init() 的接线：bindOnConflict → emitter.emit('conflictDetected')
    const host = new TestEventHost();
    const received: AgentEventMap['conflictDetected'][] = [];
    host.on('conflictDetected', (payload) => received.push(payload));

    // 忠实复现 agent.ts:859-861 的接线模式
    builder.bindOnConflict((info) => {
      host.emitEvent('conflictDetected', info);
    });

    // 预置目标记忆并触发矛盾关系
    const targetMemory = makeMemory('insight:target-002', '旧结论');
    storage.upsert(targetMemory);
    builder.buildRelations(
      'insight:source-002',
      '新结论与旧结论矛盾',
      [{ targetId: 'insight:target-002', type: 'contradicts' }],
      [targetMemory],
    );

    // 验证宿主监听器收到事件（端到端链路打通）
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      newMemoryId: 'insight:source-002',
      newInsight: '新结论与旧结论矛盾',
      targetId: 'insight:target-002',
      targetContent: '旧结论',
    });
  });

  // ─── 场景 3：payload 字段精确匹配 ───────────────────────

  it('场景3：payload 四字段精确匹配 { newMemoryId, newInsight, targetId, targetContent }', () => {
    const targetMemory = makeMemory('m-target', '原始论断内容');
    storage.upsert(targetMemory);

    // 用捕获变量获取强类型 ConflictInfo（避免 as 断言）
    let captured: ConflictInfo | undefined;
    builder.bindOnConflict((info) => {
      captured = info;
    });

    builder.buildRelations(
      'm-new',
      '新洞察文本',
      [{ targetId: 'm-target', type: 'contradicts' }],
      [targetMemory],
    );

    // captured 应已被赋值
    expect(captured).toBeDefined();
    // 字段名与 AgentEventMap.conflictDetected 类型定义一致
    expect(captured!.newMemoryId).toBe('m-new');
    expect(captured!.newInsight).toBe('新洞察文本');
    expect(captured!.targetId).toBe('m-target');
    expect(captured!.targetContent).toBe('原始论断内容');
    // 确认无多余字段（ConflictInfo 恰好 4 个字段）
    expect(Object.keys(captured!)).toHaveLength(4);
  });

  // ─── 场景 4：无 relationStore → 静默降级 ────────────────

  it('场景4：relationStore 未注入时不触发 conflictDetected（静默降级，不抛错）', () => {
    // relationStore = null，模拟宿主未注入冲突检测能力
    const noStoreBuilder = new RelationBuilder(storage, null);
    const onConflict = vi.fn();
    noStoreBuilder.bindOnConflict(onConflict);

    // 不应抛错（graceful skip）
    expect(() => {
      noStoreBuilder.buildRelations(
        'insight:no-store',
        '内容',
        [{ targetId: 'any', type: 'contradicts' }],
        [makeMemory('any', '目标')],
      );
    }).not.toThrow();

    // 回调不应被调用
    expect(onConflict).not.toHaveBeenCalled();
  });

  it('场景4补充：onConflict 未绑定时检测到 contradicts 也不抛错（graceful skip）', () => {
    // 不调用 bindOnConflict，onConflict 保持 null
    const targetMemory = makeMemory('m-t', '目标');
    storage.upsert(targetMemory);

    expect(() => {
      builder.buildRelations(
        'm-s',
        '矛盾内容',
        [{ targetId: 'm-t', type: 'contradicts' }],
        [targetMemory],
      );
    }).not.toThrow();

    // 关系仍应写入存储（onConflict 缺失不影响关系持久化）
    expect(relationStore.getAllRelations()).toHaveLength(1);
  });

  // ─── 场景 5：非 contradicts → 不触发 onConflict ─────────

  it('场景5：非 contradicts 关系不应触发 onConflict', () => {
    const targetMemory = makeMemory('m-support-target', '支持目标');
    storage.upsert(targetMemory);
    const onConflict = vi.fn();
    builder.bindOnConflict(onConflict);

    // supports / follows / refines / related 均非冲突关系
    builder.buildRelations(
      'm-support-source',
      '支持性洞察',
      [
        { targetId: 'm-support-target', type: 'supports' },
        { targetId: 'm-support-target', type: 'follows' },
        { targetId: 'm-support-target', type: 'refines' },
        { targetId: 'm-support-target', type: 'related' },
      ],
      [targetMemory],
    );

    // 关系应正常写入（4 条非冲突关系）
    expect(relationStore.getAllRelations()).toHaveLength(4);
    // 但 onConflict 不应被调用（仅 contradicts 触发）
    expect(onConflict).not.toHaveBeenCalled();
  });

  // ─── 补充场景：边界情况加固 ─────────────────────────────

  it('补充：targetId 不在候选列表时不触发 onConflict（targetMemory 查找失败）', () => {
    const onConflict = vi.fn();
    builder.bindOnConflict(onConflict);

    // targetId 指向不在 candidates 中的记忆（LLM 输出了无效 ID）
    builder.buildRelations(
      'm-src',
      '内容',
      [{ targetId: 'not-in-candidates', type: 'contradicts' }],
      [makeMemory('another-id', '其他记忆')],
    );

    // 关系未写入（targetId 校验失败），回调未触发
    expect(relationStore.getAllRelations()).toHaveLength(0);
    expect(onConflict).not.toHaveBeenCalled();
  });

  it('补充：多条 contradicts 关系应逐条触发 onConflict', () => {
    // 预置两个被矛盾的目标记忆
    const target1 = makeMemory('m-c1', '论断一');
    const target2 = makeMemory('m-c2', '论断二');
    storage.upsert(target1);
    storage.upsert(target2);
    const onConflict = vi.fn();
    builder.bindOnConflict(onConflict);

    builder.buildRelations(
      'm-source-multi',
      '与多个旧论断矛盾',
      [
        { targetId: 'm-c1', type: 'contradicts' },
        { targetId: 'm-c2', type: 'contradicts' },
      ],
      [target1, target2],
    );

    // 两条矛盾关系各触发一次回调
    expect(onConflict).toHaveBeenCalledTimes(2);
    expect(onConflict.mock.calls[0]![0]).toMatchObject({
      targetId: 'm-c1',
      targetContent: '论断一',
    });
    expect(onConflict.mock.calls[1]![0]).toMatchObject({
      targetId: 'm-c2',
      targetContent: '论断二',
    });
  });
});
