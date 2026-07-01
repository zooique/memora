/**
 * C-1：IPC 通道一致性测试
 *
 * 断言 preload.ts 的内联通道副本与 ipc/channels.ts 的真理源完全一致。
 *
 * 背景：
 * Electron sandbox: true 要求 preload 是单个 CommonJS 文件，不能运行时 import channels.ts。
 * 因此 preload.ts 手动复制了一份 IPC_CHANNELS 和 MAIN_TO_RENDERER_CHANNELS。
 * 若 channels.ts 改名而 preload 副本未同步，将导致通道静默失配，
 * 表现为 UI 按钮无响应、浮动图标无法拖动等全链路失效，极难排查。
 *
 * 本测试通过 mock electron 模块后 import preload.ts，断言两者键集和值完全一致。
 */
import { describe, it, expect, vi } from 'vitest';

// C-1：mock electron 模块——preload.ts 顶层 import { contextBridge, ipcRenderer } from 'electron'
// vitest 环境无 electron，不 mock 会直接报错
vi.mock('electron', () => ({
  contextBridge: {
    // 条件保护已检查 typeof !== 'undefined'，此处提供空实现让条件通过
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

// 从真理源导入
import {
  IPC_CHANNELS as SOURCE_IPC_CHANNELS,
  MAIN_TO_RENDERER_CHANNELS as SOURCE_MAIN_TO_RENDERER,
} from '../../../electron/ipc/channels.js';
// 从 preload 内联副本导入
import {
  IPC_CHANNELS as PRELOAD_IPC_CHANNELS,
  MAIN_TO_RENDERER_CHANNELS as PRELOAD_MAIN_TO_RENDERER,
} from '../../../electron/preload.js';

// ─── IPC_CHANNELS（渲染 → 主进程）一致性 ───────────────────

describe('C-1: preload 内联 IPC_CHANNELS 与真理源一致', () => {
  it('键集应完全相同（preload 缺失或多余通道均会导致通信失配）', () => {
    const sourceKeys = Object.keys(SOURCE_IPC_CHANNELS).sort();
    const preloadKeys = Object.keys(PRELOAD_IPC_CHANNELS).sort();
    expect(preloadKeys).toEqual(sourceKeys);
  });

  it('每个通道的值应完全相同', () => {
    for (const key of Object.keys(SOURCE_IPC_CHANNELS)) {
      expect(PRELOAD_IPC_CHANNELS[key as keyof typeof PRELOAD_IPC_CHANNELS]).toBe(
        SOURCE_IPC_CHANNELS[key as keyof typeof SOURCE_IPC_CHANNELS],
      );
    }
  });
});

// ─── MAIN_TO_RENDERER_CHANNELS（主进程 → 渲染）一致性 ───────

describe('C-1: preload 内联 MAIN_TO_RENDERER_CHANNELS 与真理源一致', () => {
  it('键集应完全相同', () => {
    const sourceKeys = Object.keys(SOURCE_MAIN_TO_RENDERER).sort();
    const preloadKeys = Object.keys(PRELOAD_MAIN_TO_RENDERER).sort();
    expect(preloadKeys).toEqual(sourceKeys);
  });

  it('每个通道的值应完全相同', () => {
    for (const key of Object.keys(SOURCE_MAIN_TO_RENDERER)) {
      expect(PRELOAD_MAIN_TO_RENDERER[key as keyof typeof PRELOAD_MAIN_TO_RENDERER]).toBe(
        SOURCE_MAIN_TO_RENDERER[key as keyof typeof SOURCE_MAIN_TO_RENDERER],
      );
    }
  });
});
