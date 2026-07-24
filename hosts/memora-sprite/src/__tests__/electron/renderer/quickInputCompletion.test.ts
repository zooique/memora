/**
 * 快速输入补全管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init/cleanup：事件绑定与解绑生命周期
 * - handleInput：防抖触发 / 最小字符阈值 / 短输入清空
 * - fetchCandidates：并行 IPC / 乱序取消 / 单源降级 / loading 占位
 * - mergeCandidates：记忆候选 / 对话候选（assistant 过滤）/ 去重 / 排序 / 同源多样性过滤 / Top-5 截断
 * - handleKeyDown：↓↑ 循环导航 / ←→ 填充回填
 * - renderCandidates：DOM 结构 / 点击选择 / hover 同步 / 回调通知 / UX-0714-4 候选总数 footer
 * - clearCandidates：DOM 清空 / hidden 类 / 回调通知 / footer 同步清除
 * - 采纳反馈回路：Click/←→ 采纳 boost / 多次采纳上限 / 未采纳不受影响
 * - 折叠开关（enableCollapse）：收起行渲染 / 折叠胶囊 / 折叠态保持与键盘不拦截 / 展开恢复 / 埋点不重复 / clear 重置
 *
 * Mock 策略：
 * - mock errorHelpers.reportError（避免 console 噪音）
 * - mock window.electronAPI.searchMemories/searchSessionMessages（控制返回值）
 * - JSDOM 提供真实 DOM API（createElement/click/dispatchEvent）
 * - vi.useFakeTimers 控制防抖定时器
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QuickInputCompletion } from '../../../electron/renderer/quick-input/quickInputCompletion.js';
import type { CompletionElectronAPI } from '../../../electron/renderer/quick-input/quickInputCompletion.js';
// 折叠展开重绘的埋点断言（真实模块，localStorage 在 beforeEach 清理，断言用增量对比）
import { getCompletionMetrics } from '../../../electron/renderer/helpers/completionMetrics.js';

// ─── Mock errorHelpers（reportError 依赖 UI，需 mock） ───
vi.mock('../../../electron/renderer/helpers/errorHelpers.js', () => ({
  reportError: vi.fn(),
  createIpcErrorHandler: vi.fn(() => vi.fn()),
  toError: vi.fn((err: unknown) => ({
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : 'Error',
  })),
}));

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock ElectronAPI（searchMemories + searchSessionMessages） */
function createMockApi(): CompletionElectronAPI {
  return {
    searchMemories: vi.fn().mockResolvedValue({ hits: [] }),
    searchSessionMessages: vi.fn().mockResolvedValue({ results: [] }),
  };
}

/** 创建补全管理器实例（已 init，含 input + ul DOM） */
function createCompletion(opts?: {
  input?: HTMLInputElement | HTMLTextAreaElement;
  list?: HTMLElement;
  api?: CompletionElectronAPI;
}): { completion: QuickInputCompletion; input: HTMLInputElement; list: HTMLElement; api: CompletionElectronAPI } {
  const input = opts?.input ?? document.createElement('input');
  const list = opts?.list ?? document.createElement('ul');
  const api = opts?.api ?? createMockApi();
  document.body.appendChild(input);
  document.body.appendChild(list);
  const completion = new QuickInputCompletion(input, list, api);
  completion.init();
  return { completion, input, list, api };
}

/** 模拟记忆搜索结果 */
function createMemoryHit(overrides?: Partial<{ id: string; contentPreview: string; score: number; source: string }>) {
  return {
    id: 'insight:测试记忆',
    contentPreview: '用户偏好函数式编程风格',
    score: 0.85,
    source: 'insight',
    ...overrides,
  };
}

/** 模拟对话搜索结果 */
function createMessageResult(overrides?: Partial<{ content: string; role: string }>) {
  return {
    content: '帮我看看这个 TypeScript 类型问题',
    role: 'user',
    ...overrides,
  };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  // 清理 localStorage，避免采纳记录跨测试用例污染
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── init / cleanup ─────────────────────────────────────

describe('init · 生命周期', async () => {
  it('init 后输入应触发防抖定时器', async () => {
    const { input, api } = createCompletion();
    input.value = '测试';
    input.dispatchEvent(new Event('input'));

    // 防抖定时器应存在（未触发 IPC）
    expect(api.searchMemories).not.toHaveBeenCalled();
    // 快进防抖
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchMemories).toHaveBeenCalledWith('测试');
  });

  it('cleanup 后输入不应触发补全', async () => {
    const { completion, input, api } = createCompletion();
    completion.cleanup();
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchMemories).not.toHaveBeenCalled();
  });

  it('cleanup 应清空防抖定时器', async () => {
    const { completion, input, api } = createCompletion();
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    // 防抖中 cleanup
    completion.cleanup();
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchMemories).not.toHaveBeenCalled();
  });

  it('cleanup 后 keydown 不应触发导航', async () => {
    const { completion, input, api } = createCompletion();
    // 先填充候选列表（需要真实数据）
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit()],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [],
    });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // cleanup 后按 ←→ 不应触发 onSelect
    const onSelect = vi.fn();
    completion.onSelect(onSelect);
    // 先用 ↓ 选中一项（否则 ←→ 不拦截）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    completion.cleanup();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// ─── handleInput · 防抖与阈值 ───────────────────────────

