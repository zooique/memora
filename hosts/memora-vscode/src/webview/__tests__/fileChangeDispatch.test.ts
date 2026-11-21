/**
 * fileChangeDispatch 分流守卫：确认/回退 × 带 path / 无 path 四象限
 *
 * 判据：① 带 path 走 chatRefOps 单文件方法（对拍/越界/命令在其内部，本域不复刻）；
 *       ② 无 path 走 fileChangeView 真源的全量命令 id（不内嵌字面量）；
 *       ③ 两 type 互不串线（confirm 不触发 revert 命令，反之亦然）；
 *       ④ 只分派一次（不重复执行命令）。
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * fileChangeView 顶层执行 registerCommand，测试环境无真实 vscode 模块——最小替身先于
 * import 挂好（vi.hoisted），让真源常量可被 import；本套件只验分流，不触发命令注册体。
 */
vi.mock('vscode', () => ({
  commands: { registerCommand: vi.fn() },
  l10n: { t: (msg: string) => msg },
}));

import {
  CONFIRM_ALL_FILE_CHANGES_COMMAND,
  REVERT_ALL_FILE_CHANGES_COMMAND,
} from '../../extension/host/fileChangeView.js';
import { dispatchFileChangeAction } from '../helpers/fileChangeDispatch.js';
import type { ChatRefOps } from '../panels/chatRefOps.js';

function makeOps(): ChatRefOps {
  return {
    openChangedFile: vi.fn(),
    confirmChangedFile: vi.fn(),
    restoreChangedFile: vi.fn(),
    openMentionQuickPick: vi.fn(),
  } as unknown as ChatRefOps;
}

describe('fileChangeDispatch · 确认/回退按 path 四象限分流', () => {
  it('confirm + 带 path → 只调 confirmChangedFile，零命令执行', () => {
    const refOps = makeOps();
    const runCommand = vi.fn();
    dispatchFileChangeAction('confirm_all_file_changes', 'src/a.ts', {
      refOps,
      changedFiles: ['src/a.ts'],
      runCommand,
    });
    expect(refOps.confirmChangedFile).toHaveBeenCalledWith('src/a.ts', ['src/a.ts']);
    expect(refOps.restoreChangedFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('confirm + 无 path → 只走 CONFIRM_ALL 真源命令（头部全量按钮逐字不动）', () => {
    const refOps = makeOps();
    const runCommand = vi.fn();
    dispatchFileChangeAction('confirm_all_file_changes', undefined, {
      refOps,
      changedFiles: ['src/a.ts'],
      runCommand,
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(CONFIRM_ALL_FILE_CHANGES_COMMAND);
    expect(refOps.confirmChangedFile).not.toHaveBeenCalled();
  });

  it('revert + 带 path → 只调 restoreChangedFile，零命令执行', () => {
    const refOps = makeOps();
    const runCommand = vi.fn();
    dispatchFileChangeAction('revert_all_file_changes', 'src/b.ts', {
      refOps,
      changedFiles: ['src/b.ts'],
      runCommand,
    });
    expect(refOps.restoreChangedFile).toHaveBeenCalledWith('src/b.ts', ['src/b.ts']);
    expect(refOps.confirmChangedFile).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('revert + 无 path → 只走 REVERT_ALL 真源命令（含模态确认，本域不绕过）', () => {
    const refOps = makeOps();
    const runCommand = vi.fn();
    dispatchFileChangeAction('revert_all_file_changes', undefined, {
      refOps,
      changedFiles: ['src/b.ts'],
      runCommand,
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(REVERT_ALL_FILE_CHANGES_COMMAND);
    expect(refOps.restoreChangedFile).not.toHaveBeenCalled();
  });

  it('空清单 + 带 path 仍分派给 refOps（对拍失败判定归 refOps，不本域复刻）', () => {
    const refOps = makeOps();
    const runCommand = vi.fn();
    dispatchFileChangeAction('revert_all_file_changes', 'src/missing.ts', {
      refOps,
      changedFiles: [],
      runCommand,
    });
    expect(refOps.restoreChangedFile).toHaveBeenCalledWith('src/missing.ts', []);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
