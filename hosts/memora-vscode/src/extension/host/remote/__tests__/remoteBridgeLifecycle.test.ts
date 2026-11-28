/**
 * 远程桥运行时启停（2026-11-28）
 *
 * 守住三件事：
 *   ① 运行时开关启动的桥进同一份实例登记，状态回推读得到；
 *   ② 停桥真实清运行时登记 / 句柄，且幂等；
 *   ③ 设置页只上报 toggle，宿主按 isRunning 真值决定翻转方向。
 *
 * 说明：extension.ts 是零测试覆盖区，这里的生命周期函数属 `remoteBridgeHost.ts`，
 * 可测；扩展里把生命周期注册进来的接线仍由 tsc / 产物实读兜底。
 */
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  l10n: { t: (s: string) => s },
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('vscode', () => ({
  l10n: h.l10n,
  window: { showInformationMessage: h.info, showWarningMessage: h.warning },
  workspace: { workspaceFolders: [] },
}));

import {
  getActiveRemoteBridge,
  getRemoteBridgeRuntime,
  registerRemoteBridgeLifecycle,
  startRemoteBridge,
  stopActiveRemoteBridge,
  toggleRemoteBridge,
} from '../remoteBridgeHost.js';

/** 回环档用最小上下文（LAN 才读 secrets / globalState） */
function makeContext(): never {
  return {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
    globalStorageUri: { fsPath: '' },
  } as never;
}

/** 桥端口只需 start() 不触碰的部分；start 阶段不会调会话投影 */
function makeDeps(): never {
  return {
    panel: {
      projectSession: () => ({ state: { phase: 'idle' }, rounds: [], pendingQueue: [] }),
      buildLiveTurnFromBuffer: () => undefined,
      handleInput: async () => undefined,
      getAssistantSessionId: () => undefined,
      answerConfirm: () => false,
      pendingConfirm: () => ({ count: 0 }),
    },
    store: { listSessions: () => [] },
    log: () => undefined,
    createSession: async () => false,
    listRolePacks: () => ({ packs: [] }),
  } as never;
}

afterEach(async () => {
  await stopActiveRemoteBridge();
  vi.clearAllMocks();
});

describe('remoteBridgeHost · 运行时实例登记', () => {
  it('显式 mode 启动后运行时与实例同步可见（不读环境变量）', async () => {
    const bridge = await startRemoteBridge(makeDeps(), { context: makeContext() }, 'loopback');
    expect(bridge).toBeDefined();
    expect(bridge?.listeningPort).toBeGreaterThan(0);
    expect(getActiveRemoteBridge()).toBe(bridge);
    expect(getRemoteBridgeRuntime()).toEqual({ mode: 'loopback', port: bridge?.listeningPort });
  });

  it('重复启动共用同一监听，不开第二个端口', async () => {
    const [first, second] = await Promise.all([
      startRemoteBridge(makeDeps(), { context: makeContext() }, 'loopback'),
      startRemoteBridge(makeDeps(), { context: makeContext() }, 'loopback'),
    ]);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('停桥清登记且幂等（第二次不抛错）', async () => {
    await startRemoteBridge(makeDeps(), { context: makeContext() }, 'loopback');
    await stopActiveRemoteBridge();
    expect(getActiveRemoteBridge()).toBeUndefined();
    expect(getRemoteBridgeRuntime()).toBeUndefined();
    await expect(stopActiveRemoteBridge()).resolves.toBeUndefined();
  });
});

describe('remoteBridgeHost · 设置页 toggle 意图', () => {
  it('未运行 → start；运行中 → stop（方向由宿主真值裁决）', async () => {
    const calls: string[] = [];
    let running = false;
    registerRemoteBridgeLifecycle({
      isRunning: () => running,
      start: async () => {
        calls.push('start');
        running = true;
        return { ok: true };
      },
      stop: async () => {
        calls.push('stop');
        running = false;
        return { ok: true };
      },
    });
    await expect(toggleRemoteBridge()).resolves.toEqual({ ok: true });
    await expect(toggleRemoteBridge()).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['start', 'stop']);
  });

  it('执行面如实回传失败，不吞成成功', async () => {
    registerRemoteBridgeLifecycle({
      isRunning: () => false,
      start: async () => ({ ok: false, message: 'start failed' }),
      stop: async () => ({ ok: true }),
    });
    await expect(toggleRemoteBridge()).resolves.toEqual({ ok: false, message: 'start failed' });
  });
});
