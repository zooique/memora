/**
 * 收回本会话（撤销助手代理，回到「我自己聊」）的实现域
 *
 * 为什么外置：`chatPanel.ts` 已贴 `max-lines` 只降不升基线，而本次要在收回成功之后补两件
 * 「用户可感知」的事（侧栏形态同步回自助、把收不回的托管事实说清），留在面板里必然挤掉
 * 既有注释；按 B9-D 既有拆法，完整闭环收到 helpers，面板只留一行转发。
 *
 * 事实边界（与收回语义同源，勿扩）：
 *   - 只改**运行期状态**：驱动权清空、有调度权的会话 mode 回 `'self'`；
 *   - 历史轮次的 `origin: 'hosted'`、`SessionMeta.origin`、用户级「上次模式」**一个字节都不动**
 *     （历史只读；`origin` 记的是「最初由谁建立」，收回不擦除归属；收回这一笔 ≠ 改新建默认值）；
 *   - 判据只看「当前是否由代理支配」（`isAgentControlled`），不看出生记录——代理开的子会话
 *     没有调度权，但收回前仍归代理，必须允许收回；
 *   - 在跑时拒绝收回（close 会打断在途回答，不拿用户正在看的回答当代价）。
 *
 * 工具面为什么必须重装：主控工具在**装配期**注册进实例，改 mode 不会摘掉已有实例的工具面
 * ⇒ 先回收（登记表 unregister + close），再按新 mode 重新装配并换绑显示源。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import type { SessionMode } from '../../extension/host/sessionModeStore.js';
import { toNoticeText } from '../../extension/host/noticeText.js';

// 本模块文案走 l10n（与面板同一套键面）
const { l10n } = vscode;

/**
 * 收回实现依赖（全部由面板注入的延迟闭包；本模块不持有面板实例）
 *
 * 全部是闭包而非实例：面板字段初始化早于部分成员可用的时刻，构造期捕获实例会拿到 undefined。
 */
export interface RevokeManagedSessionDeps {
  /** 会话模式容器（装配身份 + 当前驱动权的唯一真源） */
  sessionModes: {
    /** 当前是否由代理支配（托管座位 ∪ 代理驱动） */
    isAgentControlled: (sessionId: string) => boolean;
    /** 登记装配模式（收回 = 写 `'self'`） */
    set: (sessionId: string, mode: SessionMode) => void;
    /** 清空「当前由代理驱动」 */
    clearAgentDriven: (sessionId: string) => void;
  };
  /** 该会话当前是否在跑流（在途回答不当代价） */
  isStreaming: (sessionId: string) => boolean;
  /** 当前显示会话（形态只对眼前这一屏翻） */
  currentSessionId: () => string;
  /** 摘掉本地投影表里的实例（生命周期唯一入口在登记表，见 `agentForSession`） */
  forgetAgent: (sessionId: string) => void;
  /** 回收旧实例（登记表注销 + close）；未注入时返回 undefined */
  releaseAgent: (sessionId: string) => Promise<void> | undefined;
  /** 按新 mode 重新装配该会话 */
  assemble: (sessionId: string) => Promise<Agent>;
  /** 换绑显示源 */
  bindAgent: (agent: Agent) => void;
  /** 重装失败时清空显示源（对齐 `performAgentAssembly` 的失败口径） */
  resetDisplayedAgent: () => void;
  /** 投递一条面板通知（`post` 单点） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 就地回自助形态（含 context key 与 `ui_form` 两处同步，不换会话） */
  forceSelfForm: () => void;
  /** 该会话开出去的子会话（创建者账本，仅本进程） */
  childrenOf: (sessionId: string) => readonly string[];
  /** 该创建者名下尚未浮现的落定汇报条数（收回后不会再送到这里） */
  pendingReportCount: (creator: string) => number;
  /** 子会话是否仍在跑流（与工作台同一判据） */
  isChildStreaming: (sessionId: string) => boolean;
}

/**
 * 收回域外露面（面板只依赖这一层，不直接碰实现函数）
 */
export interface RevokeManagedSessionOps {
  /** 收回本会话（语义见 `revokeManagedSessionWith`） */
  revoke: (sessionId?: string) => Promise<boolean>;
}

/**
 * 建收回域
 *
 * @param deps 面板注入的读口与动作口
 * @returns 收回域实例
 */
export function createRevokeManagedSessionOps(
  deps: RevokeManagedSessionDeps,
): RevokeManagedSessionOps {
  return { revoke: (sessionId) => revokeManagedSessionWith(deps, sessionId) };
}

