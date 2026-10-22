/**
 * 交互提醒（attention）—— 判据与去重的**纯逻辑单点**（HOST-ATTN-1）
 *
 * 输出面现行只有一条：**提示音**（失焦时短促一声，离屏可感知）。
 *
 * 🔴 为什么不是系统 toast（2026-10-22 真机实证，勿回改）：
 *   借用 `Microsoft.VisualStudioCode` 的 AUMID 从外部进程发 WinRT toast，`Show()` 返回
 *   成功、载荷完整入库（`wpndatabase.db` 可查 12 条），但**既不上屏也不进操作中心**——
 *   AUMID 快捷方式不属于发起进程，系统把通知路由给 VS Code 自己的通知处理器后丢弃。
 *   该失败是静默的（无抛错、无日志），`catch` 兜底与失败日志永远不会触发。大厂插件的
 *   对照（Cline / Roo Code）：同样不做系统通知，只用音效 + 窗口内承接面；能做系统通知
 *   的 Trae / Cursor 是 IDE fork 而非插件。要真正做通，必须像 node-notifier/SnoreToast
 *   那样在开始菜单注册**自有** AUMID 快捷方式（需随扩展分发二进制）——未立项前，
 *   本模块不得重新引入 toast 通道。
 *
 * 判据只有一条：**窗口聚焦 ⇒ 什么都不发**。有焦点意味用户就在 VS Code 里，面板内按钮
 * 即可见面；此时再响提示音是打扰，且与面板按钮重复。
 *
 * 🔴 红线：**同事件只响一次**。确认卡重复推出 / ask 两次进入等待 / done 重入，不得连响。
 *
 * 与 `status-dock` 未读徽记的分工：徽记表达「面板里有东西没看」（面板内可见），本模块
 * 表达「VS Code 在外面，有事情发生了」（离屏可听）。两者不互相替代。
 *
 * ⚠️ 已知边界（明写，勿当缺陷重提）：面板折叠但**窗口有焦点**时本模块不响——承接面是
 * 面板内按钮，用户需自己展开面板。这是「不打扰」的代价，不是漏判。
 *
 * 本模块**不 import vscode**（依赖全注入）——宿主 host 层纪律，单测无需 mock vscode；
 * vscode 适配见 `vscodeAttention.ts`。
 */

/** 事件种类：仅用于去重键前缀（声音不区分事件，三类同一音效） */
export type AttentionKind = 'confirm' | 'ask' | 'settled';

export interface AttentionDeps {
  /**
   * 当前 VS Code 窗口是否聚焦（注入 `vscode.window.state.focused`）
   *
   * 聚焦 ⇒ 不发任何提醒：承接面（审批卡 / ask 卡 / 文件改动条按钮）就在面板里，
   * 再响提示音属于重复表达 + 打扰。
   */
  isWindowFocused: () => boolean;
  /** 提示音（注入 `createSystemSoundPlayer()`；缺省 = 不响，用于测试与其它宿主） */
  playSound?: () => void;
}

export interface AttentionNotifier {
  /** 审批卡已推出 */
  onConfirmShown(info: { requestId: string }): void;
  /** ask 进入等待 */
  onAskWaiting(info: { question: string }): void;
  /** 本轮正常收场（done；暂停与中断不算完成，调用方不应调本方法） */
  onRoundSettled(info: { roundId: string }): void;
}

/** 提示音去重表容量上限：长会话防无界增长（超限丢最早，等价 FIFO） */
const SEEN_MAX = 200;

export function createAttentionNotifier(deps: AttentionDeps): AttentionNotifier {
  /** 已响过的事件键（同一确认卡 / 同一提问 / 同一轮不重复响） */
  const seenKeys = new Set<string>();

  /** 记一次事件键；返回 true = 首次（应响），false = 已响过 */
  function firstTime(key: string): boolean {
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    if (seenKeys.size > SEEN_MAX) {
      const oldest = seenKeys.values().next().value;
      if (oldest !== undefined) seenKeys.delete(oldest);
    }
    return true;
  }

  function requestAttention(kind: AttentionKind, key: string): void {
    // 🔴 增值能力边界：注入面任何一个同步抛错都在这里收敛。调用方包含确认卡路径
    // （`confirmCoordinator.onConfirmShown` 是同步直调）——提醒失败绝不能把审批卡打掉。
    try {
      // 判据单点：聚焦 = 用户就在 VS Code 里，面板内按钮即承接面
      if (deps.isWindowFocused()) return;
      if (!deps.playSound) return;
      if (!firstTime(key)) return;
      deps.playSound();
    } catch {
      // 静默：提醒失败不产生任何用户可见面（也没有更合适的报告通道——报告本身就会再走提醒）
    }
  }

  return {
    onConfirmShown: (info) => requestAttention('confirm', `confirm:${info.requestId}`),
    // 去重键用提问原文：同一提问重复进入等待（覆写式 setPending + armAskTimeout 两次调用）
    // 只响一次；不同轮撞同一提问则不响（低频，可接受）
    onAskWaiting: (info) => requestAttention('ask', `ask:${info.question}`),
    onRoundSettled: (info) => requestAttention('settled', `settled:${info.roundId}`),
  };
}
