/**
 * 助手页引用草稿投递回归（ADDED-TO-ASSISTANT-1）
 *
 * 右键「添加到助手」的引用是**与会话无关的输入区草稿**，投助手页 webview 的 addRef。
 * 真机时序坑：命令自动打开助手页时，新 webview 脚本尚未 ready，直接 postMessage 会丢
 * （与侧栏 `_pendingRefs` 同因）。故钉死三条判据：
 *   ① 未 ready 时 attachRefs 只缓冲、不 post；
 *   ② 多次 attach 合并去重（判据 = shared/refKey 的 dedupeRefs，含行区间），ready 后一次性补发；
 *   ③ 已 ready 时 attachRefs 直投；空会话 / 空引用不产生空 post。
 *
 * node 环境 + 显式 mock（webview 无 DOM 依赖）。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { ChatRef } from '../../shared/protocol.js';

const mocks = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
  postMessage: vi.fn(),
  onDidReceiveMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({ tag: 'join', parts }),
    file: (path: string) => ({ tag: 'file', path, toString: () => `file:${path}` }),
  },
  window: { createWebviewPanel: mocks.createWebviewPanel },
  ViewColumn: { Beside: 2 },
  env: { language: 'en' },
}));

import { MemoraHostedPanel } from '../panels/hostedPanel.js';

/** 构造一个可驱动 ready 的助手页：捕获 onDidReceiveMessage 回调与 postMessage */
function makePanel() {
  let onMessage: ((msg: { type: string }) => void) | undefined;
  mocks.postMessage.mockReset();
  mocks.onDidReceiveMessage.mockReset();
  mocks.createWebviewPanel.mockReset();
  mocks.createWebviewPanel.mockImplementation(() => ({
    reveal: () => {},
    webview: {
      cspSource: 'test-csp',
      asWebviewUri: (u: { toString(): string }) => ({ toString: () => u.toString() }),
      html: '',
      postMessage: mocks.postMessage,
      onDidReceiveMessage: (cb: (msg: { type: string }) => void) => {
        onMessage = cb;
        return { dispose: () => {} };
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
  }));
  const panel = new MemoraHostedPanel({
    extensionUri: {} as never,
    chatProvider: {
      registerAdditionalView: () => ({ dispose: () => {} }),
      getAssistantSessionId: () => undefined,
      routeHostedMessage: () => {},
    } as never,
    workspacePath: '/proj',
    buildWorkbenchSnapshot: () => ({}) as never,
    seatSourceFor: () => 'live',
  });
  panel.open();
  return {
    panel,
    ready: () => onMessage?.({ type: 'ready' }),
  };
}

const ref = (path: string): ChatRef => ({ path, kind: 'file' });

describe('ADDED-TO-ASSISTANT-1 · 助手页引用草稿缓冲到 ready', () => {
  it('未 ready：attachRefs 只缓冲不 post；ready 后一次性补发全部引用', () => {
    const { panel, ready } = makePanel();

    panel.attachRefs([ref('src/a.ts')]);
    expect(mocks.postMessage).not.toHaveBeenCalled();

    ready?.();

    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'addRef',
      refs: [ref('src/a.ts')],
    });
  });

  it('多次 attach 合并去重（含行区间），ready 只补发一条', () => {
    const { panel, ready } = makePanel();
    const whole = ref('src/a.ts');
    const ranged: ChatRef = { path: 'src/a.ts', kind: 'file', range: { start: 3, end: 5 } };

    panel.attachRefs([whole]);
    panel.attachRefs([whole]); // 重复 → 去重
    panel.attachRefs([ranged]); // 不同行区间 → 保留（dedupeRefs 含 range）
    ready?.();

    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    expect(mocks.postMessage.mock.calls[0][0].refs).toEqual([whole, ranged]);
  });

  it('已 ready：attachRefs 立即直投，不再等第二次 ready', () => {
    const { panel, ready } = makePanel();
    ready?.();
    mocks.postMessage.mockReset();

    panel.attachRefs([ref('src/b.ts')]);

    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'addRef',
      refs: [ref('src/b.ts')],
    });
  });

  it('空引用列表：ready 不产生空 addRef post', () => {
    const { ready } = makePanel();

    ready?.();

    expect(mocks.postMessage).not.toHaveBeenCalled();
  });
});
