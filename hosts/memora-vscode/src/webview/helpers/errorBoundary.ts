/**
 * Webview 全局错误边界 — 未处理异常的「最后目击者」（T1）
 *
 * 背景：两个 webview 入口（chatViewMain / settingsViewMain）的业务脚本若抛出未捕获
 * 异常或未处理的 Promise 拒绝，此前无任何兜底：面板静默卡死，用户只看到「没反应」，
 * 宿主侧零日志（静默失败 = 假阴性）。
 *
 * 职责（单点、双入口各装配一行）：
 *   ① 界面就地插入错误卡片（textContent 防注入），给用户「重新打开面板可恢复」的自救指引；
 *   ② 经 host_diag 通道上报宿主落日志（webview console 用户拿不到）。
 *
 * 边界（诚实登记，不承诺全兜）：
 *   - 只覆盖**主脚本已加载后**的错误；主脚本加载失败 / HTML 生成失败在本函数运行前，
 *     属本边界外——那类故障表现为面板全空，重开面板同样可恢复；
 *   - 错误风暴：卡片只插一次（单例判据），每条错误都上报（Output 可能连续多条，
 *     属已考虑边界，不做过滤节流——过滤会丢真实线索）。
 *
 * CSP 约束（不可绕）：`script-src` 无 unsafe-inline，故本逻辑无法内嵌 HTML，必须随
 * esbuild 产物（外部脚本）加载；acquireVsCodeApi 每会话仅可调用一次，故 api 实例由
 * Main acquire 一次后以依赖注入本模块与工厂共用（与 rolesView「acquire 一次后注入」同构）。
 *
 * @module helpers/errorBoundary
 */
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';

/** 错误卡片容器 id —— 单例判据（已存在即不再插卡，只重复上报） */
const ERROR_CARD_ID = 'memora-error-card';

/** 依赖注入面（与 htmlShell 同构：纯函数、可直接单测，不依赖全局 vscode） */
export interface ErrorBoundaryDeps {
  /** postMessage 出口（Main 已 acquire 的同一 api 实例） */
  post: (msg: WebviewToExtensionMessage) => void;
  /** window 事件源（测试注入 fake 捕获 handler） */
  window: Pick<Window, 'addEventListener'>;
  /** 卡片挂载的文档（测试注入 fake） */
  document: Pick<Document, 'getElementById' | 'createElement' | 'body'>;
}

/**
 * 从事件提取 Error（error 事件可能只有 message；rejection reason 可能非 Error）
 * 统一为 Error 形态，保证上报的 message/stack 字段结构稳定。
 * 按 event.type 分流而非 instanceof：不依赖 PromiseRejectionEvent 全局类存在，
 * 测试注入的 plain 对象事件同样可走通。
 */
function toError(event: Event): Error {
  if (event.type === 'unhandledrejection') {
    const reason: unknown = (event as PromiseRejectionEvent).reason;
    return reason instanceof Error ? reason : new Error(String(reason));
  }
  const errorEvent = event as ErrorEvent;
  if (errorEvent.error instanceof Error) return errorEvent.error;
  return new Error(errorEvent.message || String(event.type));
}

/**
 * 装配全局错误边界：监听 error / unhandledrejection → 插卡（幂等）+ 上报
 *
 * 不调用 preventDefault：开发者工具 console 仍保留原始报错（诊断不吞错）。
 */
export function installWebviewErrorBoundary(deps: ErrorBoundaryDeps): void {
  /** 统一处置：上报（每次都发）+ 插卡（单例，首次才建 DOM） */
  const handle = (event: Event): void => {
    const err = toError(event);
    deps.post({
      type: 'host_diag',
      source: event.type,
      message: err.message,
      stack: err.stack,
    });
    // 已有卡片 = 风暴场景，只留痕不再动 DOM
    if (deps.document.getElementById(ERROR_CARD_ID)) return;
    const card = deps.document.createElement('div');
    card.id = ERROR_CARD_ID;
    // 内联样式合法（CSP style-src 'unsafe-inline'）；高 z-index 压住面板内容
    // 安全网自包含 = 不依赖被守护系统的样式注入（应用 <style> 挂了也要能亮）⇒ 裸值故意
    // 不入户，属 tokensClosure 值守卫 Scope（仅 styles/）的已登记例外，勿顺手令牌化
    card.style.cssText =
      'position:fixed;top:8px;left:8px;right:8px;z-index:9999;' +
      'padding:10px 14px;border-radius:6px;background:rgba(244,67,54,0.95);color:#fff;' +
      'font-size:13px;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,0.35);';
    const title = deps.document.createElement('div');
    // textContent 赋值 = 纯文本，错误消息里的 HTML 不进 DOM（防注入）
    title.textContent = 'Memora 界面出错了';
    title.style.fontWeight = 'bold';
    const detail = deps.document.createElement('div');
    detail.textContent = err.message.slice(0, 300);
    detail.style.opacity = '0.9';
    const hint = deps.document.createElement('div');
    hint.textContent =
      '重新打开面板可恢复；如需反馈，请附 Output 日志（扩展宿主）中的 Memora 报错。';
    hint.style.opacity = '0.85';
    card.append(title, detail, hint);
    deps.document.body.appendChild(card);
  };

  deps.window.addEventListener('error', handle);
  deps.window.addEventListener('unhandledrejection', handle);
}
