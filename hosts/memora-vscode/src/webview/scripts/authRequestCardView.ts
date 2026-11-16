/**
 * authRequestCardView — 授权请求卡（HOSTED-CONFIRM-AUTH-1 域外置，自 chatView.ts）
 *
 * 域职责：渲染宿主推来的 `auth_request`（托管会话撞上 always-ask 档命令且无授权时，
 * 代理转述的「要不要允许这条命令」——命令原文 + 来源工作会话），把「允许 / 拒绝」
 * 裁决回传宿主；`auth_closed` 收卡（outcome 驱动等待态提示文案）。
 *
 * **边界**：只持卡自身的内容填充与按钮可用性。显隐真源在宿主（authFlow 一次只推一张卡），
 * 本模块不直写 `hidden`，只经 `setDockActive` 通知 chatView 的收纳裁决器；卡元素身份经
 * `registerDockEntry` 交给同一 Dock 体系（与 writeConfirmCardView 同纪律）。
 *
 * 与确认卡的三点刻意差异（禁抄成同款）：
 *   ① **无倒计时**——授权请求没有超时（内核 deferred 不挂起等待，用户何时答都行），
 *      渲染倒计时就是撒谎；
 *   ② 载荷是**命令原文**（`command`，多行脚本可能很长的 pre 块），不是路径 + diff 域；
 *   ③ 等待态提示按 `auth_closed.outcome` 区分（granted / denied / void 三向），确认卡
 *      按「用户点了哪个按钮」两向——授权卡可能被宿主兜底终结（会话删除），outcome 是
 *      唯一真相，webview 不自猜。
 *
 * 文案：本域自有英文源键经 `@vscode/l10n` 解析（webview 本地化器，与宿主侧不可互换）。
 *
 * @module authRequestCardView
 */

import * as l10n from '@vscode/l10n';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 宿主推送的授权请求载荷（协议严格同形） */
type AuthRequest = Extract<ExtensionToWebviewMessage, { type: 'auth_request' }>;

/** 授权请求卡依赖（元素查询 + 三个回流回调） */
export interface AuthRequestCardViewDeps {
  /** webview 文档对象（元素查询唯一入口） */
  document: Document;
  /** Dock 注册：把卡片元素身份交给 chatView 的收纳体系 */
  registerDockEntry: (el: HTMLElement) => void;
  /** 显隐开关（真源仍是 chatView 的 resolveDock；本模块只发意图） */
  setDockActive: (active: boolean) => void;
  /** 回传裁决（chatView 组 postMessage 载荷） */
  postAnswer: (requestId: string, approved: boolean) => void;
}

/** 授权请求卡窄接口：chatView 仅经此驱动 */
export interface AuthRequestCardView {
  /** 渲染（覆盖同一张卡）新请求 */
  render(msg: AuthRequest): void;
  /** 宿主宣告请求终结 → 收卡；`requestId` 不匹配即丢弃（卡可能已切到更新的请求） */
  closeIfMatches(requestId: string): void;
}