describe('handleInput · 防抖与字符阈值', async () => {
  it('输入 < 2 字符不应触发补全', async () => {
    const { input, api } = createCompletion();
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchMemories).not.toHaveBeenCalled();
  });

  it('输入 ≥ 2 字符应在防抖后触发补全', async () => {
    const { input, api } = createCompletion();
    input.value = 'ab';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchMemories).toHaveBeenCalledWith('ab');
  });

  it('连续输入应重置防抖定时器（只触发一次 IPC）', async () => {
    const { input, api } = createCompletion();
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);
    input.value = 'ab';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    // 只触发一次，用最新值
    expect(api.searchMemories).toHaveBeenCalledTimes(1);
    expect(api.searchMemories).toHaveBeenCalledWith('abc');
  });

  it('输入后清空应在防抖前取消补全', async () => {
    const { input, api } = createCompletion();
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    // 防抖中清空
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchMemories).not.toHaveBeenCalled();
  });

  it('输入应 trim 后传递给 IPC', async () => {
    const { input, api } = createCompletion();
    input.value = '  测试  ';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(api.searchMemories).toHaveBeenCalledWith('测试');
  });

  it('短输入切换到长输入应清空候选列表', async () => {
    const { input, list, api } = createCompletion();
    // 先填充候选
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit()],
    });
    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(list.classList.contains('hidden')).toBe(false);

    // 输入短字符应清空
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    expect(list.classList.contains('hidden')).toBe(true);
    expect(list.children.length).toBe(0);
  });
});

// ─── mergeCandidates · 合并去重排序 ─────────────────────

describe('mergeCandidates · 合并去重排序', async () => {
  it('记忆结果应按 source 映射中文标签并使用原 score', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '偏好函数式', score: 0.9, source: 'insight' })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [],
    });
    input.value = '偏好';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const label = document.querySelector('.completion-label');
    // L1 source 语义感知：insight → 洞察
    expect(label?.textContent).toBe('洞察');
  });

  it('对话结果应标记"对话"并过滤 assistant 回复', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        createMessageResult({ content: '用户消息', role: 'user' }),
        createMessageResult({ content: 'AI 回复', role: 'assistant' }),
      ],
    });
    input.value = '消息';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const items = document.querySelectorAll('.completion-item');
    expect(items.length).toBe(1);
    expect(items[0]!.querySelector('.completion-label')?.textContent).toBe('对话');
    expect(items[0]!.querySelector('.completion-text')?.textContent).toBe('用户消息');
  });

  it('对话 score 应基于关键词匹配位置（开头高，末尾低）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        // 关键词在开头 → score 最高（0.6）
        createMessageResult({ content: '测试开头匹配', role: 'user' }),
        // 关键词在中间 → score 中等
        createMessageResult({ content: '这是一段测试中间匹配的内容', role: 'user' }),
        // 关键词在末尾 → score 最低
        createMessageResult({ content: '这段内容把测试放在末尾', role: 'user' }),
      ],
    });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 按匹配位置排序：开头(pos=0, score=0.6) → 中间(pos=4, score≈0.52) → 末尾(pos=6, score≈0.47)
    const texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts).toEqual(['测试开头匹配', '这是一段测试中间匹配的内容', '这段内容把测试放在末尾']);
  });

  it('相同文本应去重，保留 score 较高者', async () => {
    const { input, api } = createCompletion();
    // 构造完全相同的长文本（去重 key = dedupKey(text) = text.toLowerCase()）
    const sharedText = '关于项目会议记录的详细分析和总结报告'.repeat(3); // 18×3=54 字符
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: sharedText, score: 0.95 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [createMessageResult({ content: sharedText, role: 'user' })],
    });
    input.value = '关于项目';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 完全相同文本 → 去重，只保留 score=0.95 的记忆（对话 score=0.6）
    const items = document.querySelectorAll('.completion-item');
    expect(items.length).toBe(1);
    // L1 source 语义感知：createMemoryHit 默认 source='insight' → 标签为"洞察"
    expect(items[0]!.querySelector('.completion-label')?.textContent).toBe('洞察');
  });

  it('候选应按 score 降序排序', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '低分记忆', score: 0.5 }),
        createMemoryHit({ contentPreview: '高分记忆', score: 0.95 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts[0]).toBe('高分记忆');
    expect(texts[1]).toBe('低分记忆');
  });

  it('候选应截断为 Top-5（含同源多样性过滤）', async () => {
    const { input, api } = createCompletion();
    // 4 条记忆（score 0.95-0.8）+ 4 条对话（score 0.6-0.45），覆盖两个来源
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '记忆A', score: 0.95 }),
        createMemoryHit({ contentPreview: '记忆B', score: 0.9 }),
        createMemoryHit({ contentPreview: '记忆C', score: 0.85 }),
        createMemoryHit({ contentPreview: '记忆D', score: 0.8 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        createMessageResult({ content: '对话A' }),
        createMessageResult({ content: '对话B' }),
        createMessageResult({ content: '对话C' }),
        createMessageResult({ content: '对话D' }),
      ],
    });
    input.value = '对话';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const items = document.querySelectorAll('.completion-item');
    // 同源上限 MAX_PER_SOURCE=3：记忆最多3条 + 对话最多3条 = 6条候选，取 Top-5
    expect(items.length).toBe(5);
    const texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts[0]).toBe('记忆A');
    expect(texts[1]).toBe('记忆B');
    expect(texts[2]).toBe('记忆C');
    expect(texts[3]).toBe('对话A');
    expect(texts[4]).toBe('对话B');
  });

  it('超长文本应截断并加省略号', async () => {
    const { input, api } = createCompletion();
    const longText = '这是一段非常非常长的文本'.repeat(20);
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: longText, score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '长文';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const text = document.querySelector('.completion-text')?.textContent;
    // truncate 语义：maxLen=80 为文本最大保留长度，省略号额外（总长 81）
    expect(text!.length).toBeLessThanOrEqual(81);
    expect(text!.endsWith('…')).toBe(true);
  });

  it('空 contentPreview/content 应跳过', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '', score: 0.9 }),
        createMemoryHit({ contentPreview: '   ', score: 0.8 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [createMessageResult({ content: '', role: 'user' })],
    });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 炼化归元：两源搜索返回空结果且无历史回退时，显示"无匹配"占位（状态反馈，非 bug）
    // 优先级链：匹配候选为空 → 历史回退为空（未注入 recentProvider）→ 显示占位
    expect(document.querySelectorAll('.completion-item').length).toBe(1);
    expect(document.querySelector('.completion-item.completion-empty')).not.toBeNull();
  });
});

