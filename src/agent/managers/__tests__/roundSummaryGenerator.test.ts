/**
 * RoundSummaryGenerator 单元测试 — 轮次摘要生成 + 写路径取代检测
 *
 * 覆盖点：
 *   1. 生成 round-summary 记忆（含 type 分类）
 *   2. 写路径取代检测：同 session 同主题旧摘要被标记 supersededBy
 *   3. 不同 session / 不同主题不误取代
 *   4. 已 superseded 的旧摘要不再被重复标记
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SOURCE_LABELS, roundSummaryMemoryId } from '@/memory/types.js';
import type { SummaryType } from '@/memory/types.js';
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
  type: SummaryType,
): void {
  const now = new Date().toISOString();
  storage.upsert({
    id: roundSummaryMemoryId(sessionName, roundId),
    content,
    source: SOURCE_LABELS.ROUND_SUMMARY,
    name: `轮次摘要 ${sessionName} ${roundId}`,
    createdAt: now,
    accessedAt: now,
    summaryType: type,
    sessionName,
    roundId,
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
    expect(all[0]!.summaryType).toBe('preference');
    expect(all[0]!.source).toBe(SOURCE_LABELS.ROUND_SUMMARY);
  });

  it('focus 存在时系统 prompt 以角色包提炼视角替换通用视角，且保留 JSON 契约', async () => {
    // 捕获传给 LLM 的 system content，验证角色包提炼视角已注入、JSON 硬契约保留
    const focus = '以代码视角判断值得记的维度与代码片段保留';
    let systemContent = '';
    const provider = {
      name: 'mock-provider',
      chat: async function* (messages: { role: string; content: string }[]) {
        systemContent = messages[0]!.content;
        yield { content: JSON.stringify({ summary: '摘要', type: 'fact' }) };
      },
    } as unknown as LlmProvider;
    const gen = new RoundSummaryGenerator(provider, storage);
    await gen.generate('输入', '回复', 'round-1', 'session-a', focus);
    // 提炼视角全文被替换注入
    expect(systemContent).toContain(focus);
    expect(systemContent).toContain('角色包提炼视角');
    // 通用归纳框架不应叠加残留（完整下沉=替换，非追加）
    expect(systemContent).not.toContain('摘要应包含：');
    // JSON 硬契约（SummaryType 分类）固定保留，保证写路径 summaryType 稳定
    expect(systemContent).toContain('请以 JSON 格式输出');
    expect(systemContent).toContain('preference|fact|decision|intent|general');
  });

  it('focus 缺省时系统 prompt 不含提炼视角段（零增量默认）', async () => {
    let systemContent = '';
    const provider = {
      name: 'mock-provider',
      chat: async function* (messages: { role: string; content: string }[]) {
        systemContent = messages[0]!.content;
        yield { content: JSON.stringify({ summary: '摘要', type: 'fact' }) };
      },
    } as unknown as LlmProvider;
    const gen = new RoundSummaryGenerator(provider, storage);
    await gen.generate('输入', '回复', 'round-2', 'session-a');
    expect(systemContent).not.toContain('角色包提炼视角');
    expect(systemContent).toContain('摘要应包含：');
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
    expect(storage.getById('round-summary:session-a:r1')?.supersededBy).toBe(
      'round-summary:session-a:r2',
    );
  });

  it('取代检测候选窗口收敛：超出最近 N 条（SUPERSEDE_CANDIDATE_WINDOW）的旧摘要不被取代', async () => {
    // 预置 21 条同 session 同主题摘要（窗口 20），每个 roundId 错开 createdAt（倒序取最近 20 条可确定）
    const window = 20;
    for (let i = 1; i <= window + 1; i++) {
      seedSummary(storage, 'session-a', `r${i}`, '用户偏好深色主题界面的简洁风格', 'preference');
      // 重写 createdAt 递增：r1 最旧 … r21 最新（确定性排序）
      storage.upsert({
        ...storage.getById(`round-summary:session-a:r${i}`)!,
        createdAt: `2020-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }

    // 生成新同主题摘要 r-new：窗口取最近 20 条（r2..r21 按 createdAt 降序），最旧 r1 应不被取代
    const gen = new RoundSummaryGenerator(
      makeProvider('用户偏好深色主题的极简现代界面', 'preference'),
      storage,
    );
    await gen.generate('用户输入', '助手回复', 'r-new', 'session-a');

    // 超出窗口的最旧同主题 r1 不被取代（候选窗口只覆盖最近 N 条）
    expect(storage.getById('round-summary:session-a:r1')?.supersededBy).toBeUndefined();
    // 窗口内最近的同主题 r2 被取代（验证收敛仍保留最近取代语义）
    expect(storage.getById('round-summary:session-a:r2')?.supersededBy).toBe(
      'round-summary:session-a:r-new',
    );
  });
});
