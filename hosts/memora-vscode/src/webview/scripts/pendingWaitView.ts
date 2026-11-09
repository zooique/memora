/**
 * pendingWaitView — 「回答等待中」指示器（HOST-I18N-2 C-2 域外置，自 chatView.ts）
 *
 * 域职责：一条挂在消息区末尾的 `role=status` 行，展示「当前相位 · 已等待 Ns」，秒数自刷新。
 *
 * **边界**：只持有指示器自身的三件事（元素 / 起算时点 / 相位文案 / 1s 定时器）。
 * 相位文案由调用方（chatView 过程事件分支）经 `ensure(phase)` 给出，本模块只负责
 * 缺省值与拼装——**不**读过程事件、**不**判会话状态（判据归 chatView）。
 *
 * 文案：`phase` 已是调用方译好的可见文案；缺省相位与「已等待」后缀是本域自有的英文源键。
 *
 * @module pendingWaitView
 */

import * as l10n from '@vscode/l10n';

/** 等待指示器依赖：文档对象 + 挂载容器（节点身份由 chatView 持有） */
export interface PendingWaitViewDeps {
  /** webview 文档对象（构造唯一 DOM 入口） */
  document: Document;
  /** 挂载容器（消息区 `#messages`） */
  container: HTMLElement;
}

/** 等待指示器窄接口：chatView 仅经此驱动 */
export interface PendingWaitView {
  /**
   * 建立/复用指示器并进入等待态
   *
   * @param phase 最新相位文案（已译；省略 = 沿用当前相位，首次为缺省「准备回答」）
   */
  ensure(phase?: string): void;
  /** 清除指示器与定时器（幂等；骨架接管 / 正文开启 / done / error / 切轮时调用） */
  clear(): void;
  /** 释放资源（webview dispose 专用，等价 clear 但不依赖容器存活） */
  dispose(): void;
}

export function createPendingWaitView(deps: PendingWaitViewDeps): PendingWaitView {
  const { document, container } = deps;

  /** 指示器元素（null = 未展示） */
  let el: HTMLElement | null = null;
  /** 等待起算时间戳（0 = 未起算；跨相位不重置） */
  let startedAt = 0;
  /** 当前相位文案（undefined = 用缺省相位） */
  let phase: string | undefined;
  /** 1s 刷新定时器（undefined = 未运行） */
  let timer: ReturnType<typeof setInterval> | undefined;

  /** 相位文案（缺省「正在准备回答…」）；解析推迟到渲染时刻，保证 l10n 已初始化 */
  function phaseText(): string {
    return phase ?? l10n.t('Preparing a response…');
  }

  /** 刷新已等待秒数（元素不在树上时静默返回，不重建） */
  function render(): void {
    if (!el || !el.isConnected) return;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    el.textContent = l10n.t('{0} · Waited {1}s', phaseText(), String(elapsed));
  }

  function ensure(nextPhase?: string): void {
    if (nextPhase !== undefined) phase = nextPhase;
    if (el && el.isConnected) {
      render();
      return;
    }
    if (startedAt === 0) startedAt = Date.now();
    el = document.createElement('div');
    el.className = 'pending-wait';
    // 读屏：状态行语义（内容随时间变化，不打断用户）
    el.setAttribute('role', 'status');
    container.appendChild(el);
    render();
    if (timer === undefined) timer = setInterval(render, 1000);
  }

  function clear(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    el?.remove();
    el = null;
    startedAt = 0;
    phase = undefined;
  }

  return { ensure, clear, dispose: clear };
}
