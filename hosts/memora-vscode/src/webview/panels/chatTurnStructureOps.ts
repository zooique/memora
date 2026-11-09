/**
 * 对话面板 · 问答结构破坏性操作域（自 `chatPanel.ts` 按 op 组外置 · B9-D-3）
 *
 * 职责：`delete_turn`（删除该问答及之后所有轮）与 `regenerate`（重新生成）共用的
 * **截断核**——同锚点、同截断面、同强度确认，唯一差异是确认文案与按钮词（调用方传入）。
 *
 * 为什么外置：
 *   1. `chatPanel.ts` 行数贴死 `max-lines`；这一组是**一条完整的小链路**
 *      （运行时守卫 → 确认 → store 截断 → 现场作废 → 联动软删 → 重放），
 *      与面板的装配 / 流控制只在 `deps` 上相交，按语义切得开；
 *   2. 「截断核只许有一份」是既有契约（`delete_turn` 与 `regenerate` 共用），
 *      把它与面板状态解耦后，第二位调用方失去复制正文的动机。
 *
 * 注入纪律：`deps` 全部是**读/写面板状态的窄闭包**，本模块不持有 provider 实例；
 * 两个确认文案由调用方本地化后传入（文案与破坏面一一对应，不在核里按 reason 猜）。
 */
import * as vscode from 'vscode';
import { splitSessionId } from '@zooique/memora';
import { confirmModal } from '../../extension/host/ui/confirmModal.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 截断核的注入面（唯一构造点 = 面板字段初始化处） */
export interface ChatTurnStructureOpsDeps {
  /** 向 webview 投递协议消息（面板 `post` 单点） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 当前会话是否正在跑流（截断类操作只拦这一种，导航不设此闸） */
  isStreaming: () => boolean;
  /** 当前显示会话 id（空串 = 草稿期；截断只在真实会话发生） */
  getCurrentSessionId: () => string;
  /** 宿主扩展的会话存储（`truncateFrom` 为宿主侧扩展，内核接口保持最小化） */
  sessionStore: { truncateFrom(date: string, session: string, roundId: string): TruncateResult };
  /** 现场作废：清掉软暂停刻意保留的 live 缓冲（防已删轮被重放并回） */
  discardLiveBuffer: () => void;
  /** 联动软删被物理回收轮次的记忆摘要 */
  softDeleteMemories: (removedIds: string[]) => void;
  /** 重放当前会话，保证 UI 与存储一致 */
  replaySession: () => void;
}

/** `sessionStore.truncateFrom` 的结果形态（宿主侧契约） */
export interface TruncateResult {
  ok: boolean;
  removedIds: string[];
  removedUserText?: string;
}

/** 截断核结果：ok = 是否**实际完成截断**；reason 供调用方决定是否给可见反馈 */
export type TruncateOutcome =
  { ok: true; userText?: string } | { ok: false; reason: 'busy' | 'cancel' | 'miss' | 'error' };

/** 问答结构操作域对外方法 */
export interface ChatTurnStructureOps {
  truncateTurnCore(
    roundId: string,
    confirmMessage: string,
    confirmButton: string,
  ): Promise<TruncateOutcome>;
  deleteTurnFrom(roundId: string): Promise<void>;
}

/**
 * 「锚未命中 / 截断异常」的统一用户提示（删除与重新生成共用）
 *
 * 两个入口同核、文案各写一份必漂移；且「点了没反应」是最难排障的形态——失败必须可见。
 * 导出给面板的 regenerate 分支复用（同一句话，不复制字面量）。
 */
export function truncateFailNotice(): string {
  return vscode.l10n.t(
    'Could not locate that turn (the session may have changed); refresh the session and try again',
  );
}

/**
 * 构造问答结构操作域
 *
 * @param deps 面板注入的窄接口（见 {@link ChatTurnStructureOpsDeps}）
 */
export function createChatTurnStructureOps(deps: ChatTurnStructureOpsDeps): ChatTurnStructureOps {
  /**
   * 截断核：从锚点轮截断该问答及之后所有（对齐主流 truncate-from-turn——删该问答及其后
   * 全部轮，保证剩余上下文自洽）。锚 = 目标轮 `Round.id`，调宿主 `sessionStore.truncateFrom`
   * （宿主 ISessionStore 扩展，内核接口保持最小化），成功后重放当前会话刷新 UI。
   * 锚 = roundId 而非 ts（DELETE-ANCHOR-1）。
   *
   * @returns ok = 是否**实际完成截断**（取消 / 守卫 / 锚未命中 / 异常一律 false——此前恒 true，
   *          与契约相反，调用方会把「没删」当「删了」续做）；reason = 失败归类（busy 已自带
   *          提示 / cancel 应静默 / miss·error 必须由调用方给可见反馈，否则就是神秘失灵）；
   *          userText = 截断起点 Round 的 user 原文（regenerate 重发真源）
   */
  async function truncateTurnCore(
    roundId: string,
    confirmMessage: string,
    confirmButton: string,
  ): Promise<TruncateOutcome> {
    // 运行时守卫：**只拦截断类**（删除 / 重新生成会重写会话文件，与在途落盘冲突）；导航不设此闸
    if (deps.isStreaming()) {
      deps.post({
        type: 'notice',
        level: 'info',
        message: vscode.l10n.t(
          'A response is being generated; wait before changing the conversation',
        ),
      });
      return { ok: false, reason: 'busy' };
    }
    // 破坏性操作：确认不可恢复（与「清空对话」同强度确认）
    const confirmed = await confirmModal({ message: confirmMessage, confirmLabel: confirmButton });
    if (!confirmed) return { ok: false, reason: 'cancel' };
    try {
      // sessionId 格式契约 SSOT：内核 splitSessionId 拆解（session 名可含连字符）
      const { date, session } = splitSessionId(deps.getCurrentSessionId());
      const result = deps.sessionStore.truncateFrom(date, session, roundId);
      // 锚未命中（会话已改动 / 旧 DOM 残留锚）= 什么都没删：既不伪装成功也不重放（存储未变）
      if (!result.ok) return { ok: false, reason: 'miss' };
      // 盘面已删 ⇒ 现场必须立刻作废（先于任何后续步骤，异常路径也不得复活已删内容）：
      // 被删轮可能还在软暂停刻意保留的 live 现场（pausedOnPurpose）里，重放会并回其 seedUserMessage
      deps.discardLiveBuffer();
      // 联动软删回收站（轮次摘要；会话级不联动——会话仍在）
      deps.softDeleteMemories(result.removedIds);
      // 截断后重放当前会话（消息已减少），保证 UI 与存储一致
      deps.replaySession();
      return { ok: true, userText: result.removedUserText };
    } catch (err) {
      // 截断失败不阻塞展示（仅清理 UI），但需记录（SSOT 不藏错）
      console.warn('Memora truncate turn failed', err);
      return { ok: false, reason: 'error' };
    }
  }

  return {
    truncateTurnCore,

    /** 删除该问答及之后所有对话（`delete_turn` 入口；确认文案是本入口语义的一部分） */
    async deleteTurnFrom(roundId: string): Promise<void> {
      const outcome = await truncateTurnCore(
        roundId,
        vscode.l10n.t('Delete this turn and all later turns? This cannot be undone.'),
        vscode.l10n.t('Delete'),
      );
      if (!outcome.ok && (outcome.reason === 'miss' || outcome.reason === 'error')) {
        deps.post({ type: 'notice', level: 'info', message: truncateFailNotice() });
      }
    },
  };
}
