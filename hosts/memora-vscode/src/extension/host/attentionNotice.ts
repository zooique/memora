/**
 * 交互提醒（attention）—— VS Code 在后台/最小化时，把用户叫回来（HOST-ATTN-1）
 *
 * **只有一条通道**：窗口失焦时发**系统 toast**（Windows 右下角，VS Code 最小化也可见）。
 * 面板内已有承接面（审批卡 / ask 卡 / `file-changes-bar` 的「全部确认 · 全部回退」按钮），
 * 故**不再叠 workbench 通知**——同一个动作给两处按钮是重复表达，用户明确要求收敛到面板内
 * （2026-10-22 定案，原 L2 `showInformationMessage` 已删）。
 *
 * 判据只有一条：**窗口聚焦 ⇒ 什么都不发**。有焦点意味用户就在 VS Code 里，面板内按钮即
 * 可见面；此时再弹系统通知是打扰，且与面板按钮重复。
 *
 * 🔴 三条红线：
 *   ① **通知里没有任何按钮**：系统 toast 只能被点开（回跳视图），**永不表达「批准/拒绝」**。
 *      能从通知直接批准，用户就没看 diff 就把写入批了 = 绕过确认卡的内容展示 = fail-closed
 *      安全模型反转（与 confirm 超时自动拒绝同一原则）。
 *   ② **不自动展开、不抢焦点**：展开只发生在用户点 toast 之后（`extension.ts` 的 URI handler）。
 *   ③ **同事件只发一次**：确认卡重复推出 / ask 两次进入等待 / done 重入，都不得连弹。
 *
 * 与 `status-dock` 未读徽记的分工：徽记表达「面板里有东西没看」（面板内可见），本模块表达
 * 「VS Code 在外面，有人在等你」（面板外不可见）。两者不互相替代。
 *
 * ⚠️ 已知边界（明写，勿当缺陷重提）：面板折叠但**窗口有焦点**时本模块不发通知——承接面是
 * 面板内按钮，用户需自己展开面板。这是「不打扰」的代价，不是漏判。
 *
 * 本模块**不 import vscode**（依赖全注入）——宿主 host 层纪律，单测无需 mock vscode；
 * vscode 适配见 `vscodeAttention.ts`。
 */

/** 通知种类：三类事件的文案与去重键各不同 */
export type AttentionKind = 'confirm' | 'ask' | 'settled';

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

/** 为什么用中文常量而不是分散字面量：文案即用户契约，改一处必须改全 */
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
  /** toast 首行 */
  title: string;
  /** toast 第二行（详情摘要；空串 = 只有一行） */
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
 * toast 第二行空白。空串与纯空白都算没内容——这才是兜底文案存在的意义（实测踩过）。
 */
function detailOr(text: string | undefined, fallback: string, max: number): string {
  return (text === undefined ? '' : clipText(text, max)) || fallback;
}

/** 文案单点（纯函数）：三类的标题 / 详情全在这里，调用方不拼字符串 */
export function composeAttention(kind: AttentionKind, detail: AttentionDetail = {}): AttentionMessage {
  if (kind === 'confirm') {
    return { title: CONFIRM_TITLE, body: detailOr(detail.label, CONFIRM_FALLBACK, LABEL_CLIP) };
  }
  if (kind === 'ask') {
    return { title: ASK_TITLE, body: detailOr(detail.question, ASK_FALLBACK, ASK_CLIP) };
  }
  return { title: SETTLED_TITLE, body: '' };
}

export interface AttentionDeps {
  /**
   * 当前 VS Code 窗口是否聚焦（注入 `vscode.window.state.focused`）
   *
   * 聚焦 ⇒ 不发任何通知：承接面（审批卡 / ask 卡 / 文件改动条按钮）就在面板里，
   * 再发系统通知属于重复表达 + 打扰。
   */
  isWindowFocused: () => boolean;
  /** 系统 toast（注入 `createSystemToastSender()`；缺省 = 不发，用于测试与其它宿主） */
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
    // 🔴 增值能力边界：注入面任何一个同步抛错都在这里收敛。调用方包含确认卡路径
    // （`confirmCoordinator.onConfirmShown` 是同步直调）——通知失败绝不能把审批卡打掉。
    try {
      // 判据单点：聚焦 = 用户就在 VS Code 里，面板内按钮即承接面
      if (deps.isWindowFocused()) return;
      if (!deps.showSystemToast) return;
      if (!firstTime(key)) return;
      const composed = composeAttention(kind, detail);
      deps.showSystemToast({ title: composed.title, body: composed.body, launchUri: deps.launchUri });
    } catch {
      // 静默：通知失败不产生任何用户可见面（也没有更合适的报告通道——报告本身就会再走通知）
    }
  }

  return {
    onConfirmShown: (info) =>
      requestAttention('confirm', { label: info.label }, `confirm:${info.requestId}`),
    // 去重键用提问原文：同一提问重复进入等待（覆写式 setPending + armAskTimeout 两次调用）
    // 只弹一次系统 toast；不同轮撞同一提问则不弹（低频，可接受）
    onAskWaiting: (info) => requestAttention('ask', { question: info.question }, `ask:${info.question}`),
    onRoundSettled: (info) => requestAttention('settled', {}, `settled:${info.roundId}`),
  };
}
