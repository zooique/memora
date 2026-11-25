/**
 * 助手窗缩略图预览资源根回归（2026-11-18 真机缺陷 · HOSTED-IMAGE-PREVIEW-1）
 *
 * 真机实锤：助手窗加图 chip 正常，但悬停缩略图加载失败退文本态。根因 =
 * 图片回执已按 IMAGE-TARGET-1 定向到助手窗，但助手窗 webview 的
 * `localResourceRoots` 只有 `dist/webview`，没放行附件目录；侧栏 chatPanel 早已放行。
 * 本测试钉死：助手窗资源根必须同时含 dist/webview 与 resolveAttachmentsDir 真源，
 * 且两者口径与侧栏一致（不新造路径拼接）。
 *
 * 跨 webview 为何 URI 可复用：asWebviewUri 的 authority 只由 remoteInfo + 资源路径派生，
 * cspSource 对本地扩展是全局常量，均不含 per-webview 实例标识——故只补资源根即可。
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { resolveAttachmentsDir } from '../../extension/host/projectDataDir.js';

// createWebviewPanel 的可观测入参（第 4 参 options）先 hoisted 声明
const mocks = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
}));

vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
  // Uri.joinPath 产出 dist/webview 标记；Uri.file 产出 file:<path> 标记，供断言区分两类根
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({ tag: 'join', parts }),
    file: (path: string) => ({ tag: 'file', path, toString: () => `file:${path}` }),
  },
  window: { createWebviewPanel: mocks.createWebviewPanel },
  ViewColumn: { Beside: 2 },
  env: { language: 'en' },
  // 首帧 wrapper 读 chatTextScale：mock 命名空间对未定义导出访问即 throw，须补齐该键
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

import { MemoraHostedPanel } from '../panels/hostedPanel.js';

/** 最小 chatProvider 替身：open() 只用到 registerAdditionalView / getAssistantSessionId */
function chatProviderStub(): Record<string, unknown> {
  return {
    registerAdditionalView: () => ({ dispose: () => {} }),
    getAssistantSessionId: () => 'assistant-1',
  };
}

/** 驱动一次 open() 并返回 createWebviewPanel 第 4 参 options */
function openAndGetOptions(workspacePath: string): {
  options: Record<string, unknown>;
} {
  mocks.createWebviewPanel.mockReset();
  mocks.createWebviewPanel.mockImplementation(() => ({
    reveal: () => {},
    webview: {
      cspSource: 'test-csp',
      asWebviewUri: (u: { toString(): string }) => ({ toString: () => u.toString() }),
      html: '',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    },
    onDidDispose: () => ({ dispose: () => {} }),
  }));
  const panel = new MemoraHostedPanel({
    extensionUri: {} as never,
    chatProvider: chatProviderStub() as never,
    workspacePath,
    buildWorkbenchSnapshot: () => ({}) as never,
    seatSourceFor: () => 'live',
  });
  panel.open();
  return { options: mocks.createWebviewPanel.mock.calls[0][3] as Record<string, unknown> };
}

const WORKSPACE = '/proj';

describe('HOSTED-IMAGE-PREVIEW-1 · 助手窗缩略图预览资源根', () => {
  it('资源根含 dist/webview 与 attachments 目录（真源 resolveAttachmentsDir）', () => {
    const { options } = openAndGetOptions(WORKSPACE);
    const roots = options.localResourceRoots as Array<{
      tag: string;
      path?: string;
      parts?: string[];
    }>;

    // dist/webview 仍在（脚本入口不能丢）
    expect(roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: 'join', parts: ['dist', 'webview'] }),
      ]),
    );
    // attachments 真源被放行，且不是硬编码字符串拼接
    expect(roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: 'file', path: resolveAttachmentsDir(WORKSPACE) }),
      ]),
    );
  });

  it('attachments 根随 workspacePath 变化（非固定常量，与侧栏同口径）', () => {
    const a = openAndGetOptions('/proj-a').options.localResourceRoots as Array<{
      tag: string;
      path?: string;
    }>;
    const b = openAndGetOptions('/proj-b').options.localResourceRoots as Array<{
      tag: string;
      path?: string;
    }>;
    const attachOf = (roots: Array<{ tag: string; path?: string }>) =>
      roots.find((r) => r.tag === 'file')?.path;

    expect(attachOf(a)).toBe(resolveAttachmentsDir('/proj-a'));
    expect(attachOf(b)).toBe(resolveAttachmentsDir('/proj-b'));
    expect(attachOf(a)).not.toBe(attachOf(b));
  });

  it('判据原文守卫：open() 放行 attachments 真源且只此一处新增根', () => {
    // 源码级锚点：删掉 resolveAttachmentsDir 这行即红
    const src = readFileSync(new URL('../panels/hostedPanel.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/vscode\.Uri\.file\(resolveAttachmentsDir\(this\._workspacePath\)\)/);
    expect(src).toMatch(/localResourceRoots:\s*\[/);
  });
});
