/**
 * IMG-8 宿主兜底 —— 单轮图片三维聚合限额（张数 / 总字节 / token）
 *
 * 判据单点 = `shared/imageTurnLimits`（webview 发送前预检与宿主兜底**同判据**，禁第二份
 * 公式）；token 换算走内核 `imageTokens` 单点（本模块 node 侧，值导入合法，webview 打包
 * 不经过此处）。为什么必须兜底：webview `sendMessage` 清框后才 post，只做 webview 预检时
 * 竞态漏网即静默超限 ⇒ 宿主拒收必须**可见**（静默丢整条 = 背刺）。
 *
 * 本文件是宿主窗口提示的**本地化渲染单点**：按共享层的结构化 `dimension` + 数字渲染
 * `vscode.l10n.t` 文案（键 = 英文原文，ADR-042），不透传共享层的中文散文；
 * webview 预检仍用共享层 `message`（webview 显示语言归切片 4，见台账 HOST-I18N-2）。
 */
import * as vscode from 'vscode';
import { imageTokens, type ImageRef } from '@zooique/memora';
import { checkImageTurnLimits, formatMiB } from '../../shared/imageTurnLimits.js';

/**
 * 三维聚合限额裁决（IMG-8 宿主兜底）。
 *
 * @param attachments 本轮随消息发出的真值 `ref` 列表（调用方已保证非空才调）
 * @param limitTokens 激活 Provider 的窗口上限（宿主经 `resolveContextWindow` 解析；
 *   `undefined` = 未配置 ⇒ token 维跳过，与内核 tokenBudget 口径一致）
 * @returns 放行返回 `undefined`；拒收返回**已本地化**的可见原因（带该维具体数字）
 */
export function imageTurnRejection(
  attachments: readonly ImageRef[],
  limitTokens: number | undefined,
): string | undefined {
  const verdict = checkImageTurnLimits({
    count: attachments.length,
    totalBytes: attachments.reduce((a, r) => a + r.bytes, 0),
    totalTokens: attachments.reduce((a, r) => a + imageTokens(r), 0),
    limitTokens,
  });
  if (verdict.ok) return undefined;
  switch (verdict.dimension) {
    case 'count':
      return vscode.l10n.t(
        'Memora: {0} images this turn exceed the limit of {1}; remove some images and resend',
        verdict.used!,
        verdict.limit!,
      );
    case 'bytes':
      return vscode.l10n.t(
        'Memora: images total {0} MiB, over the 20 MiB limit (by {1} MiB); use fewer or smaller images',
        formatMiB(verdict.used!),
        formatMiB(verdict.over!),
      );
    case 'tokens':
      return vscode.l10n.t(
        'Memora: images use about {0} tokens, over this model limit of {1} (25% of the window, over by {2}); use fewer or smaller images',
        verdict.used!,
        verdict.limit!,
        verdict.over!,
      );
    default:
      // 共享层扩新维未更新本渲染表：原文兜底（fail-visible，宁可中文不静默失义）
      return verdict.message;
  }
}
