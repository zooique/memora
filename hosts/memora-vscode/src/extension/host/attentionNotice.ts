/**
 * 交互提醒（attention）—— 需要用户交互而用户看不见面板时，把他叫回来（HOST-ATTN-1）
 *
 * 分层（判据只有一处，三层动作都从这里出）：
 *   L1 看得见（面板可见 && 窗口聚焦）→ 什么都不做（别打扰正在看的人）
 *   L2 看不见 → workbench prompt toast（带「去处理」按钮；**失焦时持久保留**，
 *      见 microsoft/vscode#80285 / #80456 —— 与无按钮的 info toast 本质区别）
 *   L3 且窗口失焦 → 系统级 toast（VS Code 最小化也可见；同事件只发一次）
 *
 * 🔴 三条红线：
 *   ① **通知里没有「确认/拒绝」按钮**——只有「去处理」。通知能直接批准，用户就没看 diff
 *      就把写入批了，绕过确认卡的内容展示 = fail-closed 安全模型反转（与 confirm 超时
 *      自动拒绝同一原则）。确认动作永远留在卡上。
 *   ② **不自动展开面板、不抢焦点**：`showChatView` 只在用户点「去处理」/ 点系统 toast 后调用。
 *   ③ **看见就不打扰**：判据是「面板可见 && 窗口聚焦」的与，而不是或——面板折叠但 VS Code
 *      有焦点（用户在看别的文件）同样需要提醒。
 *
 * 与 `status-dock` 未读徽记的分工：徽记表达「有东西没看」（面板内可见），本模块表达
 * 「有人在等你」（面板外不可见）。两者不互相替代，也不共用判据。
 *
 * 本模块**不 import vscode**（依赖全注入）——宿主 host 层纪律，单测无需 mock vscode；
 * vscode 适配见 `vscodeAttention.ts`。
 */

/** 通知种类：三类事件的文案与去重键各不同 */
export type AttentionKind = 'confirm' | 'ask' | 'settled';

/** 动作按钮文案（workbench toast 与系统 toast 共用一份，防两处说法漂移） */
export const ATTENTION_ACTION = '去处理';

/**
 * 系统 toast 点击回跳的 URI 三件套（唯一定义处；`vscodeAttention.ts` 与 `extension.ts` 都从这里取）
 *
 * 🔴 authority **必须是扩展 ID = `publisher.name`**（官方 registerUriHandler 契约：
 * "The uri-authority must be the extension id"）。写成短名 `zooique.memora` 会被路由到
 * 一个不存在的扩展 ⇒ 点击 toast 静默空转，且**没有任何报错**（2026-10-22 排雷踩到）。
 * authority 与 package.json 的一致性由 `attentionWiring.test.ts` 双向守卫。
 *
 * 路径拆成 `ATTENTION_PATH` 单独导出：`extension.ts` 的 handler 只比对路径，不该抄一份字面量。
 */
export const ATTENTION_URI_AUTHORITY = 'zooique.memora-vscode';
export const ATTENTION_PATH = '/attention';
export const ATTENTION_URI = `vscode://${ATTENTION_URI_AUTHORITY}${ATTENTION_PATH}`;

/** 为什么用中文常量而不是分散字面量：文案即用户契约，改一处必须改全（含系统 toast 标题） */
const CONFIRM_TITLE = 'Memora 需要你确认';
const ASK_TITLE = 'Memora 在等你回答';
const SETTLED_TITLE = 'Memora 任务完成';
/** 详情缺失时的兜底正文（空串 / 纯空白 / 未传 一律走这里，见 `detailOr`） */
const CONFIRM_FALLBACK = '有写入待批准';
const ASK_FALLBACK = '有一项提问等你回答';
/** ask 提问摘要上限（字符）：toast 一行放不下整段问题 */
const ASK_CLIP = 60;
/** confirm 标签上限（字符）：`工具：文件名` 形态，过长截断 */
const LABEL_CLIP = 60;

export interface AttentionDetail {
  /** confirm：`工具：文件名` 简写（不承载 diff 全文） */
  label?: string;
  /** ask：提问原文 */
  question?: string;
}

export interface AttentionMessage {
  /** 通知标题（系统 toast 首行） */
  title: string;
  /** workbench toast 正文（一行说完：谁 + 要你做什么） */
  message: string;
  /** 系统 toast 第二行（详情摘要） */
  body: string;
}

