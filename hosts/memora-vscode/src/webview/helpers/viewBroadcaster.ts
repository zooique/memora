/**
 * 多视图广播器（HOSTED-UI-SEAT-DECOUPLE-1 地基）
 *
 * 背景：托管页（编辑器 WebviewPanel，form='assistant'）与侧栏（WebviewView，form='self'）
 * 是**同一条会话的两个取景**——会话状态机在 chatPanel 只有一份（`_currentSessionId` /
 * agent / 流态），本广播器只负责把宿主消息投给「主视图 + 已挂的附加视图」，不持有会话状态。
 *
 * 三条纪律：
 * - **主视图永远由调用方显式传**：侧栏 `_view` 是主接收端，不进本器的集合——这样即便
 *   测试 / 其他路径直接给 `_view` 赋值（不经过 resolveWebviewView 注册），主视图照样收消息，
 *   零回归。本器只管**附加视图**（托管页）这一类增量。
 * - **后台闸由调用方给**：`post()` 的丢弃判据（`isBackgroundFlow`）是 chatPanel 的职责，
 *   本器只执行；`session_activity` 这类跨会话全局信号走 `postRaw()` 绕过闸（同既有纪律）。
 * - **注册即生命周期**：附加视图销毁必须 `dispose` 注销，避免向已销毁 webview 投递。
 */
import type * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/** 广播器接口（便于测试注入替身，不绑定具体 Webview 实现） */
export interface ViewBroadcaster {
  /** 注册一个附加视图（托管页），返回注销句柄（视图销毁时调用） */
  register(webview: vscode.Webview): vscode.Disposable;
  /**
   * 受后台闸约束的广播：投给 primary + 所有附加视图。
   * @param primary 主视图（侧栏 webview），由调用方现场传，可为 undefined
   */
  post(msg: ExtensionToWebviewMessage, primary: vscode.Webview | undefined): void;
  /** 绕过后台闸的广播（跨会话全局信号，如 session_activity） */
  postRaw(msg: ExtensionToWebviewMessage, primary: vscode.Webview | undefined): void;
  /** 当前已注册附加视图数（测试断言用，不含 primary） */
  size(): number;
}

/**
 * 创建一个广播器
 *
 * @param isBackground 后台流判据，由 chatPanel 现场提供（`isBackgroundFlow`）；
 *                     纯 helper 不自己判「哪条会话在后台」——那是状态机的职责。
 */
export function createViewBroadcaster(isBackground: () => boolean): ViewBroadcaster {
  const extras = new Set<vscode.Webview>();
  /** 扇出到主视图 + 附加视图（去重：同一 webview 不被投两次） */
  const fanout = (msg: ExtensionToWebviewMessage, primary: vscode.Webview | undefined): void => {
    const seen = new Set<vscode.Webview>();
    if (primary) {
      void primary.postMessage(msg);
      seen.add(primary);
    }
    for (const view of extras) {
      if (seen.has(view)) continue;
      void view.postMessage(msg);
      seen.add(view);
    }
  };
  return {
    register(webview) {
      extras.add(webview);
      return {
        dispose: () => {
          extras.delete(webview);
        },
      };
    },
    post(msg, primary) {
      if (isBackground()) return;
      fanout(msg, primary);
    },
    postRaw(msg, primary) {
      fanout(msg, primary);
    },
    size() {
      return extras.size;
    },
  };
}
