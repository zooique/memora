/**
 * writeConfirmCardView — 确认审批卡（HOST-I18N-2 C-3 域外置，自 chatView.ts）
 *
 * 域职责：渲染宿主推来的 `write_confirm_request`（工具名 / 目标 / 描述 / 内容预览 +
 * 末段倒计时）、把「确认 / 拒绝」裁决回传宿主。
 *
 * **边界**：只持卡自身的内容填充、倒计时与按钮可用性。**显隐真源仍在宿主**——
 * 本模块不直写 `hidden`，只经 `setDockActive` 通知 chatView 的收纳裁决器；
 * 卡元素身份经 `registerDockEntry` 交给同一 Dock 体系。**显隐两处互斥写入点**的纪律
 * 随域迁入此处（见 `closeIfMatches` 注释）。
 *
 * 文案：本域自有英文源键经 `l10n.t` 解析；工具名走展示名单一真源
 * （`getToolDisplayName`，与工具行同源）。
 *
 * @module writeConfirmCardView
 */

import * as l10n from '@vscode/l10n';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { getToolDisplayName } from '../helpers/toolNameMap.js';

/** 宿主推送的审批请求载荷（协议严格同形） */
type WriteConfirmRequest = Extract<ExtensionToWebviewMessage, { type: 'write_confirm_request' }>;

/** 确认审批卡依赖（元素查询 + 三个回流回调） */
export interface WriteConfirmCardViewDeps {
  /** webview 文档对象（元素查询唯一入口） */
  document: Document;
  /** Dock 注册：把卡片元素身份交给 chatView 的收纳体系 */
  registerDockEntry: (el: HTMLElement) => void;
  /** 显隐开关（真源仍是 chatView 的 resolveDock；本模块只发意图） */
  setDockActive: (active: boolean) => void;
  /** 回传裁决（chatView 组 postMessage 载荷） */
  postAnswer: (requestId: string, approved: boolean) => void;
}

/** 确认审批卡窄接口：chatView 仅经此驱动 */
export interface WriteConfirmCardView {
  /** 渲染（覆盖同一张卡）新请求 */
  render(msg: WriteConfirmRequest): void;
  /** 宿主宣告请求终结 → 收卡；`requestId` 不匹配即丢弃（卡可能已切到更新的请求） */
  closeIfMatches(requestId: string): void;
  /** 释放资源（webview dispose 专用：停倒计时） */
  dispose(): void;
}

/** 末段倒计时窗口（ms）：剩余不足该值才显示倒计时，之前保持静默不打扰 */
const CONFIRM_COUNTDOWN_WINDOW_MS = 60_000;