// ─── fetchCandidates · 并行 IPC 与降级 ──────────────────

describe('fetchCandidates · 并行 IPC 与降级', async () => {
  it('应并行调用 searchMemories 和 searchSessionMessages', async () => {
    const { input, api } = createCompletion();
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(api.searchMemories).toHaveBeenCalledWith('测试');
    expect(api.searchSessionMessages).toHaveBeenCalledWith({ keyword: '测试', limit: 20 });
  });

  it('searchMemories 失败应降级为空候选（不抛错）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [createMessageResult({ content: '对话结果', role: 'user' })],
    });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 仍有对话候选
    expect(document.querySelectorAll('.completion-item').length).toBe(1);
  });

  it('searchSessionMessages 失败应降级为空候选（不抛错）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit()],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 仍有记忆候选
    expect(document.querySelectorAll('.completion-item').length).toBe(1);
  });

  it('两个 IPC 都失败应显示错误占位（非空列表）', async () => {
    const { input, api, list } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 两源全失败时显示错误占位，让用户区分"无匹配"和"搜索出错"
    expect(list.classList.contains('hidden')).toBe(false);
    expect(list.querySelector('.completion-error')).not.toBeNull();
    expect(list.querySelector('.completion-error')?.textContent).toBe('搜索失败，修改输入重试');
  });

  it('乱序响应应丢弃旧请求结果', async () => {
    const { input, api } = createCompletion();
    // 第一次请求慢，第二次请求快
    let resolveFirst: (value: unknown) => void;
    (api.searchMemories as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ hits: [createMemoryHit({ contentPreview: '第二次结果' })] });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });

    // 第一次输入
    input.value = '第一';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 第二次输入（重置防抖）
    input.value = '第二';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 第二次请求先返回
    await vi.runAllTimersAsync();

    // 第一次请求后返回（应被丢弃）
    resolveFirst!({ hits: [createMemoryHit({ contentPreview: '第一次结果' })] });
    await Promise.resolve();

    // DOM 应显示第二次的结果，不是第一次的
    const text = document.querySelector('.completion-text')?.textContent;
    expect(text).toBe('第二次结果');
  });

  it('空结果且无历史回退时显示"无匹配"占位（炼化归元：状态反馈，非 bug）', async () => {
    const { input, api, list } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 炼化归元：两源空结果 + 未注入历史回退 → 显示"无匹配"占位（保留三态反馈，避免用户误以为 bug）
    expect(list.classList.contains('hidden')).toBe(false);
    const placeholder = list.querySelector('.completion-item.completion-empty');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toBe('无匹配，换个词试试');
  });

  it('空结果但有历史回退时显示历史候选（历史第二优先级）', async () => {
    const { input, list, api, completion } = createCompletion();
    // 注入历史回退提供者，返回 2 条历史提交
    completion.onRecentFallback(() => ['历史提交A', '历史提交B']);
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 两源空结果 + 有历史回退 → 显示历史候选
    expect(list.classList.contains('hidden')).toBe(false);
    const items = list.querySelectorAll('.completion-item');
    expect(items.length).toBe(2);
    // 历史候选项 sourceLabel 为"最近"
    expect(items[0]?.querySelector('.completion-label')?.textContent).toBe('最近');
    expect(items[0]?.textContent).toContain('历史提交A');
  });

  it('空结果且历史回退排除当前查询文本（避免用户已输入的内容作为候选）', async () => {
    const { input, list, completion } = createCompletion();
    completion.onRecentFallback((query) => ['历史A', '历史B', query].filter((t) => t !== query));
    input.value = '历史A';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 当前查询"历史A"应被历史回退排除，只显示"历史B"
    const items = list.querySelectorAll('.completion-item');
    expect(items.length).toBe(1);
    expect(items[0]?.textContent).toContain('历史B');
  });

  it('空输入时立即显示历史候选（核心场景：Tab 提交后直接用方向键选择复用）', async () => {
    const { input, list, completion } = createCompletion();
    completion.onRecentFallback(() => ['最近提交1', '最近提交2', '最近提交3']);

    // 空输入触发 input 事件（模拟 Tab 提交后 resetInputForNext 的 dispatch）
    input.value = '';
    input.dispatchEvent(new Event('input'));

    // 空查询跳过防抖，立即显示历史候选（无需 advanceTimersByTimeAsync）
    expect(list.classList.contains('hidden')).toBe(false);
    const items = list.querySelectorAll('.completion-item');
    expect(items.length).toBe(3);
    expect(items[0]?.textContent).toContain('最近提交1');
    expect(items[0]?.querySelector('.completion-label')?.textContent).toBe('最近');
  });

  it('空输入且无历史时隐藏列表（首次使用，尚无提交历史）', async () => {
    const { input, list } = createCompletion();
    // 未注入 recentProvider，buildRecentCandidates 返回空数组

    input.value = '';
    input.dispatchEvent(new Event('input'));

    // 无历史可显示，隐藏列表
    expect(list.classList.contains('hidden')).toBe(true);
  });

  // ─── loading 占位（UX-0714-1） ───

  it('IPC 发出后应显示 loading 占位', async () => {
    const { input, api, list } = createCompletion();
    // 控制 IPC 不立即 resolve，让 loading 状态可观测
    let resolveMemories!: (value: unknown) => void;
    let resolveMessages!: (value: unknown) => void;
    (api.searchMemories as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => { resolveMemories = resolve; }),
    );
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => { resolveMessages = resolve; }),
    );

    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // IPC 发出后、返回前应显示 loading 占位
    expect(list.classList.contains('hidden')).toBe(false);
    const loadingEl = list.querySelector('.completion-loading');
    expect(loadingEl).toBeTruthy();
    expect(loadingEl?.textContent).toBe('搜索中…');
    expect(loadingEl?.getAttribute('aria-hidden')).toBe('true');

    // 清理：resolve Promise 避免泄漏
    resolveMemories({ hits: [] });
    resolveMessages({ results: [] });
    await vi.runAllTimersAsync();
  });

  it('IPC 返回后 loading 应被替换为真实候选', async () => {
    const { input, api, list } = createCompletion();
    let resolveMemories!: (value: unknown) => void;
    let resolveMessages!: (value: unknown) => void;
    (api.searchMemories as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => { resolveMemories = resolve; }),
    );
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => { resolveMessages = resolve; }),
    );

    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // loading 显示中
    expect(list.querySelector('.completion-loading')).toBeTruthy();

    // IPC 返回真实候选
    resolveMemories({ hits: [createMemoryHit({ contentPreview: '真实候选' })] });
    resolveMessages({ results: [] });
    await vi.runAllTimersAsync();

    // loading 被替换为真实候选
    expect(list.querySelector('.completion-loading')).toBeNull();
    expect(document.querySelectorAll('.completion-item').length).toBe(1);
    expect(document.querySelector('.completion-text')?.textContent).toBe('真实候选');
  });

  it('两个 IPC 都失败时 loading 应被错误占位替换', async () => {
    const { input, api, list } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));

    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // loading 占位被错误占位替换（错误占位复用 completion-loading 类名 + completion-error 修饰）
    const errorEl = list.querySelector('.completion-error');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.classList.contains('completion-loading')).toBe(true);
    expect(list.classList.contains('hidden')).toBe(false);
  });

  it('loading 期间键盘导航应失效', async () => {
    const { input, api } = createCompletion();
    let resolveMemories!: (value: unknown) => void;
    (api.searchMemories as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => { resolveMemories = resolve; }),
    );
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => { /* 永不 resolve，保持 loading 状态 */ }),
    );

    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // loading 期间按 ArrowDown 应无效果（candidates 为空，handleKeyDown 直接 return）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelectorAll('.completion-item.selected').length).toBe(0);

    // 清理
    resolveMemories({ hits: [] });
    await vi.runAllTimersAsync();
  });
});