/**
 * 收回本会话：把当前会话从助手代理名下撤下
 *
 * 顺序不可换：① 先改运行期状态，重装才读到 `self` / 非驱动；② 旧实例必须先摘表再回收，
 * 否则 `agentForSession` 命中旧实例，工具面原样保留（mode 变了但模型仍能派发）。
 *
 * 收回成功后就地做两件事（真机验收暴露的两处「界面与事实不一致」）：
 *   - 侧栏形态同步回**自助**：否则输入框仍是助手外观与占位，用户以为还在跟助手说话；
 *   - 若还有它派出去、仍在跑的会话或压在待办里的落定汇报，**如实说明它们不会再报回这里**，
 *     不让用户以为收回之后这些结果还会送到眼前。
 *
 * @param deps 面板注入的读口与动作口
 * @param sessionId 目标会话（缺省 = 当前显示会话）
 * @returns 是否真的撤销并重装（false = 草稿 / 本来就是用户自己的 / 正在运行 / 重装失败）
 */
export async function revokeManagedSessionWith(
  deps: RevokeManagedSessionDeps,
  sessionId?: string,
): Promise<boolean> {
  const sid = sessionId ?? deps.currentSessionId();
  if (!sid) {
    void vscode.window.showInformationMessage(l10n.t('Memora: open a session first.'));
    return false;
  }
  // 当前归谁 = 一个判断点：有调度权（用户亲自选的托管）或当前由代理驱动，都允许收回
  if (!deps.sessionModes.isAgentControlled(sid)) {
    void vscode.window.showInformationMessage(l10n.t('Memora: this session is already yours.'));
    return false;
  }
  if (deps.isStreaming(sid)) {
    void vscode.window.showWarningMessage(
      l10n.t('Memora: the session is running; take it back after it finishes.'),
    );
    return false;
  }
  // ① 先落运行期事实（重装读的是这一份）；② 摘表 → 回收 → 重装（顺序理由见函数头）
  deps.sessionModes.set(sid, 'self');
  deps.sessionModes.clearAgentDriven(sid);
  // 形态与归属同步：只翻当前显示会话这一屏（收回别的会话不动眼前这一页）
  if (deps.currentSessionId() === sid) deps.forceSelfForm();
  deps.forgetAgent(sid);
  await deps.releaseAgent(sid);
  try {
    const agent = await deps.assemble(sid);
    // 只换绑当前显示会话；非显示会话下次切入时自然按新实例绑定
    if (deps.currentSessionId() === sid) deps.bindAgent(agent);
  } catch (err) {
    // 重装失败：旧实例已 close，不能留在显示源里被当活实例用；清空装配缓存让下一次重新装配
    deps.resetDisplayedAgent();
    deps.post({ type: 'notice', level: 'error', message: toNoticeText(err) });
    return false;
  }
  reportWhatCannotBeDelivered(deps, sid);
  void vscode.window.showInformationMessage(
    l10n.t('Memora: the assistant has stepped back; this session is yours again.'),
  );
  return true;
}

/**
 * 说明「收回后不再送到这条会话」的两类事实
 *
 * 两类都只在**确实存在**时各说一句（没有就不说，不拿空话凑提示）：
 *   - 它派出去、仍在跑的会话：收场通知的判据含「创建者仍是托管」，收回后不再投递；
 *   - 压在待办里的落定汇报：同上，不会再浮现到这条会话。
 *
 * @param deps 面板注入的读口
 * @param sid 刚被收回的会话
 */
function reportWhatCannotBeDelivered(deps: RevokeManagedSessionDeps, sid: string): void {
  // 仍在跑的子会话数（按运行态真源，不猜、不按历史轮状态推断）
  const running = deps.childrenOf(sid).filter((child) => deps.isChildStreaming(child)).length;
  if (running > 0) {
    deps.post({
      type: 'notice',
      level: 'info',
      message: l10n.t(
        'Memora: taken back. {0} dispatched session(s) are still running; their results will no longer be reported to this session.',
        String(running),
      ),
    });
  }
  // 尚未送出的落定汇报（进程内待办队列；重启即丢，不补发）
  const pending = deps.pendingReportCount(sid);
  if (pending > 0) {
    deps.post({
      type: 'notice',
      level: 'info',
      message: l10n.t(
        'Memora: taken back. {0} settlement report(s) have not been delivered and will not be sent to this session.',
        String(pending),
      ),
    });
  }
}