export function createWriteConfirmCardView(deps: WriteConfirmCardViewDeps): WriteConfirmCardView {
  const { document, registerDockEntry, setDockActive, postAnswer } = deps;

  const card = document.getElementById('writeConfirmCard') as HTMLElement | null;
  const toolEl = document.getElementById('writeConfirmTool') as HTMLElement | null;
  const pathEl = document.getElementById('writeConfirmPath') as HTMLElement | null;
  const descEl = document.getElementById('writeConfirmDesc') as HTMLElement | null;
  const diffEl = document.getElementById('writeConfirmDiff') as HTMLElement | null;
  const okBtn = document.getElementById('writeConfirmOk') as HTMLButtonElement | null;
  const rejectBtn = document.getElementById('writeConfirmReject') as HTMLButtonElement | null;
  const countdownEl = document.getElementById('writeConfirmCountdown') as HTMLElement | null;
  const hintEl = document.getElementById('writeConfirmHint') as HTMLElement | null;

  /** 当前请求 id（`null` = 无在审请求；等待态期间保持非空，供重复 click 兜底） */
  let pendingRequestId: string | null = null;
  /**
   * 等待态标记（2026-10-05 P5 落地 A）：用户已裁决、卡等宿主推下一条的过渡态。
   *
   * 🔴 为何需要它（消解 F1 重复提交 + 闪烁）：
   * 原实现点击后**同步**关卡，而下一条 `write_confirm_request` 由宿主**异步**推 ⇒
   * ① 两帧空档 = 用户实测的闪烁；② 队列无下一条时，卡片会带着已裁决的旧内容滞留，
   * 用户再点一次 → 宿主 pending 已 delete ⇒ 第二个 answer 静默丢弃（点了没反应）。
   * 等待态把「点了 → 下一张」显式化：按钮 disabled（防重复）+ 卡片降透明度（明示过渡）。
   */
  let awaitingNext = false;
  /** 当前审批截止时刻（epoch ms）——由宿主透传的 timeoutMs 换算，本模块不自算时长 */
  let deadlineAt = 0;
  /** 倒计时定时器（唯一实例；关卡与 dispose 都必须清，否则跨测试污染 DOM） */
  let countdownTimer: ReturnType<typeof setInterval> | undefined;

  /** 停表 + 清空倒计时（关卡 / 新请求覆盖 / dispose 共用唯一收口） */
  function stopCountdown(): void {
    if (countdownTimer !== undefined) {
      clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
    deadlineAt = 0;
    if (countdownEl) {
      countdownEl.hidden = true;
      countdownEl.textContent = '';
    }
  }

  /**
   * 启动末段倒计时
   *
   * 时长**只**来自宿主载荷（timeoutMs）——真源是宿主 CONFIRM_TIMEOUT_MS；webview 自算即
   * 真源双写，末段提示会与宿主实际拒绝时刻漂移。
   */
  function startCountdown(timeoutMs: number): void {
    stopCountdown();
    const el = countdownEl;
    if (!el) return;
    // 载荷缺 timeoutMs / 非正数 = 协议违约（真源必须由宿主透传，见 protocol.ts 该字段注释）。
    // 🔴 不得静默 return：真源一旦漂移（如宿主漏填），倒计时会无声消失——用户只见一张
    // 永不提示的卡，直到超时后突然被拒，且**无任何痕迹可查**（E2 同款病：字段进了协议零消费）。
    // 显式抛错让违约在开发期第一眼暴露，而非潜伏到真机。
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `write_confirm_request payload missing a valid timeoutMs (received ${String(timeoutMs)}) — ` +
          'the timeout source of truth is the host CONFIRM_TIMEOUT_MS and must be passed through the protocol',
      );
    }
    deadlineAt = Date.now() + timeoutMs;
    const tick = (): void => {
      const left = deadlineAt - Date.now();
      if (left <= 0) {
        stopCountdown();
        return;
      }
      if (left > CONFIRM_COUNTDOWN_WINDOW_MS) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.textContent = l10n.t('{0} seconds until auto-reject', String(Math.ceil(left / 1000)));
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /**
   * 关闭审批卡（唯一收口点）
   *
   * 🔴 真源已迁至宿主（2026-10-05 P5 落地 A）：卡片显隐只由本函数与 `render` 两处
   * **互斥**触发，且两处的内容源都是宿主消息——
   * ① `write_confirm_request` ⇒ 覆盖渲染（队列还有下一条，宿主协调器不推 closed）
   * ② `write_confirm_closed` ⇒ 收卡（队列已空）
   * 用户点击**不再**调本函数（改调 `enterAwaitingNext`），否则会造出第三处显隐写入点
   * 并造成「同步关卡 / 异步开卡」两帧空档（用户实测的闪烁，F1 重复提交窗口）。
   *
   * 注：等待态（`awaitingNext`）**刻意不进 dispose 清理**——它只改 DOM 属性
   * 与 button.disabled，无定时器 ⇒ 无跨用例泄漏；dispose 时页面已销毁、清它反而多余。
   */
  function close(): void {
    stopCountdown();
    exitAwaitingNext();
    pendingRequestId = null;
    setDockActive(false);
  }

  /**
   * 进入等待态（点击裁决后、宿主推下一条前）
   *
   * 只改**按钮可用性 + 提示 + 卡片透明度**，**不开关卡片**（显隐真源在宿主）。
   * 同时停掉倒计时（F3）：这张已裁决，倒数对它已无意义。
   */
  function enterAwaitingNext(approved: boolean): void {
    awaitingNext = true;
    stopCountdown();
    // 两键同构：JS 只翻 disabled 布尔；等待态样式（cursor/opacity）由 CSS
    // `.write-confirm-card__btn[disabled]` 接管（基类静态在骨架上），样式类不进 JS。
    if (okBtn) okBtn.disabled = true;
    if (rejectBtn) rejectBtn.disabled = true;
    if (hintEl) {
      hintEl.hidden = false;
      hintEl.textContent = approved
        ? l10n.t('Confirmed, waiting for the next…')
        : l10n.t('Rejected, waiting for the next…');
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

  /**
   * 渲染审批卡（webview 侧唯一实现点）
   *
   * 填充卡片字段（工具名 / 目标 / 描述 / 内容预览）并显示；记录当前 requestId，
   * 供确认/拒绝按钮回传 `write_confirm_answer`。
   *
   * ⚠️ 本卡承载**全部四类**确认（写入 / 命令 / 代码 / 脚本执行）——文案一律用中性动词
   * （「确认」而非「确认写入」），diff 域缺省时不得渲染假的写入前后对比（见下方 hasDiff 注释）。
   */
  function render(msg: WriteConfirmRequest): void {
    if (!card || !toolEl || !pathEl || !descEl || !diffEl) return;
    // 全部字段用 textContent 填充（SSOT：不信任 host 输入，防注入——与消息区渲染同纪律）
    // 工具名走展示名单一真源（与工具行 toolActionLabel 同源）；表值 = 英文源键，
    // 须经 webview 本地化器解析——与宿主侧 confirmCoordinator（vscode.l10n）严格同源同键，
    // 少过这一步即「弹窗英文、卡片中文」的双头语义（B9-A 实修）
    toolEl.textContent = l10n.t(getToolDisplayName(msg.tool));
    pathEl.textContent = msg.targetPath;
    descEl.textContent = msg.description ?? '';
    // diff 域判据归内核单点（`WriteConfirmationInfo.hasDiff` 经协议载荷透传）：
    // 仅写入场景 true；命令 / 代码 / 脚本执行（含删除文件）恒 false——宿主不再用
    // beforeContent/afterContent truthy 自猜（2026-10-03 实锤：truthy 判据属措辞折叠型带伤，
    // 判据归位内核后，即使载荷意外带内容字段也不会渲染假的写入前后对比）。
    if (msg.hasDiff) {
      // 有 diff 对比域（仅写入场景）：before 为 null 即新建文件
      const before = msg.beforeContent ?? l10n.t('(new file)');
      diffEl.textContent =
        before === msg.afterContent
          ? before
          : l10n.t(
              '--- Before write ---\n{0}\n\n+++ After write +++\n{1}',
              before,
              msg.afterContent ?? '',
            );
    } else {
      // 无 diff 域（命令 / 代码 / 脚本执行确认）：渲染目标摘要，绝不伪造写入前后对比
      diffEl.textContent = l10n.t(
        '--- Target ---\n{0}\n\n{1}',
        msg.targetPath,
        msg.description ?? '',
      );
    }
    pendingRequestId = msg.requestId;
    // 退出等待态（2026-10-05 P5 落地 A）：宿主推来新 request = 上一张已终结、队列还有下一条。
    // 此处复位按钮可用性与提示——卡片**保持可见**（同 DOM 覆盖内容，天然无闪烁）。
    // ⚠️ 显隐不归本函数：只 setDockActive(true)（幂等，SSOT 仍是 resolveDock）。
    exitAwaitingNext();
    // 显隐交裁决器（SSOT）：不再直写 hidden——直写会绕过 resolveDock 的主位/收纳裁决，
    // 与 B 类条同屏时顺序不定（方案 §九 A1）。
    setDockActive(true);
    // 末段倒计时（时长真源 = 宿主 timeoutMs）
    startCountdown(msg.timeoutMs);
    // 焦点落「拒绝」：composer 已被替换，焦点不能丢到 body（键盘用户会失去落点）。
    // 选拒绝而非确认是与 fail-closed 同向的安全默认（超时亦为拒绝），误触不会造成副作用。
    rejectBtn?.focus();
  }

  // ─── 卡片接入 Dock 收纳器 ───────────────────────────────────────
  // A 类阻断面板（审批卡）接入同一收纳器：显隐与归位自此**只由 resolveDock 裁决**，
  // 渲染 / 按钮回调一律改走 setDockActive，禁直写 hidden（散写即回到堆叠）。
  if (card) registerDockEntry(card);

  // ─── 按钮事件（确认 / 拒绝 → 回传 write_confirm_answer + 进入等待态）───
  // ⚠️ 等待态期间**不再收卡**（显隐真源在宿主，见 close 注释）。
  // 双击由 disabled 天然挡住（F4）；pendingRequestId 在等待态期间保持非空，
  // 故重复 click 事件若漏网仍会回传同一 requestId —— 宿主 pending 已 delete 会静默丢弃，
  // 但那不该发生，disabled 是第一道防线，requestId 相同只是兜底。
  if (okBtn && rejectBtn && card) {
    okBtn.addEventListener('click', () => {
      if (awaitingNext) return;
      if (pendingRequestId !== null) {
        postAnswer(pendingRequestId, true);
        enterAwaitingNext(true);
      }
    });
    rejectBtn.addEventListener('click', () => {
      if (awaitingNext) return;
      if (pendingRequestId !== null) {
        postAnswer(pendingRequestId, false);
        enterAwaitingNext(false);
      }
    });
  }

  return {
    render,
    closeIfMatches: (requestId: string) => {
      if (pendingRequestId === requestId) close();
    },
    dispose: () => {
      stopCountdown();
    },
  };
}