// ─── 键盘导航 ────────────────────────────────────────────

describe('handleKeyDown · 键盘导航', async () => {
  it('ArrowDown 应选中下一项（循环到顶部）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '第一项', score: 0.9 }),
        createMemoryHit({ contentPreview: '第二项', score: 0.8 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 初始无选中
    expect(document.querySelector('.completion-item.selected')).toBeNull();

    // 按 ↓ 选中第一项
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelectorAll('.completion-item.selected').length).toBe(1);
    expect(document.querySelectorAll('.completion-item')[0]!.classList.contains('selected')).toBe(true);

    // 再按 ↓ 选中第二项
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelectorAll('.completion-item')[1]!.classList.contains('selected')).toBe(true);

    // 再按 ↓ 循环回第一项
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelectorAll('.completion-item')[0]!.classList.contains('selected')).toBe(true);
  });

  it('ArrowUp 应选中上一项（循环到底部）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '第一项', score: 0.9 }),
        createMemoryHit({ contentPreview: '第二项', score: 0.8 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 初始按 ↑ 应循环到最后一项
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(document.querySelectorAll('.completion-item')[1]!.classList.contains('selected')).toBe(true);

    // 再按 ↑ 选中第一项
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(document.querySelectorAll('.completion-item')[0]!.classList.contains('selected')).toBe(true);
  });

  it('←→ 应确认选中项并触发 onSelect 回调', async () => {
    const { completion, input, api } = createCompletion();
    const onSelect = vi.fn();
    completion.onSelect(onSelect);

    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '选中文本', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 选中第一项
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    // ← 填充到输入框
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ text: '选中文本' }));
  });

  it('←→ 确认后候选列表保持不变（清除由回调负责）', async () => {
    const { completion, input, api, list } = createCompletion();
    completion.onSelect(vi.fn());

    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '文本', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    // 候选列表不再自动清除（由回调负责），确认后仍保持可见
    expect(list.classList.contains('hidden')).toBe(false);
    expect(list.children.length).toBeGreaterThan(0);
  });

  it('未用 ↑↓ 导航时按 ←→ 不应触发 onSelect（保持光标移动）', async () => {
    const { completion, input, api } = createCompletion();
    const onSelect = vi.fn();
    completion.onSelect(onSelect);

    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '第一项候选', score: 0.9 }),
        createMemoryHit({ contentPreview: '第二项候选', score: 0.8 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 不按 ↓ 直接按 ←→，不应触发填充（selectedIndex 仍为 -1）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('无候选时按键不应有效果', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 无候选时按 ↓ 不应报错
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelector('.completion-item.selected')).toBeNull();
  });
});

// ─── 渲染与交互 ──────────────────────────────────────────

