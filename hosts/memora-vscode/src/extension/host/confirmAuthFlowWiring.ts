/**
 * confirmAuthFlowWiring — 授权流装配工厂（chatPanel `max-lines` 过闸拆法）
 *
 * 为什么外置：`chatPanel.ts` 贴 `max-lines` 基线（只降不升），授权流的**装配闭包**
 * （判据 getter / 展示名取法 / 叫醒链路 / 四段文案）与 authFlow 域逻辑（confirmAuthFlow.ts）
 * 是两件事——域逻辑已外置，装配闭包再外置一处，面板只留实例化几行。
 *
 * 依赖全部延迟闭包：面板不向外泄露实例，工厂不持有面板类型（窄入参，与
 * `hostedDispatchRun.ts` 的 HostedDispatchDeps 同一拆法）。
 *
 * @module confirmAuthFlowWiring
 */

import * as vscode from 'vscode';
import { getSessionDisplayName } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import type { HostedDispatchResult } from './workSessionTools.js';
import { ConfirmAuthFlow } from './confirmAuthFlow.js';

/** 面板注入的窄依赖（全部延迟闭包；语义见 ConfirmAuthFlowDeps 对应字段注释） */
export interface AuthFlowWiringDeps {
  /** 该会话当前是否由代理驱动（真源 = sessionModes.isAgentControlled，与确认卡同一闭包） */
  isAgentDrivenSession: (sessionId: string) => boolean;
  /** 托管座位会话 id（undefined = 本进程无托管座位，授权流整体不启用） */
  getManagedSeatId: () => string | undefined;
  /** 面板当前显示会话（座位是否前台 = 与 getManagedSeatId 对比） */
  currentForeground: () => string;
  /** 会话元数据读口（展示名取法的原料；取不到 = 返回会话 id 兜底） */
  getMeta: (sessionId: string) => Parameters<typeof getSessionDisplayName>[0] | undefined;
  /** 消息投递单点（chatPanel 既有 `this.post`） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 离屏提醒（复用确认卡同钩子；去重键 auth_ 前缀自隔离） */
  onAttention?: (info: { requestId: string; label: string }) => void;
  /**
   * 叫醒代理（面板实现 = `dispatchHostedInput(座位 → 目标)`：身份/判忙/写锁/origin='hosted'
   * 全走既有链路）。senderName 由工厂闭包携带（单一真源 HOSTED_SENDER_NAME 经面板传入）。
   */
  dispatch: (
    seatId: string,
    targetSessionId: string,
    text: string,
    senderName: string,
  ) => Promise<HostedDispatchResult>;
}

/**
 * 装配授权流实例（chatPanel `_authFlow` 字段的唯一构造点）
 *
 * @param deps       面板窄依赖
 * @param senderName 托管发送者名（单一真源 `HOSTED_SENDER_NAME`，面板传入——叫醒轮
 *   落盘 `RoundMessage.name` 与 send_to_session 装配同源）
 */
export function createChatPanelAuthFlow(deps: AuthFlowWiringDeps, senderName: string): ConfirmAuthFlow {
  return new ConfirmAuthFlow({
    isAgentDrivenSession: deps.isAgentDrivenSession,
    getManagedSeatId: deps.getManagedSeatId,
    currentForeground: deps.currentForeground,
    // 展示名取法与工作台同款（assemble）：内核单点 getSessionDisplayName，取不到退会话 id
    getSessionLabel: (sessionId) => {
      const meta = deps.getMeta(sessionId);
      return (meta && getSessionDisplayName(meta)) || sessionId;
    },
    post: deps.post,
    onAttention: deps.onAttention,
    wakeAgent: (targetSessionId, text) => {
      const seatId = deps.getManagedSeatId();
      // 座位缺失在 maybeDefer 已拦（判据③）；此闭包防御兜底，不该到达
      if (seatId === undefined) {
        return Promise.resolve({ ok: false, code: 'E_DENIED', message: 'no managed seat' });
      }
      return deps.dispatch(seatId, targetSessionId, text, senderName);
    },
    words: {
      // 文案在调用时刻取（l10n 不得模块顶层求值，见 confirmTimeoutNotice 先例）
      authorized: () => vscode.l10n.t('Authorized'),
      authorizationDenied: () => vscode.l10n.t('Authorization denied'),
      wakeApproved: (command) =>
        vscode.l10n.t(
          'The user approved running "{0}". Please continue the task with it.',
          command,
        ),
      wakeDenied: (command) =>
        vscode.l10n.t(
          'The user denied running "{0}". Do not retry it; use another approach or finish this step.',
          command,
        ),
    },
  });
}
