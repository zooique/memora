/**
 * chatView 测试共享基建（防对拍测试复制夹具成双份真相）
 *
 * 单一真源：`createChatView` 依赖的 HTML 骨架、挂载/分发辅助只在此一份，
 * `chatView.test.ts` 与 `runtimeReplayParity.test.ts` 均从本模块 import——
 * 若 createChatView 增删 DOM 引用，只改这一处，两份测试同步生效。
 */

// @vitest-environment jsdom 不在此标注：jsdom 环境由导入方测试文件的
// `@vitest-environment jsdom` 决定（本文件被测试文件 import，随宿主环境运行）。

import { afterEach, vi } from 'vitest';
import type { TurnState } from '../../../shared/protocol.js';
import { createChatView } from '../../scripts/chatView.js';

/** 覆盖 createChatView 全部 getElementById 引用的最小 HTML 骨架 */
const HTML = `
  <div id="sessionTitleBar" class="session-title-bar">
    <span id="sessionTitleText"></span>
    <button id="renameSessionBtn"><span class="btn-icon" data-icon="edit"></span></button>
    <span class="session-title-bar__spacer"></span>
    <button id="newSessionBtn"><span class="btn-icon" data-icon="plus"></span></button>
  </div>
  <div id="historyDd" class="treedd session-history" data-treedd data-on-select="__historyOnSelect">
    <button id="historyBtn" class="treedd__trigger"><span class="btn-icon" data-icon="history"></span></button>
    <!-- 镜像生产 DOM 结构（分组切换器 + 搜索框 + 条目容器同级；tab/搜索框不带 .treedd__item） -->
    <div class="treedd__menu">
      <div id="historyTabs" class="session-tabs" role="tablist">
        <button id="historyTabRecent" class="session-tab is-active" type="button" role="tab" aria-selected="true" data-view="recent">会话记录</button>
        <button id="historyTabArchived" class="session-tab" type="button" role="tab" aria-selected="false" data-view="archived">留存区<span id="historyArchivedCount" class="session-tab__count"></span></button>
      </div>
      <input id="historySearch" class="session-search" type="text" placeholder="搜索会话（标题 / 主题 / 摘要）" autocomplete="off" />
      <div id="historyMenu"></div>
    </div>
  </div>
  <div id="planBar" class="plan-bar" hidden>
    <button id="planBarHead" class="plan-bar__head" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="planBarPanel">
      <span id="planBarCount" class="plan-bar__count"></span>
      <span class="plan-bar__progress"><span id="planBarFill" class="plan-bar__fill"></span></span>
      <span id="planBarCurrent" class="plan-bar__current"></span>
      <span id="planBarChevron" class="plan-bar__chevron" aria-hidden="true"></span>
    </button>
    <div id="planBarPanel" class="plan-bar__panel" hidden></div>
  </div>
  <div id="activityBar" class="activity-bar" hidden></div>
  <details id="activityDetail" class="activity-detail" hidden>
    <summary>活动详情</summary>
    <div id="activityList" class="activity-list"></div>
    <div id="activityMetrics" class="activity-metrics" hidden></div>
  </details>
  <div id="messages">
    <div id="emptyState" class="empty-state" hidden>
      <div id="emptyTitle" class="empty-title"></div>
      <div id="emptyHint" class="empty-hint"></div>
      <div id="emptySuggestions" class="empty-suggestions"></div>
    </div>
  </div>
  <div id="clarifyBar">
    <div id="clarifyText"></div>
    <div id="clarifyOptions"></div>
    <div id="clarifyRow">
      <input id="clarifyInput" />
      <button id="clarifySend">提交</button>
    </div>
  </div>
  <!-- 镜像生产 DOM：审批卡归位在输入区紧上方、与 #messages 同级（2026-10-05 修复「卡挂
       滚动容器内不可见」）。本夹具是生产 buildHtml 的手工镜像，结构守卫另由源码级用例锁定。 -->
  <div id="writeConfirmCard" class="write-confirm-card" hidden>
    <div class="write-confirm-card__body">
      <div class="write-confirm-card__head">
        <span class="write-confirm-card__tool" id="writeConfirmTool"></span>
        <span class="write-confirm-card__path" id="writeConfirmPath"></span>
      </div>
      <div class="write-confirm-card__desc" id="writeConfirmDesc"></div>
      <div class="write-confirm-card__countdown" id="writeConfirmCountdown" hidden></div>
      <details class="write-confirm-card__diff">
        <summary>查看内容</summary>
        <pre id="writeConfirmDiff"></pre>
      </details>
      <div class="write-confirm-card__actions">
        <button id="writeConfirmReject" class="write-confirm-card__btn--reject">拒绝</button>
        <button id="writeConfirmOk" class="write-confirm-card__btn--ok">确认</button>
      </div>
    </div>
  </div>
  <div id="inputBar">
    <button id="scrollToBottomBtn" class="scroll-to-bottom" hidden><span class="btn-icon" data-icon="scroll-bottom"></span></button>
    <div id="skillChips" class="skill-chip-row" hidden></div>
    <div id="inputWrap">
      <textarea id="input"></textarea>
      <div id="inputFooter">
        <div class="composer-row composer-row--actions">
          <div class="composer-actions">
            <div class="model-picker treedd--capsule"><button class="treedd__trigger"></button><div class="treedd__menu"></div></div>
            <div class="treedd skill-picker treedd--capsule" data-treedd data-on-select="__skillPickerOnSelect"><button class="treedd__trigger" title="选择 Skill" aria-label="选择 Skill" aria-haspopup="menu"></button><div class="treedd__menu" role="menu"></div></div>
            <button id="pauseBtn" hidden title="暂停生成" aria-label="暂停生成"><span class="btn-icon" data-icon="pause"></span></button>
            <button id="send"></button>
          </div>
        </div>
        <div class="composer-row composer-row--status">
          <div class="composer-status">
            <span id="currentRoleBadge" class="role-badge"></span>
          </div>
          <!-- ④ 预算可视化：状态行右端上下文占用圆环（容量上限由 chat_providers 实时渲染，真实占用由 context_occupancy 覆盖） -->
          <div id="contextOccupancy" class="context-ring" hidden>
            <svg class="context-ring__svg" viewBox="0 0 40 40" aria-hidden="true">
              <circle class="context-ring__track" cx="20" cy="20" r="16" />
              <circle class="context-ring__fill" id="occFill" cx="20" cy="20" r="16" />
            </svg>
            <span class="context-ring__percent" id="occPercent">0%</span>
            <div class="context-ring__tip" id="occTip" role="tooltip"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;

/**
 * 跨用例累积泄漏的 createChatView 销毁句柄（flake 根因：全局监听器未移除）
 * 本模块顶层注册 afterEach 统一销毁——任何 import 本模块的测试文件都获得该守护。
 */
let chatViewDispose: (() => void) | undefined;

// 每个用例结束后显式销毁，防止 window/document 全局监听器跨用例累积泄漏（flake 根因）
afterEach(() => {
  chatViewDispose?.();
  chatViewDispose = undefined;
});

/** 挂载 createChatView 并返回 postMessage mock（ready 消息在此被捕获） */
export function mountChatView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  const view = createChatView({
    acquireVsCodeApi: () => ({ postMessage }),
    window: window as unknown as Window,
  });
  chatViewDispose = view.dispose;
  return { postMessage };
}

/** 向 webview 分发一条 extension → webview 消息 */
export function dispatch(msg: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

/**
 * 发送 `turn_update` 状态快照（按钮语义唯一真源）
 *
 * 按钮语义（loading/icon/title/disabled）只由 `turn_update.state` 驱动，
 * legacy `status` / `pause_pending` 不参与骨架容器。本辅助统一收口各用例的
 * 驱动消息构造，rounds 取空数组（按钮语义不消费 rounds）。
 */
export function dispatchTurn(state: TurnState): void {
  dispatch({ type: 'turn_update', rounds: [], state });
}

/**
 * 收集一条 AI 消息块内全部正文的 textContent（单容器结构：正文 = 该轮唯一 .msg-body）。
 * Markdown 段落 <p> 产生的换行符对「正文语义拼接断言」无意义，统一移除后比对。
 *
 * @param el  assistant 消息根节点（.msg.assistant）
 * @returns  去除首尾空白与段落换行的完整正文文本
 */
export function collectAllBodyText(el: Element): string {
  return Array.from(el.querySelectorAll('.msg-body'))
    .map((b) => (b as HTMLElement).textContent ?? '')
    .join('')
    .replace(/\r?\n/g, '')
    .trim();
}
