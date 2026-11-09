/**
 * 对话面板 · 记忆软删域（自 `chatPanel.ts` 按 op 组外置 · B9-D-5）
 *
 * 职责：两个**软删**入口——对话里对单条记忆的「没用/过时」反馈删除（`deleteMemory`），
 * 与问答闭环物理回收后对 `round-summary` 的联动软删（`softDeleteSessionMemories`）。
 * 共同语义是「把记忆移入回收站（可恢复），失败不阻断主流程」：单条走确认框、联动走降级静默，
 * 但两者的失败降级口径（Agent 未就绪 ⇒ 跳过 / 异常 ⇒ 只记录）必须是同一份理解，故同域承载。
 *
 * 与设置页 `settingsMemoryOps.ts` 的分工：那边的删除是**记忆管理语境**（删完要刷新列表与治理统计），
 * 这边的删除是**对话语境**（只回 `memory_deleted` 让 chat 视图摘行），文案与副作用都不同——
 * 只有「一行内核调用」相同，共享抽象的成本高于各写一份，故不合并。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { confirmModal } from '../../extension/host/ui/confirmModal.js';
import { toNoticeText } from '../../extension/host/noticeText.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 记忆软删域的注入面（唯一构造点 = 面板字段初始化处） */
export interface ChatMemoryOpsDeps {
  /** 向 webview 投递协议消息（面板 `post` 单点） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 当前显示会话实例（联动软删的降级判据：未就绪即跳过） */
  getAgent: () => Agent | undefined;
  /** 取已装配实例；未装配时提示并返回 undefined */
  getAgentOrWarn: () => Promise<Agent | undefined>;
}

/** 记忆软删域对外方法（与面板私有方法一一对应） */
export interface ChatMemoryOps {
  deleteMemory(id: string): Promise<void>;
  softDeleteSessionMemories(removedIds: string[]): void;
}

/**
 * 构造记忆软删域
 *
 * @param deps 面板注入的窄接口（见 {@link ChatMemoryOpsDeps}）
 */
export function createChatMemoryOps(deps: ChatMemoryOpsDeps): ChatMemoryOps {
  return {
    /**
     * 记忆反馈删除（HOST-S3-3）：对话面板命中行 ✕ → 模态确认后软删。
     *
     * 复用内核软删契约 `agent.memory.writeDelete(id)`（进入回收站，可恢复）；应答
     * `memory_deleted` 驱动 webview 摘除；取消确认不推送（同款契约）。
     */
    async deleteMemory(id: string): Promise<void> {
      const agent = await deps.getAgentOrWarn();
      const memory = agent?.memory ?? undefined;
      if (!memory) {
        deps.post({
          type: 'memory_deleted',
          ok: false,
          id,
          message: vscode.l10n.t('The Agent is not ready; cannot delete the memory'),
        });
        return;
      }
      const confirmed = await confirmModal({
        message: vscode.l10n.t(
          'Mark this memory as useless and move it to the recycle bin? You can restore it at any time in memory management.',
        ),
        confirmLabel: vscode.l10n.t('Delete'),
      });
      if (!confirmed) return;
      try {
        memory.writeDelete(id);
        deps.post({ type: 'memory_deleted', ok: true, id });
      } catch (err) {
        deps.post({ type: 'memory_deleted', ok: false, id, message: toNoticeText(err) });
      }
    },

    /**
     * 随问答闭环物理删除联动软删记忆摘要。
     *
     * 触发语义：Round 引用归 0 被物理回收 → 该轮 round-summary 软删。软删除走现有回收站
     * （deletedAt），恢复后为无溯源独立记忆（脱钩在删除时完成）。
     *
     * 会话级摘要不在此列：它不进记忆库，而存于 SessionMeta（summary/keyTopics），
     * 随 deleteSession 一并删除，无需联动。
     * 降级优先：Agent 未就绪 / 记忆操作异常不阻塞删除主流程。
     *
     * @param removedIds 被物理删除的 Round ID 列表（可空）
     */
    softDeleteSessionMemories(removedIds: string[]): void {
      if (removedIds.length === 0) return;
      const memory = deps.getAgent()?.memory;
      if (!memory) return; // Agent 未就绪：降级跳过（记忆遗留不影响会话删除主流程）
      try {
        memory.softDeleteRoundSummaries(removedIds);
      } catch (err) {
        // 联动失败仅记录：记忆软删属后台治理，不阻断会话删除（SSOT 不藏错）
        console.warn('Memora linked memory soft-delete failed (degraded: memories remain)', err);
      }
    },
  };
}
