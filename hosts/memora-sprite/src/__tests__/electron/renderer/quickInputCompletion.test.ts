/**
 * 快速输入补全管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init/cleanup：事件绑定与解绑生命周期
 * - handleInput：防抖触发 / 最小字符阈值 / 短输入清空
 * - fetchCandidates：并行 IPC / 乱序取消 / 单源降级 / loading 占位
 * - mergeCandidates：记忆候选 / 对话候选（assistant 过滤）/ 去重 / 排序 / Top-5 截断
 * - handleKeyDown：↓↑ 循环导航 / ←→ 填充回填
 * - renderCandidates：DOM 结构 / 点击选择 / hover 同步 / 回调通知 / UX-0714-4 候选总数 footer
 * - clearCandidates：DOM 清空 / hidden 类 / 回调通知 / footer 同步清除
 * - 采纳反馈回路：Click/←→ 采纳 boost / 多次采纳上限 / 未采纳不受影响
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
function createMemoryHit(overrides?: Partial<{ contentPreview: string; score: number; source: string }>) {
  return {
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
  it('记忆结果应标记"记忆"并使用原 score', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: '偏好函数式', score: 0.9 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [],
    });
    input.value = '偏好';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const label = document.querySelector('.completion-label');
    expect(label?.textContent).toBe('记忆');
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

  it('对话 score 应按顺序递减（0.6 → 0.55 → ...）', async () => {
    const { input, api } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        createMessageResult({ content: '第一条消息', role: 'user' }),
        createMessageResult({ content: '第二条消息', role: 'user' }),
        createMessageResult({ content: '第三条消息', role: 'user' }),
      ],
    });
    input.value = '条消息';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 按 DOM 顺序验证排序（score 降序 = 输入顺序）
    const texts = Array.from(document.querySelectorAll('.completion-text')).map((el) => el.textContent);
    expect(texts).toEqual(['第一条消息', '第二条消息', '第三条消息']);
  });

  it('相同前缀文本应去重，保留 score 较高者', async () => {
    const { input, api } = createCompletion();
    // 构造前 40 字符完全相同的长文本（去重 key = text.slice(0,40).toLowerCase()）
    const sharedPrefix = '关于项目会议记录的详细分析和总结报告'.repeat(3); // 18×3=54 字符 > 40
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: [createMemoryHit({ contentPreview: sharedPrefix + '记忆扩展', score: 0.95 })],
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [createMessageResult({ content: sharedPrefix + '对话扩展', role: 'user' })],
    });
    input.value = '关于项目';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 前 40 字符相同 → 去重，只保留 score=0.95 的记忆（对话 score=0.6）
    const items = document.querySelectorAll('.completion-item');
    expect(items.length).toBe(1);
    expect(items[0]!.querySelector('.completion-label')?.textContent).toBe('记忆');
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

  it('候选应截断为 Top-5', async () => {
    const { input, api } = createCompletion();
    // 6 条不同前缀的记忆（避免去重）
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: Array.from({ length: 6 }, (_, i) =>
        createMemoryHit({ contentPreview: `记忆${i}号唯一前缀`, score: 0.8 - i * 0.05 }),
      ),
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '记忆';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    const items = document.querySelectorAll('.completion-item');
    expect(items.length).toBe(5);
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
    expect(text!.length).toBeLessThanOrEqual(80);
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

    expect(document.querySelectorAll('.completion-item').length).toBe(0);
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

  it('两个 IPC 都失败应显示空候选列表', async () => {
    const { input, api, list } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    expect(list.classList.contains('hidden')).toBe(true);
    expect(list.children.length).toBe(0);
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

  it('空结果应隐藏候选列表', async () => {
    const { input, api, list } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

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
    expect(loadingEl?.textContent).toBe('搜索中...');
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

  it('两个 IPC 都失败时 loading 应被清除', async () => {
    const { input, api, list } = createCompletion();
    (api.searchMemories as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));

    input.value = '测试';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(300);

    // 两个 IPC 都失败，loading 被清除，列表隐藏
    expect(list.querySelector('.completion-loading')).toBeNull();
    expect(list.classList.contains('hidden')).toBe(true);
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

    expect(onSelect).toHaveBeenCalledWith('选中文本');
  });

  it('←→ 确认后应清空候选列表', async () => {
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

    expect(list.classList.contains('hidden')).toBe(true);
    expect(list.children.length).toBe(0);
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
    expect(item!.querySelector('.completion-label')?.textContent).toBe('记忆');
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

    expect(onSelect).toHaveBeenCalledWith('点击文本');
    expect(list.classList.contains('hidden')).toBe(true);
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
    // 6 条不同内容的记忆候选，去重后仍为 6 条，超过 MAX_CANDIDATES=5
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
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
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
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: Array.from({ length: 8 }, (_, i) =>
        createMemoryHit({ contentPreview: `候选${i}`, score: 0.9 - i * 0.05 }),
      ),
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
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
    (api.searchMemories as ReturnType<typeof vi.fn>).mockResolvedValue({
      hits: Array.from({ length: 8 }, (_, i) =>
        createMemoryHit({ contentPreview: `候选${i}`, score: 0.9 - i * 0.05 }),
      ),
    });
    (api.searchSessionMessages as ReturnType<typeof vi.fn>).mockResolvedValue({ results: [] });
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
