/**
 * 配置建议与用户画像 IPC 处理器测试
 *
 * 覆盖范围：
 * - SUGGESTION_ACCEPT：接受配置建议 + 输入验证（非法名/超大内容）+ config=null 降级 + 成功
 * - SUGGESTION_REJECT：拒绝配置建议（仅记录日志）
 * - USER_PROFILE_LIST：列出画像 + profile=null 降级 + 合并 confirmed+pending
 * - USER_PROFILE_CONFIRM：确认画像 + profile=null 降级 + 成功
 * - USER_PROFILE_REJECT：拒绝画像 + profile=null 降级 + 成功
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks Map
 * - IpcContext.agent.config：mock confirmConfigSuggestion
 * - IpcContext.agent.userProfile：mock getConfirmed/getPending/confirm/reject
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock electron 模块 ──────────────────────────────────
const handleCallbacks = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, callback: (...args: unknown[]) => unknown) => {
      handleCallbacks.set(channel, callback);
    }),
    removeHandler: vi.fn((channel: string) => {
      handleCallbacks.delete(channel);
    }),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

import { registerSuggestionHandlers } from '../../../electron/ipc/suggestionHandlers.js';
import { IPC_CHANNELS } from '../../../electron/ipc/channels.js';
import type { IpcContext } from '../../../electron/ipc/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建合法建议对象 */
function createValidSuggestion() {
  return {
    type: 'rule' as const,
    name: 'code-review',
    content: '代码审查规则内容',
    confidence: 0.9,
    source: 'auto-refiner',
  };
}