/** 单行化 + 截断（toast 里换行会破排版；超长由系统中间省略，主动截更可控） */
function clipText(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/**
 * 「有内容就裁剪，没内容就兜底」
 *
 * 🔴 不能用 `detail.label ?? 兜底`：`??` 只挡 `null/undefined`，空串会原样通过 ⇒
 * body 为空、消息尾巴挂一个悬空冒号（「Memora 在等你回答：」）。空串与纯空白都算
 * 没内容——这才是兜底文案存在的意义（实测踩过）。
 */
function detailOr(text: string | undefined, fallback: string, max: number): string {
  return (text === undefined ? '' : clipText(text, max)) || fallback;
}

/** 文案单点（纯函数）：三类的标题 / 消息 / 详情全在这里，调用方不拼字符串 */
export function composeAttention(kind: AttentionKind, detail: AttentionDetail = {}): AttentionMessage {
  if (kind === 'confirm') {
    const label = detailOr(detail.label, CONFIRM_FALLBACK, LABEL_CLIP);
    return { title: CONFIRM_TITLE, message: `${CONFIRM_TITLE}：${label}`, body: label };
  }
  if (kind === 'ask') {
    const question = detailOr(detail.question, ASK_FALLBACK, ASK_CLIP);
    return { title: ASK_TITLE, message: `${ASK_TITLE}：${question}`, body: question };
  }
  return { title: SETTLED_TITLE, message: SETTLED_TITLE, body: '' };
}

export interface AttentionDeps {
  /** 对话视图当前是否可见（注入 `view.visible`；无 view ⇒ false） */
  isViewVisible: () => boolean;
  /** 当前 VS Code 窗口是否聚焦（注入 `vscode.window.state.focused`） */
  isWindowFocused: () => boolean;
  /** 展开并聚焦对话视图（点「去处理」/ 点系统 toast 后调用） */
  showChatView: () => void;
  /** workbench 通知（注入 `vscode.window.showInformationMessage`） */
  showInfoMessage: (message: string, action: string) => PromiseLike<string | undefined>;
  /**
   * 系统 toast（注入 `createSystemToastSender()`；缺省 = 不发）
   *
   * 只在**窗口失焦**时调用——有焦点时 workbench toast 已经可见，叠一条系统通知是纯打扰。
   */
  showSystemToast?: (payload: { title: string; body: string; launchUri: string }) => void;
  /** 系统 toast 点击回跳的协议地址（`vscode://...`，由 extension 的 URI handler 承接） */
  launchUri: string;
}

export interface AttentionNotifier {
  /** 审批卡已推出 */
  onConfirmShown(info: { requestId: string; label: string }): void;
  /** ask 进入等待 */
  onAskWaiting(info: { question: string }): void;
  /** 本轮正常收场（done；暂停与中断不算完成，调用方不应调本方法） */
  onRoundSettled(info: { roundId: string }): void;
}

/** 系统 toast 去重表容量上限：长会话防无界增长（超限丢最早，等价 FIFO） */
const SEEN_MAX = 200;

export function createAttentionNotifier(deps: AttentionDeps): AttentionNotifier {
  /**
   * 已发过系统 toast 的事件键（同一确认卡 / 同一提问 / 同一轮不重复弹）
   */
  const seenSystemKeys = new Set<string>();

  /** 记一次事件键；返回 true = 首次（应发），false = 已发过 */
  function firstTime(key: string): boolean {
    if (seenSystemKeys.has(key)) return false;
    seenSystemKeys.add(key);
    if (seenSystemKeys.size > SEEN_MAX) {
      const oldest = seenSystemKeys.values().next().value;
      if (oldest !== undefined) seenSystemKeys.delete(oldest);
    }
    return true;
  }

  function requestAttention(kind: AttentionKind, detail: AttentionDetail, key: string): void {
    // 🔴 增值能力边界：注入面（`isViewVisible` / `showInfoMessage` / `showChatView` /
    // `showSystemToast`）任何一个同步抛错都在这里收敛。调用方包含确认卡路径
    // （`confirmCoordinator.onConfirmShown` 是同步直调）——通知失败绝不能把审批卡打掉。
    try {
      // L1：看得见就不打扰（判据单点：可见 与 聚焦 都为真才叫「看得见」）
      if (deps.isViewVisible() && deps.isWindowFocused()) return;
      const composed = composeAttention(kind, detail);
      // L2：workbench prompt toast。失焦时它不自动消失（官方 prompt 语义），切回即见。
      // 必须 `Promise.resolve` 包一层：注入面契约是 `PromiseLike`（vscode Thenable 无 `.catch`），
      // 而这里需要挂 catch——注入替身 reject 时不得产生未处理拒绝。
      void Promise.resolve(deps.showInfoMessage(composed.message, ATTENTION_ACTION))
        .then((picked) => {
          if (picked === ATTENTION_ACTION) deps.showChatView();
        })
        .catch(() => undefined);
      // L3：系统 toast——仅失焦，且同一事件只发一次
      if (!deps.isWindowFocused() && deps.showSystemToast && firstTime(key)) {
        deps.showSystemToast({ title: composed.title, body: composed.body, launchUri: deps.launchUri });
      }
    } catch {
      // 静默：通知失败不产生任何用户可见面（也没有更合适的报告通道——报告本身就会再走通知）
    }
  }

  return {
    onConfirmShown: (info) =>
      requestAttention('confirm', { label: info.label }, `confirm:${info.requestId}`),
    // 去重键用提问原文：同一提问重复进入等待（覆写式 setPending + armAskTimeout 两次调用）
    // 只弹一次系统 toast；不同轮撞同一提问则不弹（低频，且 L2 toast 仍会发）
    onAskWaiting: (info) => requestAttention('ask', { question: info.question }, `ask:${info.question}`),
    onRoundSettled: (info) => requestAttention('settled', {}, `settled:${info.roundId}`),
  };
}
