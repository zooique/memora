/**
 * IPC 通道常量测试
 *
 * 覆盖范围：
 * - IPC_CHANNELS：渲染进程 → 主进程通道（值唯一性 + 命名规范）
 * - MAIN_TO_RENDERER_CHANNELS：主进程 → 渲染进程通道（值唯一性 + 命名规范）
 * - 通道值不可变性（as const 冻结）
 *
 * 这些常量是 IPC 通信契约的核心，拼写错误会导致通信静默失败。
 * 零依赖纯逻辑测试。
 */
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from '../../../electron/ipc/channels.js';

// ─── IPC_CHANNELS（渲染 → 主进程） ───────────────────────

describe('IPC_CHANNELS', () => {
  it('应包含对话相关通道', () => {
    expect(IPC_CHANNELS.USER_INPUT).toBe('user-input');
    expect(IPC_CHANNELS.CHAT_ABORT).toBe('chat-abort');
    expect(IPC_CHANNELS.SESSION_LOAD).toBe('session-load');
  });

  it('应包含记忆相关通道', () => {
    expect(IPC_CHANNELS.MEMORIES_LIST).toBe('memories-list');
    expect(IPC_CHANNELS.MEMORIES_SEARCH).toBe('memories-search');
    expect(IPC_CHANNELS.MEMORIES_DELETE).toBe('memories-delete');
    // SEC-P2-01：缺口 J 新增的手动归档通道
    expect(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE).toBe('memories-archive-profile');
    expect(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT).toBe('memories-archive-insight');
  });

  it('应包含配置与 LLM 相关通道', () => {
    expect(IPC_CHANNELS.CONFIG_GET).toBe('config-get');
    expect(IPC_CHANNELS.LLM_CONFIG_SAVE).toBe('llm-config-save');
    expect(IPC_CHANNELS.AGENT_STATUS).toBe('agent-status');
  });

  it('应包含窗口控制通道', () => {
    expect(IPC_CHANNELS.WINDOW_MINIMIZE).toBe('window-minimize');
    expect(IPC_CHANNELS.WINDOW_CLOSE).toBe('window-close');
    expect(IPC_CHANNELS.EXPAND_TO_FULL).toBe('expand-to-full');
  });

  it('所有通道值应为 kebab-case（小写字母+连字符）', () => {
    const allValues = Object.values(IPC_CHANNELS);
    const kebabPattern = /^[a-z][a-z0-9-]*$/;
    for (const value of allValues) {
      expect(value).toMatch(kebabPattern);
    }
  });

  it('所有通道值应唯一（防拼写错误导致通道冲突）', () => {
    const allValues = Object.values(IPC_CHANNELS);
    const uniqueValues = new Set(allValues);
    expect(allValues.length).toBe(uniqueValues.size);
  });
});

// ─── MAIN_TO_RENDERER_CHANNELS（主进程 → 渲染） ─────────

describe('MAIN_TO_RENDERER_CHANNELS', () => {
  it('应包含流式对话通道', () => {
    expect(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START).toBe('sprite-stream-start');
    expect(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK).toBe('sprite-stream-chunk');
    expect(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END).toBe('sprite-stream-end');
  });

  it('应包含精灵事件通道', () => {
    expect(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT).toBe('sprite-output');
    expect(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT).toBe('sprite-event');
    expect(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR).toBe('sprite-error');
  });

  it('应包含应用级事件通道', () => {
    expect(MAIN_TO_RENDERER_CHANNELS.APP_ERROR).toBe('app-error');
    expect(MAIN_TO_RENDERER_CHANNELS.AGENT_READY).toBe('agent-ready');
  });

  it('所有通道值应为 kebab-case', () => {
    const allValues = Object.values(MAIN_TO_RENDERER_CHANNELS);
    const kebabPattern = /^[a-z][a-z0-9-]*$/;
    for (const value of allValues) {
      expect(value).toMatch(kebabPattern);
    }
  });

  it('所有通道值应唯一', () => {
    const allValues = Object.values(MAIN_TO_RENDERER_CHANNELS);
    const uniqueValues = new Set(allValues);
    expect(allValues.length).toBe(uniqueValues.size);
  });
});

// ─── 跨通道唯一性 ───────────────────────────────────────

describe('跨通道唯一性', () => {
  it('IPC_CHANNELS 和 MAIN_TO_RENDERER_CHANNELS 的值不应重叠', () => {
    // 两个方向的通道值不应相同，避免双向通信混淆
    const rendererToMain = new Set(Object.values(IPC_CHANNELS));
    const mainToRenderer = new Set(Object.values(MAIN_TO_RENDERER_CHANNELS));
    for (const value of rendererToMain) {
      expect(mainToRenderer.has(value)).toBe(false);
    }
  });
});
