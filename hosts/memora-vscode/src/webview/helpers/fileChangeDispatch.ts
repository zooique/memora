/**
 * 文件改动条「确认 / 回退」两类消息的宿主分流（自 chatPanel.ts 外置 · 腾 max-lines 行）
 *
 * 两个 type 各有两种语义，靠 webview 上行是否带 `path` 区分：
 *   - 带 path（清单行单文件按钮）→ 走 chatRefOps 的对拍 + 首根越界守卫 + 已注册单文件命令；
 *   - 无 path（头部全量按钮）→ 直接走已注册全量命令。
 *
 * 为何外置：chatPanel 贴 max-lines 2200 闸（只降不升），四个分支内联超闸；本域只做
 * 「按 type + path 选一条现成命令」的纯分派，不持有面板状态、不改命令实现（SSOT 全在
 * chatRefOps / fileChangeView），按语义切得开。宿主侧执行句柄由调用方注入，本模块零
 * 顶层 vscode 依赖（也无 DOM），保持纯函数便于单测。
 */
import {
  CONFIRM_ALL_FILE_CHANGES_COMMAND,
  REVERT_ALL_FILE_CHANGES_COMMAND,
} from '../../extension/host/fileChangeView.js';
import type { ChatRefOps } from '../panels/chatRefOps.js';

/** 注入的执行口径：与 vscode.commands.executeCommand 同签名（调用方传入，避免顶层依赖） */
export type FileChangeCommandRunner = (command: string, ...args: unknown[]) => unknown;

export interface FileChangeDispatchDeps {
  refOps: ChatRefOps;
  changedFiles: readonly string[];
  runCommand: FileChangeCommandRunner;
}

/**
 * 分派一条确认/回退消息。
 *
 * `type` 取自已收窄的 webview 消息（调用方的 else-if 分支已判过 type，这里不再重复判别来源）。
 * 命令 id 全走 fileChangeView 真源常量，不内嵌字面量（SSOT）。
 */
export function dispatchFileChangeAction(
  type: 'confirm_all_file_changes' | 'revert_all_file_changes',
  path: string | undefined,
  deps: FileChangeDispatchDeps,
): void {
  const { refOps, changedFiles, runCommand } = deps;
  if (type === 'confirm_all_file_changes') {
    if (path) {
      refOps.confirmChangedFile(path, changedFiles);
      return;
    }
    // 头部全量确认：纯内存清理，无二次确认
    void runCommand(CONFIRM_ALL_FILE_CHANGES_COMMAND);
    return;
  }
  if (path) {
    refOps.restoreChangedFile(path, changedFiles);
    return;
  }
  // 头部全量回退：命令自带模态二次确认（破坏性操作，勿绕过）
  void runCommand(REVERT_ALL_FILE_CHANGES_COMMAND);
}