describe('renderCandidates · 渲染与交互', async () => {
  it('候选项应包含来源标签和文本', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '测试内容', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const item = document.querySelector('.completion-item');
    expect(item).not.toBeNull();
    // L1 source 语义感知：createMemoryHit 默认 source='insight' → 标签为"洞察"
    expect(item!.querySelector('.completion-label')?.textContent).toBe('洞察');
    expect(item!.querySelector('.completion-text')?.textContent).toBe('测试内容');
  });

  it('候选项应设置 data-index 属性', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: 'A', score: 0.9 }),
        createMemoryHit({ contentPreview: 'B', score: 0.8 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const items = document.querySelectorAll('.completion-item');
    expect(items[0]!.getAttribute('data-index')).toBe('0');
    expect(items[1]!.getAttribute('data-index')).toBe('1');
  });

  it('点击候选项应触发 onSelect 并清空列表', async () => {
    const { completion, input, api, list } = createCompletion();
    const onSelect = vi.fn();
    completion.onSelect(onSelect);

    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '点击文本', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const item = document.querySelector('.completion-item') as HTMLElement;
    item.click();

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ text: '点击文本' }));
    // 候选列表不再自动清除（由回调负责），点击后仍保持可见
    expect(list.classList.contains('hidden')).toBe(false);
  });

  it('hover 候选项应同步 selectedIndex', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '第一项', score: 0.9 }),
        createMemoryHit({ contentPreview: '第二项', score: 0.8 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // hover 第二项
    const items = document.querySelectorAll('.completion-item');
    items[1]!.dispatchEvent(new Event('mouseenter'));

    expect(items[1]!.classList.contains('selected')).toBe(true);
    expect(items[0]!.classList.contains('selected')).toBe(false);
  });

  it('候选列表显示/隐藏应触发 onListChange 回调', async () => {
    const { completion, input, api } = createCompletion();
    const onListChange = vi.fn();
    completion.onListChange(onListChange);

    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit()],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 候选显示 → onListChange(true)
    expect(onListChange).toHaveBeenCalledWith(true);

    // 清空 → onListChange(false)
    input.value = 'a';
    input.dispatchEvent(new Event('input'));
    expect(onListChange).toHaveBeenCalledWith(false);
  });

  it('textContent 应防 XSS（不渲染 HTML 标签）', async () => {
    const { input, api } = createCompletion();
    const malicious = '<img src=x onerror=alert(1)>';
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: malicious, score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const textEl = document.querySelector('.completion-text') as HTMLElement;
    expect(textEl.querySelector('img')).toBeNull();
    expect(textEl.textContent).toBe(malicious);
  });

  // ─── UX-0714-4：候选总数 footer ───

  it('UX-0714-4：候选总数 > 5 时应在列表底部显示"共 N 项"footer', async () => {
    const { input, list, api } = createCompletion();
    // 6 条记忆 + 4 条对话，去重后同源上限各保留 3 条 = 6 条，超过 MAX_CANDIDATES=5
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '候选A', score: 0.9 }),
        createMemoryHit({ contentPreview: '候选B', score: 0.85 }),
        createMemoryHit({ contentPreview: '候选C', score: 0.8 }),
        createMemoryHit({ contentPreview: '候选D', score: 0.75 }),
        createMemoryHit({ contentPreview: '候选E', score: 0.7 }),
        createMemoryHit({ contentPreview: '候选F', score: 0.65 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        createMessageResult({ content: '对话X' }),
        createMessageResult({ content: '对话Y' }),
        createMessageResult({ content: '对话Z' }),
        createMessageResult({ content: '对话W' }),
      ],
    });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // footer 存在且文案正确
    const footer = list.querySelector('.completion-footer');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toBe('共 6 项');
    // dataset.footer 标记已设置（供高度计算感知）
    expect(list.dataset.footer).toBe('true');
  });

  it('UX-0714-4：候选总数 ≤ 5 时不应显示 footer', async () => {
    const { input, list, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '候选A', score: 0.9 }),
        createMemoryHit({ contentPreview: '候选B', score: 0.85 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(list.querySelector('.completion-footer')).toBeNull();
    expect(list.dataset.footer).toBeUndefined();
  });

  it('UX-0714-4：footer 不含 .completion-item 类（不参与计数和选择）', async () => {
    const { input, list, api } = createCompletion();
    // 6 条记忆 + 4 条对话，同源上限各 3 条 = 6 条候选，5 条显示 + 1 footer
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: Array.from({ length: 6 }, (_, i) =>
        createMemoryHit({ contentPreview: `候选${i}`, score: 0.9 - i * 0.05 }),
      ),
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        createMessageResult({ content: '对话X' }),
        createMessageResult({ content: '对话Y' }),
        createMessageResult({ content: '对话Z' }),
        createMessageResult({ content: '对话W' }),
      ],
    });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // .completion-item 计数应为 5（Top-5），footer 不在其中
    const items = list.querySelectorAll('.completion-item');
    expect(items.length).toBe(5);
    // footer 独立存在
    const footer = list.querySelector('.completion-footer');
    expect(footer).not.toBeNull();
    expect(footer!.classList.contains('completion-item')).toBe(false);
    // footer 应标记 aria-hidden
    expect(footer!.getAttribute('aria-hidden')).toBe('true');
  });

  it('UX-0714-4：清空列表时 footer 和 dataset 应同步清除', async () => {
    const { input, list, api } = createCompletion();
    // 6 条记忆 + 4 条对话，同源上限各 3 条 = 6 条候选，触发 footer
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: Array.from({ length: 6 }, (_, i) =>
        createMemoryHit({ contentPreview: `候选${i}`, score: 0.9 - i * 0.05 }),
      ),
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        createMessageResult({ content: '对话X' }),
        createMessageResult({ content: '对话Y' }),
        createMessageResult({ content: '对话Z' }),
        createMessageResult({ content: '对话W' }),
      ],
    });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 确认 footer 存在
    expect(list.querySelector('.completion-footer')).not.toBeNull();
    expect(list.dataset.footer).toBe('true');

    // 输入短于 2 字符触发清空
    input.value = 'a';
    input.dispatchEvent(new Event('input'));

    // footer 和 dataset 都应被清除
    expect(list.querySelector('.completion-footer')).toBeNull();
    expect(list.dataset.footer).toBeUndefined();
  });
});

