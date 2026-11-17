/**
 * 启动会话对齐（CHATPANEL-EXTRACT-1 外置）
 *
 * 面板装配好 Agent 后，把内核当前会话切到面板认定的目标；不一致且切换失败时，
 * 通过注入的 `postError` 回传错误提示。逻辑从 `chatPanel` 原样搬来，语义零变化。
 *
 * 外置判据三条：① 无状态（无模块级可变字段）；② 不直接 post / 不写盘——错误提示
 * 以 `postError` 回调回传；③ 只读写参数（agent、目标 id、回调即全部契约，不读 this）。
 * 「判据不可得就不猜、失败必须可见」的纪律保留在下方注释与实现里。
 *
 * @module sessionStartupAlign
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { toNoticeText } from '../../extension/host/noticeText.js';

const { l10n } = vscode;

/**
 * @returns 已对齐 / 判据不可得（静默跳过）时返回 void；切换失败会调用 postError
 */
export async function alignKernelSessionTo(
  agent: Agent,
  target: string | undefined,
  postError: (message: string) => void,
): Promise<void> {
  const sm = agent.sessionManager;
  if (!target || !sm) return;
  let kernelCurrent: string | null = null;
  try {
    const info = sm.getCurrentSessionInfo();
    kernelCurrent = info ? `${info.date}-${info.session}` : null;
  } catch {
    kernelCurrent = null;
  }
  if (kernelCurrent === null || kernelCurrent === target) return;
  try {
    await sm.switchToSession(target);
  } catch (err) {
    postError(l10n.t('Failed to align the startup session: {0}', toNoticeText(err)));
  }
}
