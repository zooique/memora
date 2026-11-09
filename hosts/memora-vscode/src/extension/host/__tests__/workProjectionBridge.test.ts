/**
 * 「内核回执 → 窗口通知」本地化渲染测试（`host/workProjectionBridge.ts`）
 *
 * 切片 2 真机反馈收口的判据面：内核结构化 `reason` 是渲染判据，宿主按码出**本地化**
 * 文案，不透传内核中文散文（真机缺陷：英文界面弹「作品投影清单中没有该文件的登记
 * 记录…」）。锁三件事：① 九个已知 reason 各有专属键且走对通道（成功=info / 其余=error）；
 * ② 同 `not-found` 码在 toggle / unregister 两流渲染不同文案；③ 未知 reason 原文兜底
 * （fail-visible——内核扩码未同步渲染表时宁可显示原文，不静默失义）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** l10n.t 替身：{0}/{1} 占位符按参替换（vi.hoisted——mock 工厂先于 import 执行） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

const state = vi.hoisted(() => ({
  warnings: [] as unknown[],
  errors: [] as unknown[],
  infos: [] as unknown[],
}));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: vi.fn((m: unknown) => {
      state.infos.push(m);
      return undefined;
    }),
    showWarningMessage: vi.fn((m: unknown) => {
      state.warnings.push(m);
      return undefined;
    }),
    showErrorMessage: vi.fn((m: unknown) => {
      state.errors.push(m);
      return undefined;
    }),
  },
  l10n: { t: tStub },
}));

import { showKernelResult } from '../workProjectionBridge.js';

const SRC = 'docs/plan.md';

beforeEach(() => {
  state.warnings.length = 0;
  state.errors.length = 0;
  state.infos.length = 0;
});

describe('showKernelResult · reason 码本地化渲染', () => {
  it('成功三态走 info 通道 + 专属键', () => {
    showKernelResult({ reason: 'enabled', message: '内核中文' }, SRC, 'toggle');
    showKernelResult({ reason: 'disabled', message: '内核中文' }, SRC, 'toggle');
    showKernelResult({ reason: 'removed', message: '内核中文' }, SRC, 'unregister');
    expect(state.infos).toEqual([
      `Already a project rule; nothing changed: ${SRC}`,
      `Already not a project rule; nothing changed: ${SRC}`,
      `Unregistered (source file kept): ${SRC}`,
    ]);
    expect(state.errors).toEqual([]);
  });

  it('toggle 流 not-found → 「请先登记」键（真机反馈缺陷面）', () => {
    showKernelResult({ reason: 'not-found', message: '作品投影清单中…' }, SRC, 'toggle');
    expect(state.errors).toEqual([`Not registered in the works list; register it first: ${SRC}`]);
    expect(state.infos).toEqual([]);
  });

  it('unregister 流同码 not-found → 「未删除任何文件」键（两流语义不同）', () => {
    showKernelResult({ reason: 'not-found', message: '作品投影清单中…' }, SRC, 'unregister');
    expect(state.errors).toEqual([
      `No registered entry for this file; nothing was deleted: ${SRC}`,
    ]);
  });

  it('失败四态 + 清单损坏 + 写失败走 error 通道 + 专属键', () => {
    showKernelResult({ reason: 'untrusted', message: '内核中文' }, SRC, 'toggle');
    showKernelResult({ reason: 'source-unreadable', message: '内核中文' }, SRC, 'toggle');
    showKernelResult({ reason: 'too-long', message: '内核中文' }, SRC, 'toggle');
    showKernelResult({ reason: 'list-malformed', message: '内核中文' }, SRC, 'unregister');
    showKernelResult({ reason: 'write-failed', message: '内核中文' }, SRC, 'unregister');
    expect(state.errors).toEqual([
      'Workspace is not trusted; trust the workspace first',
      `Cannot read or validate the source file: ${SRC}`,
      `Project-rules segment limit exceeded; nothing was written — simplify or remove some rules first: ${SRC}`,
      'Works list file is malformed; nothing changed — fix it to a top-level JSON array and retry',
      'Failed to write the works list (retryable); details in the log',
    ]);
    expect(state.infos).toEqual([]);
  });

  it('未知 reason → 内核原文兜底（fail-visible，不静默失义）', () => {
    showKernelResult({ reason: 'brand-new-code', message: '内核新码中文原文' }, SRC, 'toggle');
    expect(state.errors).toEqual(['内核新码中文原文']);
  });
});
