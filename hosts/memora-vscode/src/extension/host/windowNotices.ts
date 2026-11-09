/**
 * 窗口通知文案的本地化渲染单点（show*Message / modal 面向的文案在此出）
 *
 * 与 `noticeText.ts`（错误 → 通知文本，纯 node 可测）分文件：本文件 import vscode，
 * 会连累纯 node 测试环境——凡**宿主窗口面**的 l10n 文案函数落这里，凡 catch 错误转
 * 文本的纯函数落 noticeText。键 = 英文原文（ADR-042）。
 * 分界：宿主经 post 送进 webview 的通知串**不在**本文件（webview 显示语言归切片 4
 * 收口，见台账 HOST-I18N-2 遗留登记）。
 */
import * as vscode from 'vscode';
import type { LlmErrorCategory } from '@zooique/memora';

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