// ─── L1 source 语义感知 ─────────────────────

describe('L1 source 语义感知', async () => {
  it('insight source 应映射为"洞察"标签', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '洞察内容', source: 'insight' })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '洞察';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const label = document.querySelector('.completion-label');
    expect(label?.textContent).toBe('洞察');
  });

  it('profile source 应映射为"偏好"标签', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '偏好内容', source: 'profile' })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '偏好';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const label = document.querySelector('.completion-label');
    expect(label?.textContent).toBe('偏好');
  });

  it('work-projection source 应映射为"作品"标签', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '作品内容', source: 'work-projection' })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '作品';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const label = document.querySelector('.completion-label');
    expect(label?.textContent).toBe('作品');
  });

  it('未知 source 应降级为"记忆"标签（向后兼容）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '自定义来源', source: 'custom-source' })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '自定义';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const label = document.querySelector('.completion-label');
    expect(label?.textContent).toBe('记忆');
  });

  it('persona/rule/skill/guardrail source 应被排除（不参与补全候选）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '角色配置', source: 'persona' }),
        createMemoryHit({ contentPreview: '创作规则', source: 'rule' }),
        createMemoryHit({ contentPreview: '技能定义', source: 'skill' }),
        createMemoryHit({ contentPreview: '护栏规则', source: 'guardrail' }),
        createMemoryHit({ contentPreview: '有效洞察', source: 'insight' }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const labels = Array.from(document.querySelectorAll('.completion-label')).map((el) => el.textContent);
    // 仅保留 insight（洞察），排除 persona/rule/skill/guardrail
    expect(labels).toEqual(['洞察']);
  });

  it('多源多样性过滤应区分洞察/偏好/投影/对话（非二分记忆/对话）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '洞察A', score: 0.95, source: 'insight' }),
        createMemoryHit({ contentPreview: '洞察B', score: 0.9, source: 'insight' }),
        createMemoryHit({ contentPreview: '洞察C', score: 0.85, source: 'insight' }),
        createMemoryHit({ contentPreview: '偏好A', score: 0.8, source: 'profile' }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const labels = Array.from(document.querySelectorAll('.completion-label')).map((el) => el.textContent);
    // MAX_PER_SOURCE=3，洞察 3 条 + 偏好 1 条 = 4 条（多样性过滤基于细分 sourceLabel）
    expect(labels).toEqual(['洞察', '洞察', '洞察', '偏好']);
  });
});

// ─── 采纳反馈回路 ───────────────────────────────────────

describe('采纳反馈回路', async () => {
  it('Click 采纳后再次补全，被采纳的候选项应获得 score boost 排序上升', async () => {
    const { input, api } = createCompletion();
    // 记忆 A score=0.6（低分），记忆 B score=0.65（高分），第一次 B 排前面
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '低分记忆A', score: 0.6 }),
        createMemoryHit({ contentPreview: '高分记忆B', score: 0.65 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });

    // 第一次补全
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 验证初始顺序：B（0.65）排在 A（0.6）前面
    let texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts).toEqual(['高分记忆B', '低分记忆A']);

    // Click 采纳第二项（低分记忆A）
    const items = document.querySelectorAll('.completion-item');
    (items[1] as HTMLElement).click();

    // 再次触发补全（重置输入触发新一轮）
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // A 的 score = 0.6 + 0.1（boost）= 0.7 > B 的 0.65，A 排到前面
    texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts).toEqual(['低分记忆A', '高分记忆B']);
  });

  it('←→ 采纳后再次补全，被采纳的候选项应获得 score boost', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '低分记忆A', score: 0.6 }),
        createMemoryHit({ contentPreview: '高分记忆B', score: 0.65 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });

    // 第一次补全
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // ArrowDown 两次选中第二项（初始 -1 → 0 → 1），→ 填充采纳
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    // 再次触发补全
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // A 的 score = 0.6 + 0.1 = 0.7 > B 的 0.65
    const texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts).toEqual(['低分记忆A', '高分记忆B']);
  });

  it('多次采纳同一候选项，boost 上限为 +0.3（3 次后不再增加）', async () => {
    const { input, api } = createCompletion();
    // 差距 0.35，需要 4 次 boost（+0.4）才能超过，但上限 +0.3 无法超过
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '低分记忆A', score: 0.3 }),
        createMemoryHit({ contentPreview: '高分记忆B', score: 0.65 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });

    // 采纳 A 共 4 次（每次需要重新触发补全 + click）
    for (let i = 0; i < 4; i++) {
      input.value = '记忆';
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(300);

      const items = document.querySelectorAll('.completion-item');
      // A 始终在第二项（boost 不超过 +0.3，即 0.6 < 0.65）
      (items[1] as HTMLElement).click();
    }

    // 第 5 次补全验证：A 的 score = 0.3 + 0.3 = 0.6 < B 的 0.65，B 仍排前面
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts).toEqual(['高分记忆B', '低分记忆A']);
  });

  it('未被采纳的候选项 score 不受 boost 影响', async () => {
    const { input, api } = createCompletion();
    // A score=0.6（低分），B score=0.65（高分），第一次 B 排前面
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '低分记忆A', score: 0.6 }),
        createMemoryHit({ contentPreview: '高分记忆B', score: 0.65 }),
      ],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });

    // 第一次补全
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // Click 采纳第二项（A，低分）—— 如果 B 也被错误 boost，B 仍会在 A 前面
    const items = document.querySelectorAll('.completion-item');
    (items[1] as HTMLElement).click();

    // 再次补全
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // A 被 boost（0.6 + 0.1 = 0.7）> B（0.65，未被 boost）
    // A 排到前面证明 B 的 score 没有被错误提升
    const texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts).toEqual(['低分记忆A', '高分记忆B']);
  });

  it('COMP-0714-D2：采纳记录应通过 localStorage 跨会话持久化', async () => {
    // 第一阶段：实例 A 采纳候选项"低分记忆A"
    const { input: inputA, api: apiA, completion: completionA } = createCompletion();
    (apiA.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '低分记忆A', score: 0.6 }),
        createMemoryHit({ contentPreview: '高分记忆B', score: 0.65 }),
      ],
    });
    (apiA.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    inputA.value = '记忆';
    inputA.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // Click 采纳第二项（低分记忆A）
    const items = document.querySelectorAll('.completion-item');
    (items[1] as HTMLElement).click();
    completionA.cleanup();

    // 第二阶段：新建实例 B（模拟窗口重开后），验证采纳记录已从 localStorage 恢复
    document.body.innerHTML = '';
    const { input: inputB, api: apiB } = createCompletion();
    (apiB.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [
        createMemoryHit({ contentPreview: '低分记忆A', score: 0.6 }),
        createMemoryHit({ contentPreview: '高分记忆B', score: 0.65 }),
      ],
    });
    (apiB.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    inputB.value = '记忆';
    inputB.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 低分记忆A 应获得 boost（0.6 + 0.1 = 0.7 > 0.65），排在前面
    const texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts).toEqual(['低分记忆A', '高分记忆B']);
  });
});

