/**
 * RoundSummaryGenerator 单元测试 — 轮次摘要生成 + 写路径取代检测（ADR-021）
 *
 * 覆盖点：
 *   1. 生成 round-summary 记忆（含 type 分类）
 *   2. 写路径取代检测：同 session 同主题旧摘要被标记 supersededBy
 *   3. 不同 session / 不同主题不误取代
 *   4. 已 superseded 的旧摘要不再被重复标记
 *   5. recall() 读时过滤 superseded 摘要
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { recall } from '@/memory/recall.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { LlmProvider } from '@/llm/provider.js';

/** 造一个 mock provider：chat 产出固定 JSON 摘要 */
function makeProvider(summary: string, type: string): LlmProvider {
  const content = JSON.stringify({ summary, type });
  return {
    name: 'mock-provider',
    chat: async function* () {
      yield { content };
    },
  } as unknown as LlmProvider;
}

/** 预置一条 round-summary 记忆 */
function seedSummary(
  storage: InMemoryStorage,
  sessionName: string,
  roundId: string,
  content: string,
  type: string,
): void {
  const now = new Date().toISOString();
  storage.upsert({
    id: `round-summary:${sessionName}:${roundId}`,
    content,
    source: SOURCE_LABELS.ROUND_SUMMARY,
    name: `轮次摘要 ${sessionName} ${roundId}`,
    createdAt: now,
    accessedAt: now,
    score: 0.5,
    isTraceable: true,
    metadata: { summaryType: type, sessionName, roundId },
  });
}

describe('RoundSummaryGenerator', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it('生成 round-summary 记忆（含 type 分类）', async () => {
    const gen = new RoundSummaryGenerator(makeProvider('用户偏好简洁 UI', 'preference'), storage);
    await gen.generate('用户输入', '助手回复', 'round-1', 'session-a');

    const all = storage.getBySource(SOURCE_LABELS.ROUND_SUMMARY);
    expect(all).toHaveLength(1);
    expect(all[0]!.metadata?.summaryType).toBe('preference');
    expect(all[0]!.source).toBe(SOURCE_LABELS.ROUND_SUMMARY);
  });

  it('写路径取代：同 session 同主题旧摘要被标记 supersededBy', async () => {
    // 预置旧摘要：同 session、同主题（"深色主题 + 简洁"）
    seedSummary(storage, 'session-a', 'r1', '用户偏好深色主题界面的简洁风格', 'preference');
    // 新摘要：同 session、同主题、更明确的表述 → 判定覆盖
    const gen = new RoundSummaryGenerator(
      makeProvider('用户偏好深色主题的极简界面', 'preference'),
      storage,
    );
    await gen.generate('用户输入', '助手回复', 'r2', 'session-a');

    const old = storage.getById('round-summary:session-a:r1');
    // 旧摘要被取代，指向新摘要（非删除）
    expect(old?.supersededBy).toBe('round-summary:session-a:r2');
    // 新摘要自身不被标记
    expect(storage.getById('round-summary:session-a:r2')?.supersededBy).toBeUndefined();
  });

  it('不同 session 的同主题摘要不被误取代', async () => {
    seedSummary(storage, 'session-b', 'r1', '用户偏好深色主题界面的简洁风格', 'preference');
    const gen = new RoundSummaryGenerator(
      makeProvider('用户偏好深色主题的极简界面', 'preference'),
      storage,
    );
    await gen.generate('用户输入', '助手回复', 'r2', 'session-a');

    // session-b 的摘要不受 session-a 新摘要影响
    expect(storage.getById('round-summary:session-b:r1')?.supersededBy).toBeUndefined();
  });

  it('不同主题（关键词不重叠）的摘要不被误取代', async () => {
    seedSummary(storage, 'session-a', 'r1', '用户偏好咖啡与手冲器具', 'preference');
    const gen = new RoundSummaryGenerator(
      makeProvider('用户偏好深色主题的极简界面', 'preference'),
      storage,
    );
    await gen.generate('用户输入', '助手回复', 'r2', 'session-a');

    expect(storage.getById('round-summary:session-a:r1')?.supersededBy).toBeUndefined();
  });

  it('已 superseded 的旧摘要不会被重复标记', async () => {
    // 预置两条：r1 已被 r2 取代
    seedSummary(storage, 'session-a', 'r1', '用户偏好深色主题界面的简洁风格', 'preference');
    seedSummary(storage, 'session-a', 'r2', '用户偏好深色主题的极简界面', 'preference');
    storage.upsert({
      ...storage.getById('round-summary:session-a:r1')!,
      supersededBy: 'round-summary:session-a:r2',
    });

    // 更新更明确的 r3，仍判定覆盖 r1
    const gen = new RoundSummaryGenerator(
      makeProvider('用户偏好深色主题的极简现代界面', 'preference'),
      storage,
    );
    await gen.generate('用户输入', '助手回复', 'r3', 'session-a');

    // r1 已 superseded，不再被 r3 覆盖（保持指向 r2）
    expect(storage.getById('round-summary:session-a:r1')?.supersededBy).toBe('round-summary:session-a:r2');
  });

  it('recall() 读时过滤被 superseded 的摘要', async () => {
    // 两条同主题摘要，r1 被 r2 取代
    seedSummary(storage, 'session-a', 'r1', '用户偏好深色主题界面的简洁风格', 'preference');
    seedSummary(storage, 'session-a', 'r2', '用户偏好深色主题的极简界面', 'preference');
    storage.upsert({
      ...storage.getById('round-summary:session-a:r1')!,
      supersededBy: 'round-summary:session-a:r2',
    });

    const result = await recall(storage, '深色主题 偏好', {
      excludeSources: [SOURCE_LABELS.PERSONA, SOURCE_LABELS.RULE, SOURCE_LABELS.SKILL],
    });

    // 被取代的 r1 不作为当前事实注入
    expect(result.some((m) => m.id === 'round-summary:session-a:r1')).toBe(false);
    // 新 r2 仍被召回
    expect(result.some((m) => m.id === 'round-summary:session-a:r2')).toBe(true);
  });
});