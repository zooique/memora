/**
 * 助手页内嵌工作台抽屉 · 宿主拦截测试（INLINE-WORKBENCH-1）
 *
 * 钉住判据：助手页点「工作台」（上行 assistant_open_workbench）不再开独立 editor tab，
 * 而是由宿主按当前助手会话现场构建快照、直投本页 webview（workbench_snapshot）。
 * 上行 type 不变（assistantFormView 判据），零新增协议 type。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';

const mocks = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
  postMessage: vi.fn(),
  onDidReceiveMessage: vi.fn(),
  routeHostedMessage: vi.fn(),
  buildWorkbenchSnapshot: vi.fn(),
  seatSourceFor: vi.fn(),
  getAssistantSessionId: vi.fn(),
}));

vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({ parts }),
    file: (path: string) => ({ toString: () => `file:${path}` }),
  },
  window: { createWebviewPanel: mocks.createWebviewPanel },
  ViewColumn: { Beside: 2 },
  env: { language: 'en' },
  // 首帧 wrapper 读 chatTextScale：mock 命名空间对未定义导出访问即 throw，须补齐该键
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

import { MemoraHostedPanel } from '../panels/hostedPanel.js';

function mount() {
  let handler: ((msg: WebviewToExtensionMessage) => void) | undefined;
  mocks.createWebviewPanel.mockReset();
  mocks.postMessage.mockReset();
  mocks.onDidReceiveMessage.mockReset();
  mocks.routeHostedMessage.mockReset();
  mocks.buildWorkbenchSnapshot.mockReset();
  mocks.seatSourceFor.mockReset();
  mocks.getAssistantSessionId.mockReset();
  mocks.createWebviewPanel.mockImplementation(() => ({
    reveal: () => {},
    webview: {
      cspSource: 'test-csp',
      asWebviewUri: (u: { toString(): string }) => ({ toString: () => u.toString() }),
      html: '',
      postMessage: mocks.postMessage,
      onDidReceiveMessage: (h: (msg: WebviewToExtensionMessage) => void) => {
        handler = h;
        return { dispose: () => {} };
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
  }));
  mocks.getAssistantSessionId.mockReturnValue('assistant-1');
  mocks.seatSourceFor.mockReturnValue('live');
  const snapshot = { jobs: [], coverage: 'complete' };
  mocks.buildWorkbenchSnapshot.mockReturnValue(snapshot);
  const panel = new MemoraHostedPanel({
    extensionUri: {} as never,
    chatProvider: {
      registerAdditionalView: () => ({ dispose: () => {} }),
      getAssistantSessionId: mocks.getAssistantSessionId,
      routeHostedMessage: mocks.routeHostedMessage,
    } as never,
    workspacePath: '/proj',
    buildWorkbenchSnapshot: mocks.buildWorkbenchSnapshot,
    seatSourceFor: mocks.seatSourceFor,
  });
  panel.open();
  return { handler: handler!, snapshot };
}

describe('INLINE-WORKBENCH-1 · 助手页工作台按钮就地展开', () => {
  it('点工作台 → 按当前助手会话现场构建快照并直投本页，不再走 routeHostedMessage', () => {
    const { handler, snapshot } = mount();
    handler({ type: 'assistant_open_workbench' });
    expect(mocks.getAssistantSessionId).toHaveBeenCalledOnce();
    expect(mocks.seatSourceFor).toHaveBeenCalledWith('assistant-1');
    expect(mocks.buildWorkbenchSnapshot).toHaveBeenCalledWith('assistant-1', 'live');
    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: 'workbench_snapshot',
      snapshot,
    });
    expect(mocks.routeHostedMessage).not.toHaveBeenCalled();
  });

  it('座位恢复档原样透传给快照构建（不固定 live，避免历史清单被 live 过滤器清空）', () => {
    const { handler } = mount();
    mocks.seatSourceFor.mockReturnValue('restored');
    handler({ type: 'assistant_open_workbench' });
    expect(mocks.buildWorkbenchSnapshot).toHaveBeenCalledWith('assistant-1', 'restored');
  });

  it('其它上行消息仍原样转发（拦截是窄分支，不吞常态消息）', () => {
    const { handler } = mount();
    const msg = { type: 'input', text: 'hi', kind: 'send' } as WebviewToExtensionMessage;
    handler(msg);
    expect(mocks.routeHostedMessage).toHaveBeenCalledWith(msg);
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });
});