/** 创建 mock IpcContext（null 保留：用于测试 manager 未就绪降级路径） */
function createMockCtx(overrides?: {
  config?: { confirmConfigSuggestion: ReturnType<typeof vi.fn> } | null;
  userProfile?: {
    getConfirmed: ReturnType<typeof vi.fn>;
    getPending: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
  } | null;
}): IpcContext {
  // null 保留判断：?? 会把 null 替换为默认值，需用 !== undefined 判断
  const config = overrides?.config !== undefined ? overrides.config : { confirmConfigSuggestion: vi.fn(async () => {}) };
  const userProfile = overrides?.userProfile !== undefined ? overrides.userProfile : {
    getConfirmed: vi.fn(() => []),
    getPending: vi.fn(() => []),
    confirm: vi.fn(async () => {}),
    reject: vi.fn(async () => {}),
  };
  return {
    // FIX-P1-7/FIX-P1-1：agent/sprite/sessionStore 改为函数式 getter，匹配 IpcContext 接口改造
    getAgent: () => ({
      config,
      userProfile,
    }) as unknown as ReturnType<IpcContext['getAgent']>,
    getSprite: () => ({}) as ReturnType<IpcContext['getSprite']>,
    getSessionStore: () => ({}) as ReturnType<IpcContext['getSessionStore']>,
    windowManager: {} as IpcContext['windowManager'],
    trayManager: null,
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: vi.fn(() => true),
    getUnreadCount: vi.fn(() => 0),
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('registerSuggestionHandlers', () => {
  beforeEach(() => {
    handleCallbacks.clear();
    vi.clearAllMocks();
  });

  // ─── SUGGESTION_ACCEPT ─────────────────────────────────

  it('合法建议应调用 confirmConfigSuggestion 并返回成功', async () => {
    const confirmConfigSuggestion = vi.fn(async () => {});
    const ctx = createMockCtx({ config: { confirmConfigSuggestion } });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.SUGGESTION_ACCEPT)!;
    const result = await callback({}, createValidSuggestion());

    expect(confirmConfigSuggestion).toHaveBeenCalledWith(createValidSuggestion());
    expect(result).toEqual({ success: true });
  });

  it('含路径分隔符的配置名应拒绝（防路径遍历）', async () => {
    const confirmConfigSuggestion = vi.fn();
    const ctx = createMockCtx({ config: { confirmConfigSuggestion } });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.SUGGESTION_ACCEPT)!;
    const result = await callback({}, { ...createValidSuggestion(), name: '../etc/passwd' });

    expect(confirmConfigSuggestion).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: '无效的配置名称' });
  });

  it('含点号的配置名应拒绝（防路径遍历）', async () => {
    const confirmConfigSuggestion = vi.fn();
    const ctx = createMockCtx({ config: { confirmConfigSuggestion } });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.SUGGESTION_ACCEPT)!;
    const result = await callback({}, { ...createValidSuggestion(), name: 'rule.md' });

    expect(confirmConfigSuggestion).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: '无效的配置名称' });
  });

  it('超大内容应拒绝（防内存耗尽）', async () => {
    const confirmConfigSuggestion = vi.fn();
    const ctx = createMockCtx({ config: { confirmConfigSuggestion } });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.SUGGESTION_ACCEPT)!;
    const result = await callback({}, {
      ...createValidSuggestion(),
      content: 'a'.repeat(11 * 1024 * 1024),
    });

    expect(confirmConfigSuggestion).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: '内容过长' });
  });

  it('config=null 应返回配置管理器未就绪', async () => {
    const ctx = createMockCtx({ config: null });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.SUGGESTION_ACCEPT)!;
    const result = await callback({}, createValidSuggestion());

    expect(result).toEqual({ success: false, error: '配置管理器未就绪' });
  });

  // MIND2-C1：写操作改用 throwingHandle 后，内核抛错会 re-throw（不再降级返回 fallback）
  it('confirmConfigSuggestion 抛错应 re-throw 让渲染层 catch', async () => {
    const confirmConfigSuggestion = vi.fn(async () => {
      throw new Error('写入失败');
    });
    const ctx = createMockCtx({ config: { confirmConfigSuggestion } });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.SUGGESTION_ACCEPT)!;

    await expect(callback({}, createValidSuggestion())).rejects.toThrow('写入失败');
  });

  // ─── SUGGESTION_REJECT ─────────────────────────────────

  it('SUGGESTION_REJECT 应直接返回成功（无副作用）', async () => {
    const ctx = createMockCtx();
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.SUGGESTION_REJECT)!;
    const result = await callback({}, createValidSuggestion());

    expect(result).toEqual({ success: true });
  });

  // ─── USER_PROFILE_LIST ─────────────────────────────────

  it('应合并返回已确认 + 待确认画像条目', async () => {
    const confirmed = [{ id: '1', category: '偏好', value: '简洁', source: '对话', weight: 0.9, confirmed: true, updatedAt: '2026-06-26' }];
    const pending = [{ id: '2', category: '习惯', value: '夜间', source: '观察', weight: 0.7, confirmed: false, updatedAt: '2026-06-26' }];
    const ctx = createMockCtx({
      userProfile: {
        getConfirmed: vi.fn(() => confirmed),
        getPending: vi.fn(() => pending),
        confirm: vi.fn(),
        reject: vi.fn(),
      },
    });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_LIST)!;
    const result = await callback();

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual(confirmed[0]);
    expect(result.entries[1]).toEqual(pending[0]);
  });

  it('profile=null 应降级返回空列表', async () => {
    const ctx = createMockCtx({ userProfile: null });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_LIST)!;
    const result = await callback();

    expect(result).toEqual({ entries: [] });
  });

  // ─── USER_PROFILE_CONFIRM ──────────────────────────────

  it('CONFIRM 应调用 profile.confirm 并返回成功', async () => {
    const confirm = vi.fn(async () => {});
    const ctx = createMockCtx({
      userProfile: {
        getConfirmed: vi.fn(),
        getPending: vi.fn(),
        confirm,
        reject: vi.fn(),
      },
    });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_CONFIRM)!;
    const result = await callback({}, '1');

    expect(confirm).toHaveBeenCalledWith('1');
    expect(result).toEqual({ success: true });
  });

  it('profile=null 时 CONFIRM 应返回未就绪', async () => {
    const ctx = createMockCtx({ userProfile: null });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_CONFIRM)!;
    const result = await callback({}, '1');

    expect(result).toEqual({ success: false, error: '用户画像管理器未就绪' });
  });

  // 画像 ID 校验失败路径
  it('CONFIRM 空字符串 ID 应拒绝（不调用 profile.confirm）', async () => {
    const confirm = vi.fn(async () => {});
    const ctx = createMockCtx({
      userProfile: { getConfirmed: vi.fn(), getPending: vi.fn(), confirm, reject: vi.fn() },
    });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_CONFIRM)!;
    const result = await callback({}, '');

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: '非法画像条目 ID' });
  });

  it('CONFIRM 非字符串 ID 应拒绝（不调用 profile.confirm）', async () => {
    const confirm = vi.fn(async () => {});
    const ctx = createMockCtx({
      userProfile: { getConfirmed: vi.fn(), getPending: vi.fn(), confirm, reject: vi.fn() },
    });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_CONFIRM)!;
    const result = await callback({}, null as unknown as string);

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: '非法画像条目 ID' });
  });

  // ─── USER_PROFILE_REJECT ───────────────────────────────

  it('REJECT 应调用 profile.reject 并返回成功', async () => {
    const reject = vi.fn(async () => {});
    const ctx = createMockCtx({
      userProfile: {
        getConfirmed: vi.fn(),
        getPending: vi.fn(),
        confirm: vi.fn(),
        reject,
      },
    });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_REJECT)!;
    const result = await callback({}, '1');

    expect(reject).toHaveBeenCalledWith('1');
    expect(result).toEqual({ success: true });
  });

  it('profile=null 时 REJECT 应返回未就绪', async () => {
    const ctx = createMockCtx({ userProfile: null });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_REJECT)!;
    const result = await callback({}, '1');

    expect(result).toEqual({ success: false, error: '用户画像管理器未就绪' });
  });

  // 画像 ID 校验失败路径
  it('REJECT 空字符串 ID 应拒绝（不调用 profile.reject）', async () => {
    const reject = vi.fn(async () => {});
    const ctx = createMockCtx({
      userProfile: { getConfirmed: vi.fn(), getPending: vi.fn(), confirm: vi.fn(), reject },
    });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_REJECT)!;
    const result = await callback({}, '');

    expect(reject).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: '非法画像条目 ID' });
  });

  it('REJECT 超长 ID 应拒绝（不调用 profile.reject）', async () => {
    const reject = vi.fn(async () => {});
    const ctx = createMockCtx({
      userProfile: { getConfirmed: vi.fn(), getPending: vi.fn(), confirm: vi.fn(), reject },
    });
    registerSuggestionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USER_PROFILE_REJECT)!;
    const result = await callback({}, 'a'.repeat(501));

    expect(reject).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: '非法画像条目 ID' });
  });
});
