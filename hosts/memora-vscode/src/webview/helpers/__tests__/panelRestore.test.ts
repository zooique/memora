/**
 * 面板恢复拦截测试
 *
 * 覆盖：registerDisposeOnRestore 注册的 deserializer 在 VS Code 恢复面板时
 * 会立即 dispose 传入的 panel（vs code 1.90 宿主类型，allWebviewPanels 1.93 才有）。
 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    registerWebviewPanelSerializer: vi.fn(),
  },
}));

import * as vscode from 'vscode';
import { registerDisposeOnRestore } from '../panelRestore.js';

describe('registerDisposeOnRestore', () => {
  it('注册 serializer，并在 deserializer 里 dispose 传入的 panel', async () => {
    const panelDispose = vi.fn();
    const panel = { dispose: panelDispose } as unknown as vscode.WebviewPanel;

    let deserialized: vscode.WebviewPanelSerializer | undefined;
    const registerMock = vi
      .mocked(vscode.window.registerWebviewPanelSerializer)
      .mockImplementation((_viewType, d) => {
        deserialized = d;
        return { dispose: vi.fn() };
      });

    const disposable = registerDisposeOnRestore('memora.hosted');

    expect(registerMock).toHaveBeenCalledWith(
      'memora.hosted',
      expect.objectContaining({ deserializeWebviewPanel: expect.any(Function) }),
    );
    expect(deserialized).toBeDefined();
    await deserialized!.deserializeWebviewPanel(panel, undefined);
    expect(panelDispose).toHaveBeenCalledTimes(1);

    // 返回的 disposable 自身有 dispose（被推 context.subscriptions）
    disposable.dispose();
  });
});
