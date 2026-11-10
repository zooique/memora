/**
 * 窗口通知文案的本地化渲染单点（show*Message / modal / 状态栏项面向的文案在此出）
 *
 * 与 `noticeText.ts`（错误 → 通知文本，纯 node 可测）分文件：本文件 import vscode，
 * 会连累纯 node 测试环境——凡**宿主窗口面**的 l10n 文案函数落这里，凡 catch 错误转
 * 文本的纯函数落 noticeText。键 = 英文原文（ADR-042）。
 * 分界：宿主经 post 送进 webview 的通知串**不在**本文件（webview 显示语言归切片 4
 * 收口，见台账 HOST-I18N-2 遗留登记）。
 */
import * as vscode from 'vscode';
import type { LlmErrorCategory } from '@zooique/memora';
import { readWorkspaceTrusted } from './userAssets/projectScope.js';

/**
 * 插话达上限的拒收提示（INPUT-LIMIT-1）：上限裁决在内核
 * （宿主经 `LOOP_CONSTANTS.MAX_PENDING_INTERJECTIONS` 传入），本串只做窗口提示。
 *
 * @param limit 插话队列上限（内核真源值）
 * @returns 已本地化的拒收提示
 */
export function limitNotice(limit: number): string {
  return vscode.l10n.t(
    'Memora: pending interjections hit the {0}-item limit; this one was not sent — trim in the pending area and retry',
    limit,
  );
}

/**
 * 插话已生效但本轮历史未写入的提示（INTERJECT-PERSIST-1）
 *
 * 🔴 文案**不得**写成「请重发」：插话已在 loop 队列生效（step 边界必注入），
 * 重发会让同一条被注入两次（双执行）。此处只如实告知「历史里没有它」。
 *
 * 形态 = 函数而非常量：常量会在模块求值时就定稿语言，早于 `vscode.l10n` 就绪；
 * 且它原在 `shared/constants.ts`，那里被 webview 侧共用、不能引 `vscode`。
 *
 * @returns 已本地化的提示
 */
export function interjectUnsavedNotice(): string {
  return vscode.l10n.t(
    'Memora: this addition took effect (you will see it this round), but it could not be written to history — this round record no longer exists, so it will not appear when reviewing history. No need to resend.',
  );
}

/**
 * 流内错误 category → 窗口提示文案（宿主实时路）。
 *
 * 与 `shared/errorText.ts`（webview 重放路，中文映射）同 category 联合、同回退语义：
 * 未收录 category 回退原始 message。两份映射并存是切片 4 前的过渡形态（webview 无法
 * 调 `vscode.l10n`），统一收口归切片 4；category 联合类型锁两侧不漂移。
 *
 * @param category 内核判定的结构化分类（缺省 = 普通错误 / 旧数据）
 * @param rawMessage 内核原始 message（回退用）
 * @returns 已本地化的错误提示
 */
export function flowError(category: LlmErrorCategory | undefined, rawMessage: string): string {
  switch (category) {
    case 'connection':
      return vscode.l10n.t(
        'Chat connection lost; the partial answer is kept — check the network and retry',
      );
    case 'timeout':
      return vscode.l10n.t('Chat processing timed out; try again shortly');
    default:
      return rawMessage;
  }
}

/**
 * 未信任工作区的状态栏提示（只提示、不阻断对话）
 *
 * 从 `extension.ts` 外置而成：状态栏项的生命周期（挂 `context.subscriptions`）与它的
 * 本地化文案必须同处一处，否则两头的键与显隐判据各写一份（同 `.text` 裸串复发面）。
 * 真源 = `vscode.workspace.isTrusted`（经 `readWorkspaceTrusted` 单点读，不自存状态副本）。
 *
 * @param context 扩展上下文（状态栏项随插件停用自动释放）
 * @returns 按当前信任状态刷新显隐的函数（信任变更监听器里要再调一次）
 */
export function createTrustNotice(context: vscode.ExtensionContext): () => void {
  // 状态栏项：右侧、优先级 100（排在常规状态信息之上，不抢最右）
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  // 键 = 英文原文（ADR-042）；`$(shield)` 是 VS Code 图标语法，翻译时须原样保留
  item.text = vscode.l10n.t('$(shield) Memora: project-level assets are off');
  item.tooltip = vscode.l10n.t(
    'Workspace is not trusted, so Memora skips project-level skills and role packs (.memora/). It takes effect once trusted.',
  );
  // 点击直达 VS Code 的「管理工作区信任」（不自己造信任入口）
  item.command = 'workbench.action.manageTrust';
  context.subscriptions.push(item);
  /** 刷新显隐：仅「打开了工作区且未受信任」时显示（无工作区时没有项目级资产可谈） */
  const sync = (): void => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder && !readWorkspaceTrusted()) item.show();
    else item.hide();
  };
  sync();
  return sync;
}