export function createAuthRequestCardView(deps: AuthRequestCardViewDeps): AuthRequestCardView {
  const { document, registerDockEntry, setDockActive, postAnswer } = deps;

  const card = document.getElementById('authRequestCard') as HTMLElement | null;
  const sessionEl = document.getElementById('authRequestSession') as HTMLElement | null;
  const commandEl = document.getElementById('authRequestCommand') as HTMLElement | null;
  const hintEl = document.getElementById('authRequestHint') as HTMLElement | null;
  const okBtn = document.getElementById('authRequestOk') as HTMLButtonElement | null;
  const rejectBtn = document.getElementById('authRequestReject') as HTMLButtonElement | null;

  /** 当前请求 id（`null` = 无在途请求；等待态期间保持非空，供重复 click 兜底） */
  let pendingRequestId: string | null = null;
  /**
   * 等待态标记（与确认卡同病同修：点击后同步关卡 + 宿主异步推下一条 = 闪烁 + 重复提交窗口）
   */
  let awaitingNext = false;

  /**
   * 进入等待态（点击裁决后、宿主推下一条前）
   *
   * 只改**按钮可用性 + 提示 + 卡片透明度**，**不开关卡片**（显隐真源在宿主）。
   * 提示文案不含裁决方向——outcome 由宿主 `auth_closed` 权威下发（见模块头注释③）。
   */
  function enterAwaitingNext(): void {
    awaitingNext = true;
    if (okBtn) okBtn.disabled = true;
    if (rejectBtn) rejectBtn.disabled = true;
    if (hintEl) {
      hintEl.hidden = false;
      hintEl.textContent = l10n.t('Answered, waiting for the next…');
    }
    card?.setAttribute('data-pending', 'true');
  }

  /** 退出等待态（宿主推来新的 request 覆盖渲染时，由 `render` 调） */
  function exitAwaitingNext(): void {
    if (!awaitingNext) return;
    awaitingNext = false;
    if (okBtn) okBtn.disabled = false;
    if (rejectBtn) rejectBtn.disabled = false;
    if (hintEl) {
      hintEl.hidden = true;
      hintEl.textContent = '';
    }
    card?.removeAttribute('data-pending');
  }

  /** 关闭授权卡（auth_closed 到达 / 新请求覆盖前的兜底收口） */
  function close(): void {
    exitAwaitingNext();
    pendingRequestId = null;
    setDockActive(false);
  }

  /**
   * 渲染授权卡（webview 侧唯一实现点）
   *
   * 填充来源会话名 + 命令原文并显示；记录 requestId，供允许/拒绝按钮回传 `auth_answer`。
   * 全部字段用 textContent 填充（不信任 host 输入防注入，与消息区渲染同纪律——命令原文
   * 可含任意文本，走 textContent 而非 innerHTML 是安全底线）。
   */
  function render(msg: AuthRequest): void {
    if (!card || !sessionEl || !commandEl) return;
    sessionEl.textContent = msg.sessionLabel;
    commandEl.textContent = msg.command;
    pendingRequestId = msg.requestId;
    exitAwaitingNext();
    // 显隐交裁决器（SSOT）：不直写 hidden（散写即回到堆叠，与确认卡 B 方案 §九 A1 同案）
    setDockActive(true);
    // 焦点落「拒绝」：composer 已被替换，焦点不能丢到 body；选拒绝是与 fail-closed 同向的
    // 安全默认（误触不会造成不可逆副作用）。
    rejectBtn?.focus();
  }

  // ─── 卡片接入 Dock 收纳器 ───────────────────────────────────────
  // A 类阻断面板（授权卡）接入同一收纳器：显隐与归位只由 resolveDock 裁决。
  // Dock 优先级低于确认卡（chatView 侧权重表登记），确认卡在场时授权卡被收纳、
  // 从图标条可点开——两类卡同时在场时「内核确认」优先于「代理转述的授权请求」。
  if (card) registerDockEntry(card);

  // ─── 按钮事件（允许 / 拒绝 → 回传 auth_answer + 进入等待态）───
  // 双击由 disabled 天然挡住；等待态期间 pendingRequestId 保持非空，重复 click 漏网时
  // 回传同一 requestId——宿主 _requests 已摘除会静默丢弃（disabled 是第一道防线）。
  if (okBtn && rejectBtn && card) {
    okBtn.addEventListener('click', () => {
      if (awaitingNext) return;
      if (pendingRequestId !== null) {
        postAnswer(pendingRequestId, true);
        enterAwaitingNext();
      }
    });
    rejectBtn.addEventListener('click', () => {
      if (awaitingNext) return;
      if (pendingRequestId !== null) {
        postAnswer(pendingRequestId, false);
        enterAwaitingNext();
      }
    });
  }

  return {
    render,
    closeIfMatches: (requestId: string) => {
      if (pendingRequestId === requestId) close();
    },
  };
}
