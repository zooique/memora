/**
 * 多视图广播器（HOSTED-SEAT-SESSION-1）
 *
 * 两个视图各绑一条会话：侧栏（主视图）绑「当前显示的工作会话」，助手窗（附加视图，编辑器页）
 * 绑「助手会话」。本器只做两件事：
 *   1. **按会话路由**——会话级消息只投给绑定该会话的视图，互不串台；
 *   2. **按视图取景**——助手窗只收气泡级消息，过程面消息在投递层丢弃（不落在源头，
 *      侧栏打开同一会话时仍是完整过程）。
 *
 * 三条纪律：
 * - **主视图由调用方显式传**：侧栏 `_view` 不进本器集合，即便测试直注 `_view` 也照样收消息。
 * - **绑定是现场读取**：`sessionId()` 是 getter 不是快照——助手会话可后建、指针可失效。
 * - **全局消息不受会话约束**：`post()` 不传目标 + `postRaw()` 都是全局广播（配置面 / 活跃度）。
 */
import type * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/**
 * 会话级投递目标
 *
 * `primarySessionId` 由调用方现场给（侧栏当前会话），本器不读面板状态——
 * 纯 helper 只执行路由判据，不新造第二份「当前是谁」。
 */
export interface PostTarget {
  /** 这条消息属于哪条会话 */
  sessionId: string;
  /** 主视图（侧栏）此刻显示的会话；与 `sessionId` 相等才投主视图 */
  primarySessionId: string | undefined;
}

/**
 * 视图注册绑定
 *
 * 两个字段都是必需语义（默认值只在测试的省略路径上出现）：
 * - `sessionId`：该视图绑定哪条会话（每帧现读）；
 * - `bubbleOnly`：是否只收气泡级消息（助手窗 = true）。
 */
export interface ViewBinding {
  sessionId: () => string | undefined;
  bubbleOnly: boolean;
}

/**
 * 助手窗不投递的消息类型（过程面）
 *
 * 白名单式的反向表：只列**明确不属于对话气泡**的类型。新增过程面消息时在这里补一行，
 * 否则它会出现在助手窗——症状是「窗口里突然多出工具轨迹 / 任务看板」，没有编译错。
 * `process_event` 已覆盖 tool_start / tool_result / thought / diff 等全部过程事件。
 */
const BUBBLE_DENIED_TYPES: ReadonlySet<ExtensionToWebviewMessage['type']> = new Set([
  'process_event',
  'tool_pending',
  'step_boundary',
  'plan_update',
  'background_tasks',
  'context_occupancy',
  'injection_summary',
  'narrate_withdraw',
]);

/** 广播器接口（便于测试注入替身，不绑定具体 Webview 实现） */
export interface ViewBroadcaster {
  /**
   * 注册一个附加视图（助手窗），返回注销句柄（视图销毁时调用）
   *
   * @param binding 省略 = 绑定「无会话」的中性视图（只收全局消息），供既有测试兼容
   */
  register(webview: vscode.Webview, binding?: Partial<ViewBinding>): vscode.Disposable;
  /**
   * 投递一条消息
   *
   * `target` 省略 = 全局广播（主视图 + 全部附加视图）；
   * 给定 = 会话级——主视图只在目标等于 `primarySessionId` 时收，附加视图只在目标等于
   * 自身 `sessionId()` 时收。
   */
  post(
    msg: ExtensionToWebviewMessage,
    primary: vscode.Webview | undefined,
    target?: PostTarget,
  ): void;
  /** 全局广播（跨会话信号，如 session_activity；语义与旧 postRaw 相同） */
  postRaw(msg: ExtensionToWebviewMessage, primary: vscode.Webview | undefined): void;
  /**
   * 只投附加视图（助手窗的空态类消息：此时还没有会话 id 可路由）
   *
   * 仍走同一张气泡过滤表——它不是「绕过路由的旁路」，只是目标集合 = 附加视图。
   */
  postToExtras(msg: ExtensionToWebviewMessage): void;
  /** 某会话此刻是否有视图在显示（主视图不算，由调用方自己判） */
  hasSession(sessionId: string): boolean;
  /** 当前已注册附加视图数（测试断言用，不含 primary） */
  size(): number;
}

/**
 * 创建一个广播器
 *
 * 本器不再持有「后台流闸」：会话级投递按目标路由后，后台流只会投给它自己的视图
 * （或无人接收），源头不再需要整批丢弃。
 */
export function createViewBroadcaster(): ViewBroadcaster {
  /** 附加视图 → 绑定（Map 保序，便于按注册顺序投递） */
  const extras = new Map<vscode.Webview, ViewBinding>();
  /** 投给一只视图（气泡过滤只作用于附加视图的气泡模式） */
  const deliver = (
    view: vscode.Webview,
    msg: ExtensionToWebviewMessage,
    bubbleOnly: boolean,
  ): void => {
    if (bubbleOnly && BUBBLE_DENIED_TYPES.has(msg.type)) return;
    void view.postMessage(msg);
  };
  /** 全局扇出：主视图 + 全部附加视图（同一 webview 去重） */
  const fanout = (msg: ExtensionToWebviewMessage, primary: vscode.Webview | undefined): void => {
    const seen = new Set<vscode.Webview>();
    if (primary) {
      deliver(primary, msg, false);
      seen.add(primary);
    }
    for (const [view, binding] of extras) {
      if (seen.has(view)) continue;
      deliver(view, msg, binding.bubbleOnly);
      seen.add(view);
    }
  };
  return {
    register(webview, binding) {
      extras.set(webview, {
        sessionId: binding?.sessionId ?? (() => undefined),
        bubbleOnly: binding?.bubbleOnly ?? false,
      });
      return {
        dispose: () => {
          extras.delete(webview);
        },
      };
    },
    post(msg, primary, target) {
      if (!target) {
        fanout(msg, primary);
        return;
      }
      const seen = new Set<vscode.Webview>();
      // 主视图：目标会话 = 侧栏当前会话才投（切走后不再串台）
      if (primary && target.primarySessionId === target.sessionId) {
        deliver(primary, msg, false);
        seen.add(primary);
      }
      for (const [view, binding] of extras) {
        if (seen.has(view)) continue;
        if (binding.sessionId() !== target.sessionId) continue;
        deliver(view, msg, binding.bubbleOnly);
        seen.add(view);
      }
    },
    postRaw(msg, primary) {
      fanout(msg, primary);
    },
    postToExtras(msg) {
      for (const [view, binding] of extras) deliver(view, msg, binding.bubbleOnly);
    },
    hasSession(sessionId) {
      for (const binding of extras.values()) {
        if (binding.sessionId() === sessionId) return true;
      }
      return false;
    },
    size() {
      return extras.size;
    },
  };
}
