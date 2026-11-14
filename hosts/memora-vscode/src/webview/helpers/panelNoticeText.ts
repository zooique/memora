/**
 * 面板提示文案（快照降级 / 启动让位）——自 chatPanel 外置（max-lines 只降不升）
 *
 * 为什么抽成函数而非常量：`l10n.t` 必须在**调用时刻**取，模块加载期取值会绕过 VS Code
 * 的 locale 初始化窗口，也无法被 bundle 覆盖率判据匹配（同 `confirmCoordinator` 的先例）。
 *
 * 文案纪律：面向用户只说人话，不出现「托管」「主控」这类内部模式名。
 */
import * as vscode from 'vscode';

/**
 * 快照超阈值（文件过多 / 总量过大）时的降级提示
 *
 * 写前快照与写后扫描两条路径都降级到同一句提示——并列字面量必漂移，故只留这一个单点。
 */
export function snapshotOversizeNotice(): string {
  return vscode.l10n.t(
    'Too many text files in the workspace; script changes are not tracked automatically. Use git to review the changes.',
  );
}

/** 启动时首选会话被另一窗口占用、已自动让位到最近可用会话的提示（解释「为什么不是上次那个会话」） */
export function sessionDisplacedNotice(): string {
  return vscode.l10n.t(
    'The session you were on is in use by another window; opened another session instead.',
  );
}

/** 启动时首选会话被占且工作区无其他可用会话、已新建空会话的提示（如实说「新建」而非「另一个」） */
export function sessionDisplacedNewNotice(): string {
  return vscode.l10n.t(
    'The session you were on is in use by another window; created a new empty session.',
  );
}