// ─── textarea 支持 ───────────────────────────────────────

describe('textarea 支持', async () => {
  it('应支持 HTMLTextAreaElement 作为补全目标', async () => {
    const textarea = document.createElement('textarea');
    const { completion, api } = createCompletion({ input: textarea });
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit()],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    textarea.value = '测试';
    textarea.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(api.searchMemories).toHaveBeenCalledWith('测试');
    expect(document.querySelectorAll('.completion-item').length).toBe(1);

    completion.cleanup();
  });
});

// ─── UX-QI-05 候选文本高亮匹配关键词 ─────────────────────

describe('UX-QI-05 候选文本高亮匹配关键词', async () => {
  it('候选文本中匹配 query 的部分应用 <mark> 包裹', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '今天会议纪要', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '会议';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 匹配段 "会议" 应用 <mark class="completion-match"> 包裹
    const mark = document.querySelector('.completion-text mark.completion-match');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('会议');
  });

  it('大小写不敏感匹配但保留原文大小写', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: 'Meeting Notes', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = 'meeting';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 匹配段保留原文大小写 "Meeting"
    const mark = document.querySelector('.completion-text mark.completion-match');
    expect(mark?.textContent).toBe('Meeting');
  });

  it('候选文本不直接包含 query 时降级为纯文本（无 mark）', async () => {
    const { input, api } = createCompletion();
    // 语义搜索可能返回不直接包含 query 的候选
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '完全不相关的文本', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '会议';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 无匹配段时不应用 <mark>
    const mark = document.querySelector('.completion-text mark.completion-match');
    expect(mark).toBeNull();
    // 文本仍正常渲染
    expect(document.querySelector('.completion-text')?.textContent).toBe('完全不相关的文本');
  });
});

// ─── UX-QI-06 已采纳候选加 ★ 常用标记 ────────────────────

describe('UX-QI-06 已采纳候选加 ★ 常用标记', async () => {
  it('未采纳过的候选项无 ★ 标记', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '新候选', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '候选';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 未采纳过的候选项无 .adopted 类、无 ★ 标记
    const item = document.querySelector('.completion-item');
    expect(item?.classList.contains('adopted')).toBe(false);
    expect(item?.querySelector('.completion-adopted-mark')).toBeNull();
  });

  it('采纳过的候选项再次出现时显示 ★ 标记和 title', async () => {
    const { input, api, completion } = createCompletion();
    const memoryHit = createMemoryHit({ contentPreview: '常用签名', score: 0.9 });
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [memoryHit],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });

    // 第一次触发补全
    input.value = '签名';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 第一次出现时无 ★ 标记
    expect(document.querySelector('.completion-item.adopted')).toBeNull();

    // 模拟用户采纳（点击候选项触发 recordAdoption）
    const item = document.querySelector('.completion-item') as HTMLElement;
    item.click();

    // 清空后再次触发补全（模拟用户继续输入，需 ≥2 字符触发补全）
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [memoryHit],
    });
    input.value = '签名';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 第二次出现时应有 .adopted 类 + ★ 标记 + title 提示
    const adoptedItem = document.querySelector('.completion-item.adopted');
    expect(adoptedItem).not.toBeNull();
    expect(adoptedItem?.querySelector('.completion-adopted-mark')?.textContent).toBe('★');
    expect(adoptedItem?.getAttribute('title')).toContain('已采纳 1 次');

    completion.cleanup();
  });
});

// ─── 折叠开关（enableCollapse，主对话防遮挡） ──────────────

