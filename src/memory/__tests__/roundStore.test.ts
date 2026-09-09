/**
 * 单元测试：问答闭环存储（RoundStore）
 * 验证 InMemoryRoundStore 的核心功能
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import {
  createPendingRound,
  completeRound,
  generateRoundId,
  generateMessageId,
  generateSummaryId,
  parseRoundIdFromSummaryId,
  type ProcessEvent,
  type Round,
} from '@/memory/roundStore.js';

describe('问答闭环存储', () => {
  let store: InMemoryRoundStore;

  beforeEach(() => {
    store = new InMemoryRoundStore();
  });

  describe('InMemoryRoundStore', () => {
    it('应该保存和获取问答闭环', () => {
      // 创建 pending Round
      const round = createPendingRound('你好');

      // 保存
      store.save(round);

      // 获取
      const retrieved = store.getById(round.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(round.id);
      expect(retrieved?.status).toBe('pending');
      expect(retrieved?.userMessage.content).toBe('你好');
      expect(retrieved?.refCount).toBe(1);
    });

    it('listInterruptedRecent：列出指定日期崩溃残留轮（pending/error + refCount=0 + 倒序）', () => {
      // 构造崩溃残留轮：覆盖工厂默认（refCount=1）为 refCount=0（崩溃发生在 appendAssistant 前的形态）
      const mk = (date: string, min: string, status: Round['status']): void => {
        const base = createPendingRound(`q-${min}`);
        // status 覆盖 complete 需补 summaryId 才符合完成语义；此处仅验证过滤，不做模型完整性校验
        const round: Round = {
          ...base,
          status,
          refCount: 0,
          createdAt: `${date}T${min}:00.00.000Z`,
        };
        store.save(round);
      };
      // 目标日期：pending 两条 + error 一条（最新在前，分钟序 2 > 0 > 1）
      mk('2026-09-09', '00', 'pending');
      mk('2026-09-09', '01', 'pending');
      mk('2026-09-09', '02', 'error');
      // 排除项：他日 pending、同日 complete（归零轮非未完成残留）
      mk('2026-09-08', '03', 'pending');
      mk('2026-09-09', '04', 'complete');
      // 排除项：被引用（refCount>0）的 pending——进行中轮不属崩溃残留
      const refed = createPendingRound('refed');
      refed.refCount = 1;
      store.save(refed);

      // 全量：仅 3 条目标，按 createdAt 倒序（最新在前，分钟序 02 > 01 > 00）
      const all = store.listInterruptedRecent('2026-09-09');
      expect(all).toHaveLength(3);
      expect(all.map((r) => r.userMessage.content)).toEqual(['q-02', 'q-01', 'q-00']);

      // limit 截断：取最新 2 条
      const limited = store.listInterruptedRecent('2026-09-09', 2);
      expect(limited).toHaveLength(2);
      expect(limited[0]?.userMessage.content).toBe('q-02');
      expect(limited[1]?.userMessage.content).toBe('q-01');
    });

    it('应该完成问答闭环', () => {
      // 创建并完成 Round
      const round = createPendingRound('你好');
      store.save(round);

      const completed = completeRound(round, '你好！有什么可以帮你的？');
      store.save(completed);

      // 获取并验证
      const retrieved = store.getById(round.id);
      expect(retrieved?.status).toBe('complete');
      expect(retrieved?.assistantMessage?.content).toBe('你好！有什么可以帮你的？');
      expect(retrieved?.summaryId).toBe(`round-summary:${round.id}`);
      expect(retrieved?.completedAt).toBeDefined();
    });

    it('应该批量获取问答闭环', () => {
      // 创建多个 Round
      const round1 = createPendingRound('第一个问题');
      const round2 = createPendingRound('第二个问题');
      const round3 = createPendingRound('第三个问题');

      store.save(round1);
      store.save(round2);
      store.save(round3);

      // 批量获取
      const results = store.getByIds([round1.id, round3.id]);
      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe(round1.id);
      expect(results[1]!.id).toBe(round3.id);
    });

    it('应该跳过批量获取中不存在的 ID', () => {
      const round1 = createPendingRound('存在的');
      store.save(round1);

      // 包含不存在的 ID
      const results = store.getByIds([round1.id, '不存在的-id']);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(round1.id);
    });

    it('应该列出所有问答闭环', () => {
      const round1 = createPendingRound('问题1');
      const round2 = createPendingRound('问题2');

      store.save(round1);
      store.save(round2);

      const all = store.listAll();
      expect(all).toHaveLength(2);
      expect(store.size()).toBe(2);
    });

    it('应该按状态筛选问答闭环', () => {
      // 创建不同状态的 Round
      const pendingRound = createPendingRound('待处理');
      store.save(pendingRound);

      const completedRound = createPendingRound('已完成');
      const completed = completeRound(completedRound, '完成');
      store.save(completed);

      // 按状态筛选
      const pendingList = store.listByStatus('pending');
      const completedList = store.listByStatus('complete');

      expect(pendingList.length).toBeGreaterThanOrEqual(1);
      expect(completedList.length).toBeGreaterThanOrEqual(1);
    });

    it('应该管理引用计数', () => {
      const round = createPendingRound('测试引用');
      store.save(round);

      // 初始 refCount = 1
      const initial = store.getById(round.id);
      expect(initial?.refCount).toBe(1);

      // 增加引用
      store.incrementRef(round.id);
      const afterIncrement = store.getById(round.id);
      expect(afterIncrement?.refCount).toBe(2);

      // 减少引用
      store.decrementRef(round.id);
      const afterDecrement = store.getById(round.id);
      expect(afterDecrement?.refCount).toBe(1);

      // 减少到 0 以下不允许
      store.decrementRef(round.id);
      store.decrementRef(round.id); // 尝试继续减少
      const afterOverflow = store.getById(round.id);
      expect(afterOverflow?.refCount).toBe(0); // 不会降到 0 以下
    });

    it('应该删除孤立的问答闭环', () => {
      // 创建 refCount=0 的 Round
      const round = createPendingRound('待删除');
      // 手动设置 refCount=0
      round.refCount = 0;
      store.save(round);

      // 应该能删除
      const deleted = store.delete(round.id);
      expect(deleted).toBe(true);
      expect(store.getById(round.id)).toBeNull();
      expect(store.size()).toBe(0);
    });

    it('不应该删除仍被引用的问答闭环', () => {
      const round = createPendingRound('被引用');
      store.save(round);

      // refCount=1 > 0，不允许删除
      const deleted = store.delete(round.id);
      expect(deleted).toBe(false);
      expect(store.getById(round.id)).not.toBeNull();
    });

    it('应该列出孤立的问答闭环', () => {
      // 创建孤立的 Round（refCount=0 且 complete）
      const round1 = createPendingRound('孤立1');
      const completed1 = completeRound(round1, '完成1');
      completed1.refCount = 0;
      store.save(completed1);

      // 创建非孤立的 Round（refCount=2）
      const round2 = createPendingRound('非孤立');
      const completed2 = completeRound(round2, '完成2');
      completed2.refCount = 2;
      store.save(completed2);

      // 列出孤立的
      const orphaned = store.listOrphaned(0); // minAgeMs=0 忽略存活时间
      expect(orphaned.length).toBe(1);
      expect(orphaned[0]!.id).toBe(round1.id);
    });

    it('应该尊重最小存活时间', () => {
      // 创建刚完成的 Round
      const round = createPendingRound('新的');
      const completed = completeRound(round, '新完成');
      completed.refCount = 0;
      store.save(completed);

      // 存活时间设置为 1 小时，应该过滤掉
      const orphaned = store.listOrphaned(60 * 60 * 1000);
      expect(orphaned.length).toBe(0); // 不会被列出
    });

    it('应该忽略不存在的 Round 操作', () => {
      // 获取不存在的 ID
      expect(store.getById('不存在的-id')).toBeNull();

      // 增加不存在的 ID 的引用（不报错）
      expect(() => store.incrementRef('不存在的-id')).not.toThrow();

      // 减少不存在的 ID 的引用（不报错）
      expect(() => store.decrementRef('不存在的-id')).not.toThrow();
    });

    it('应该支持清空操作', () => {
      const round = createPendingRound('测试');
      store.save(round);
      expect(store.size()).toBe(1);

      store.clear();
      expect(store.size()).toBe(0);
    });
  });

  describe('processEvents 过程事件透传', () => {
    it('应该完整透传保存的 processEvents（含 seq 顺序与各类型 payload）', () => {
      // 构造一轮完整的过程事件（meta 首条 → recall → tool_start → metrics 末条）
      const round = createPendingRound('你好');
      const completed = completeRound(round, '你好！');
      const events: ProcessEvent[] = [
        { type: 'meta', seq: 1, ts: '2026-08-28T00:00:00.000Z', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
        { type: 'recall', seq: 2, ts: '2026-08-28T00:00:01.000Z', payload: { memories: [{ id: 'round-summary:r1', name: '设计约束', source: 'round-summary', score: 0.9 }] } },
        { type: 'tool_start', seq: 3, ts: '2026-08-28T00:00:02.000Z', payload: { toolCallId: 'tc1', name: 'read_file', args: '{"path":"a.md"}' } },
        { type: 'tool_result', seq: 4, ts: '2026-08-28T00:00:03.000Z', payload: { toolCallId: 'tc1', name: 'read_file', ok: true, summary: '读取成功' } },
        { type: 'metrics', seq: 5, ts: '2026-08-28T00:00:04.000Z', payload: { durationMs: 4000, tokenIn: 100, tokenOut: 200, toolFailureCount: 0, recallCount: 1, success: true } },
      ];
      completed.processEvents = events;
      store.save(completed);

      // 找回后事件完整且顺序一致
      const retrieved = store.getById(completed.id);
      expect(retrieved?.processEvents).toHaveLength(5);
      expect(retrieved?.processEvents?.map((e) => e.type)).toEqual(['meta', 'recall', 'tool_start', 'tool_result', 'metrics']);
      expect(retrieved?.processEvents?.[0]).toEqual(events[0]);
      expect(retrieved?.processEvents?.[4]).toEqual(events[4]);
    });

    it('缺省 processEvents（pending/error 轮无过程数据），不渲染 round-block', () => {
      const round = createPendingRound('用户问题');
      store.save(round);

      const retrieved = store.getById(round.id);
      expect(retrieved?.processEvents).toBeUndefined();
    });

    it('增量变更 processEvents（Write-once 前宿主追加）后重新保存可覆盖', () => {
      // 模拟宿主流结束后的「读 Round → 附加 processEvents → save」写入路径
      const round = createPendingRound('问题');
      const completed = completeRound(round, '回答');
      store.save(completed);

      const current = store.getById(completed.id)!;
      current.processEvents = [
        { type: 'meta', seq: 1, ts: '2026-08-28T00:00:00.000Z', payload: { role: 'AI', llm: 'deepseek-chat' } },
        { type: 'aborted', seq: 2, ts: '2026-08-28T00:00:01.000Z', payload: { reason: 'User cancelled the conversation' } },
      ];
      store.save(current);

      const retrieved = store.getById(completed.id);
      expect(retrieved?.processEvents?.map((e) => e.type)).toEqual(['meta', 'aborted']);
    });
  });

  describe('辅助函数', () => {
    it('应该生成唯一的 Round ID', () => {
      const id1 = generateRoundId();
      const id2 = generateRoundId();

      expect(id1.startsWith('round-')).toBe(true);
      expect(id2.startsWith('round-')).toBe(true);
      expect(id1).not.toBe(id2); // 唯一
    });

    it('应该生成唯一的消息 ID', () => {
      const id1 = generateMessageId();
      const id2 = generateMessageId();

      expect(id1.startsWith('msg-')).toBe(true);
      expect(id1).not.toBe(id2);
    });

    it('应该生成正确的摘要 ID', () => {
      const roundId = 'round-abc123';
      const summaryId = generateSummaryId(roundId);

      expect(summaryId).toBe('round-summary:round-abc123');
    });

    it('应该从摘要 ID 解析 roundId', () => {
      const summaryId = 'round-summary:round-abc123';
      const roundId = parseRoundIdFromSummaryId(summaryId);

      expect(roundId).toBe('round-abc123');
    });

    it('应该拒绝无效的摘要 ID 格式', () => {
      expect(parseRoundIdFromSummaryId('invalid-format')).toBeNull();
      expect(parseRoundIdFromSummaryId('round-summary:')).toBeNull(); // 空 roundId
    });

    it('应该创建 pending Round', () => {
      const round = createPendingRound('测试消息');

      expect(round.id).toBeDefined();
      expect(round.status).toBe('pending');
      expect(round.userMessage.content).toBe('测试消息');
      expect(round.userMessage.role).toBe('user');
      expect(round.refCount).toBe(1);
      expect(round.createdAt).toBeDefined();
    });

    it('应该完成 Round', () => {
      const round = createPendingRound('用户问题');
      const completed = completeRound(round, 'AI 回答', { input: 10, output: 20 });

      expect(completed.status).toBe('complete');
      expect(completed.assistantMessage?.content).toBe('AI 回答');
      expect(completed.assistantMessage?.tokenUsage?.input).toBe(10);
      expect(completed.assistantMessage?.tokenUsage?.output).toBe(20);
      expect(completed.summaryId).toBe(`round-summary:${round.id}`);
      expect(completed.completedAt).toBeDefined();
    });
  });
});
