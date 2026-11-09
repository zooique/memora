/**
 * workspaceRelativePath 单测（P0-c：路径生成单点化）
 *
 * 覆盖方案 §P0-c 的五类判据：首根内正常 / 非首根 / 越界 / Windows 分隔符规范形 / 非规范形，
 * 外加「未打开工作区」「空目标」「目标即根自身」三种拒绝原因。
 *
 * 手法：纯判据 `adjudicateWorkspaceRelativePath` 用**临时根路径字符串**直接测（不需要真实多根窗口）；
 * 宿主包装 `toWorkspaceRelativePath` 用 vscode mock 的 `workspaceFolders` 测「只取首根」。
 * ⚠️ 多根工作区的**真实窗口**无法在单测里构造，本文件明确只测函数对「第二根路径」的判据，
 * 不假装测了真实多根窗口。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** vscode mock 的可变首根（undefined = 未打开工作区） */
const h = vi.hoisted(() => ({ rootFsPath: '/ws' as string | undefined }));

vi.mock('vscode', () => ({
  workspace: {
    // 与宿主同源：基准恒取 workspaceFolders[0]（多根工作区下也只认首根）
    get workspaceFolders() {
      return h.rootFsPath ? [{ uri: { fsPath: h.rootFsPath } }] : undefined;
    },
  },
}));

import {
  adjudicateWorkspaceRelativePath,
  toWorkspaceRelativePath,
} from '../workspaceRelativePath.js';

/** 把 fsPath 包成最小 Uri 替身（包装层只读 `fsPath`） */
function asUri(fsPath: string): import('vscode').Uri {
  return { fsPath } as unknown as import('vscode').Uri;
}

describe('adjudicateWorkspaceRelativePath（纯判据：首根语义 + 可读拒绝原因）', () => {
  it('首根内的文件 → 相对路径（POSIX 分隔）', () => {
    expect(adjudicateWorkspaceRelativePath('/ws', '/ws/docs/x.md')).toEqual({
      ok: true,
      relPath: 'docs/x.md',
    });
  });

  it('首根内深层目录 → 相对路径原样保留层级', () => {
    expect(adjudicateWorkspaceRelativePath('/ws', '/ws/a/b/c.md')).toEqual({
      ok: true,
      relPath: 'a/b/c.md',
    });
  });

  it('未打开工作区 → no-workspace（根缺失不臆造路径）', () => {
    const r = adjudicateWorkspaceRelativePath(undefined, '/ws/x.md');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('no-workspace');
      // REJECT_MESSAGES 值已倒英文为 l10n 键（切片 2）——断言英文键片段 + reason 码双锚
      expect(r.message).toContain('No workspace folder is open');
    }
  });

  it('空目标 → empty-target', () => {
    const r = adjudicateWorkspaceRelativePath('/ws', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty-target');
  });

  it('非首根（同盘旁系 / 多根第二根路径）→ outside-primary-root', () => {
    // 判据级用例：真实多根窗口不在单测范围，这里锁定「第二根路径必须被拒」这一判据
    const r = adjudicateWorkspaceRelativePath('/ws', '/ws2/x.md');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('outside-primary-root');
      expect(r.message).toContain('outside the first workspace root');
    }
  });

  it('目标即根自身 → is-root-itself（不是可登记的文件）', () => {
    const r = adjudicateWorkspaceRelativePath('/ws', '/ws');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('is-root-itself');
  });

  it('越界写法（含 `..` 段）→ non-canonical（拒绝而非静默归一化）', () => {
    const r = adjudicateWorkspaceRelativePath('/ws', '/ws/../outside/x.md');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('non-canonical');
      expect(r.message).toContain('not canonical');
    }
  });

  it('非规范形（含 `.` 段）→ non-canonical', () => {
    const r = adjudicateWorkspaceRelativePath('/ws', '/ws/./x.md');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('non-canonical');
  });

  it.runIf(process.platform === 'win32')('Windows 盘内 → 归一为 POSIX 分隔', () => {
    expect(adjudicateWorkspaceRelativePath('C:\\ws', 'C:\\ws\\docs\\x.md')).toEqual({
      ok: true,
      relPath: 'docs/x.md',
    });
  });

  it.runIf(process.platform === 'win32')('Windows 跨盘 → cross-drive（可读原因）', () => {
    const r = adjudicateWorkspaceRelativePath('C:\\ws', 'D:\\x.md');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('cross-drive');
      expect(r.message).toContain('different drive');
    }
  });
});

describe('toWorkspaceRelativePath（宿主包装：基准只取首根）', () => {
  beforeEach(() => {
    h.rootFsPath = '/ws';
  });

  it('首根内文件 → 相对路径', () => {
    expect(toWorkspaceRelativePath(asUri('/ws/a.md'))).toEqual({ ok: true, relPath: 'a.md' });
  });

  it('未打开工作区 → no-workspace（不臆造首根）', () => {
    h.rootFsPath = undefined;
    const r = toWorkspaceRelativePath(asUri('/ws/a.md'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-workspace');
  });

  it('不在首根下 → outside-primary-root（多根工作区判据级）', () => {
    const r = toWorkspaceRelativePath(asUri('/other-root/x.md'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('outside-primary-root');
  });
});
