/**
 * 交互提醒的 VS Code 适配层（HOST-ATTN-1）
 *
 * 只做一件事：把 `attentionNotice.ts`（纯逻辑、零 vscode 依赖、可单测）需要的三个能力
 * 接到真实 VS Code API 上。判据与文案全在纯逻辑层，本文件**不含任何判断**——薄到不需要
 * 单测，靠 tsc 与真机验收兜底（同 `chatPanel` 内所有 vscode 调用的处理口径）。
 *
 * 相比首版已删两处依赖：`getView`（面板可见性不再参与判据）与 `showInformationMessage`
 * （workbench 通知整层移除，承接面收敛到面板内按钮）。
 */
import * as vscode from 'vscode';
import { ATTENTION_URI, createAttentionNotifier, type AttentionNotifier } from './attentionNotice.js';
import { createSystemToastSender } from './systemToast.js';

/** 构造带 VS Code 宿主的提醒器（无参：判据只需窗口聚焦态，不需要视图实例） */
export function createVscodeAttention(): AttentionNotifier {
  return createAttentionNotifier({
    isWindowFocused: () => vscode.window.state.focused,
    showSystemToast: createSystemToastSender(),
    launchUri: ATTENTION_URI,
  });
}