describe('collapse · 折叠开关', async () => {
  /**
   * 创建启用折叠的补全实例并渲染出候选列表
   *
   * @param candidateCount 候选条数（默认 2 条记忆候选）
   * @returns 补全上下文（completion/input/list/api）
   */
  async function createCollapsibleContext(candidateCount = 2) {
    const api = createMockApi();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: Array.from({ length: candidateCount }, (_, i) =>
        createMemoryHit({ id: `insight:候选${i}`, contentPreview: `候选内容${i}`, score: 0.9 - i * 0.1 }),
      ),
    });
    const ctx = createCompletion({ api });
    ctx.completion.enableCollapse();
    ctx.input.value = '测试';
    ctx.input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    return ctx;
  }

  it('未启用折叠（默认）时不渲染收起行（quick-input 浮窗回归守卫）', async () => {
    const { input, list, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '候选内容' })],
    });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(list.querySelector('.completion-collapse-toggle')).toBeNull();
    expect(list.querySelectorAll('.completion-item').length).toBe(1);
  });

  it('启用后候选列表顶部应渲染收起行（不参与候选计数）', async () => {
    const { list } = await createCollapsibleContext(2);
    const toggle = list.querySelector<HTMLButtonElement>('.completion-collapse-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle!.textContent).toContain('收起候选');
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    // 收起行不带 .completion-item 类，不参与候选计数
    expect(list.querySelectorAll('.completion-item').length).toBe(2);
    expect(list.classList.contains('collapsed')).toBe(false);
  });

  it('点击收起应折叠为胶囊：候选隐藏 + aria 收缩 + 焦点归还输入框', async () => {
    const { input, list } = await createCollapsibleContext(2);
    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle')!.click();

    expect(list.classList.contains('collapsed')).toBe(true);
    expect(list.querySelectorAll('.completion-item').length).toBe(0);
    const pill = list.querySelector<HTMLButtonElement>('.completion-collapse-toggle.is-collapsed');
    expect(pill).toBeTruthy();
    expect(pill!.textContent).toContain('2 项候选');
    expect(pill!.getAttribute('aria-expanded')).toBe('false');
    // 折叠语义 = 列表未展开
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-activedescendant')).toBe('');
    // 焦点归还输入框（可继续输入）
    expect(document.activeElement).toBe(input);
  });

  it('折叠态继续输入应保持折叠并刷新计数（不自动展开）', async () => {
    const { input, list, api } = await createCollapsibleContext(2);
    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle')!.click();

    // 继续输入触发新搜索（新结果 1 条候选）
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ id: 'insight:新候选', contentPreview: '新候选内容', score: 0.9 })],
    });
    input.value = '测试2';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(list.classList.contains('collapsed')).toBe(true);
    expect(list.querySelector('.completion-collapse-toggle')?.textContent).toContain('1 项候选');
  });

  it('折叠态不应拦截 ↓↑ 按键（恢复光标移动语义）', async () => {
    const { input, list } = await createCollapsibleContext(2);
    // 展开态对照：↓ 被拦截（preventDefault 用于候选导航）
    const expandedEvt = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    input.dispatchEvent(expandedEvt);
    expect(expandedEvt.defaultPrevented).toBe(true);

    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle')!.click();

    const collapsedEvt = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    input.dispatchEvent(collapsedEvt);
    expect(collapsedEvt.defaultPrevented).toBe(false);
    expect(list.querySelectorAll('.completion-item.selected').length).toBe(0);
  });

  it('点击胶囊应展开恢复候选列表，且不重复记录展示埋点', async () => {
    const { input, list } = await createCollapsibleContext(2);
    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle')!.click();

    const shownBefore = getCompletionMetrics().getAggregated().totalShown;
    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle.is-collapsed')!.click();

    expect(list.classList.contains('collapsed')).toBe(false);
    expect(list.querySelectorAll('.completion-item').length).toBe(2);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // 展开重绘非新搜索展示，展示事件数不应增加
    expect(getCompletionMetrics().getAggregated().totalShown).toBe(shownBefore);
  });

  it('clear() 后折叠态应重置：下次渲染恢复展开', async () => {
    const { completion, input, list } = await createCollapsibleContext(2);
    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle')!.click();
    expect(list.classList.contains('collapsed')).toBe(true);

    completion.clear();
    expect(list.classList.contains('hidden')).toBe(true);
    expect(list.classList.contains('collapsed')).toBe(false);

    // 再次触发补全，应恢复展开态（含收起行 + 候选项）
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(list.classList.contains('collapsed')).toBe(false);
    expect(list.querySelectorAll('.completion-item').length).toBe(2);
  });

  it('折叠态占位状态（无匹配）不展开列表，胶囊降级为「候选已收起」', async () => {
    const { input, list, api } = await createCollapsibleContext(2);
    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle')!.click();

    // 新查询两源均无匹配（recentProvider 未注入，无历史回退）
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    input.value = '无匹配词';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(list.classList.contains('collapsed')).toBe(true);
    expect(list.querySelector('.completion-item')).toBeNull();
    expect(list.querySelector('.completion-collapse-toggle')?.textContent).toContain('候选已收起');
  });

  it('折叠期间查询变为无匹配后展开，应呈现「无匹配」占位而非空列表', async () => {
    const { input, list, api } = await createCollapsibleContext(2);
    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle')!.click();

    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    input.value = '无匹配词';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);
    expect(list.classList.contains('collapsed')).toBe(true);

    // 展开：candidates 已被占位流程清空，应路由到无匹配占位
    list.querySelector<HTMLButtonElement>('.completion-collapse-toggle.is-collapsed')!.click();
    expect(list.classList.contains('collapsed')).toBe(false);
    expect(list.querySelector('.completion-empty')?.textContent).toBe('无匹配，换个词试试');
  });
});
