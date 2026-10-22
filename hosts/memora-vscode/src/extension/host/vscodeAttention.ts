/**
 * 交互提醒的 VS Code 适配层（HOST-ATTN-1）
 *
 * 只做一件事：把 `attentionNotice.ts`（纯逻辑、零 vscode 依赖、可单测）需要的两个能力
 * 接到真实宿主上。判据全在纯逻辑层，本文件**不含任何判断**——薄到不需要单测，靠 tsc
 * 与真机验收兜底（同 `chatPanel` 内所有 vscode 调用的处理口径）。
 *
 * 历代减法（勿回改）：
 *   - 首版 `getView`（面板可见性不参与判据）；
 *   - 二版 `showInformationMessage`（workbench 通知整层移除，承接面收敛到面板内按钮）；
 *   - 三版 `systemToast`（借 AUMID 的 WinRT toast 被系统静默丢弃，2026-10-22 实证退役，
 *     详见 `attentionNotice.ts` 头注释），输出面收敛为系统提示音。
 */
import * as vscode from 'vscode';
import { createAttentionNotifier, type AttentionNotifier } from './attentionNotice.js';
import { createSystemSoundPlayer } from './systemSound.js';

/** 构造带 VS Code 宿主的提醒器（无参：判据只需窗口聚焦态，不需要视图实例） */
export function createVscodeAttention(): AttentionNotifier {
  return createAttentionNotifier({
    isWindowFocused: () => vscode.window.state.focused,
    playSound: createSystemSoundPlayer(),
  });
}
