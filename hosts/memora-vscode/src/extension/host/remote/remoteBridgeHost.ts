/**
 * 远程桥的宿主适配（端口实现）—— 把宿主既有能力收成 `RemoteBridgePorts`
 *
 * 设计源：docs/方案-手机远程控制-20261110.md §19.2（真源 = 按 sid 的命令执行面）、
 *   §19.3 profile 2（`loopback`：只绑 127.0.0.1、只读 + 可答、仅开发验证不交付）
 *
 * 为什么单独一层：桥核心（`remoteBridge.ts`）刻意不 import 面板，宿主能力全部经端口注入。
 * 本文件就是那段「差异段」——只回答「sid / 载荷 / 投影素材从哪来」，不复制任何裁决：
 *   - 会话列表 → `buildSessionListMessage`（webview 历史列表的同一构建点）
 *   - 投影     → `chatPanel.projectSessionForBridge`（与侧栏共用 `deriveSessionProjection`）
 *   - 相位     → `remotePhaseOf`（唯一折算点）
 *   - 答复投递 → `chatPanel.submitBridgeInput`（落到同一个 `handleInput`）
 */

import * as vscode from 'vscode';
import type { HostSessionStore } from '../sessionStore.js';
import { buildSessionListMessage } from '../../../webview/helpers/sessionList.js';
import type { WebviewToExtensionMessage } from '../../../shared/protocol.js';
import type { SessionViewProjection } from '../../../shared/sessionProjection.js';
import { remotePhaseOf } from './remoteCommandPolicy.js';
import { RemoteBridge, type RemoteBridgePorts } from './remoteBridge.js';

/** 桥需要的面板窄接口（只列本适配用到的三个方法，防止顺手把整个面板传进桥） */
export interface RemotePanelPort {
  /** 任意 sid 的投影（无副作用：不写 `_turnStates`、不投递、不盖章附件 URL） */
  projectSession: (sessionId: string) => SessionViewProjection;
  /** 远程命令投递（与 webview 落到同一个 `handleInput`；**参数顺序照抄面板**，不重排） */
  handleInput: (
    msg: Extract<WebviewToExtensionMessage, { type: 'input' }>,
    sessionId: string,
  ) => Promise<void>;
  /** 助手会话 id（工作区指针；宿主的唯一身份来源，桥不推断） */
  getAssistantSessionId: () => string | undefined;
}

/** 适配所需的宿主依赖 */
export interface RemoteBridgeHostDeps {
  /** 面板（投影 + 投递口） */
  panel: RemotePanelPort;
  /** 会话存储（定址判据 + 列表投影素材） */
  store: HostSessionStore;
  /** 日志口（扩展输出通道） */
  log: (message: string) => void;
}

/**
 * 把宿主能力收成桥端口
 *
 * @param deps 面板 + 会话存储 + 日志口
 */
export function createRemoteBridgePorts(deps: RemoteBridgeHostDeps): RemoteBridgePorts {
  const { panel, store } = deps;
  return {
    // 列表：currentSessionId 传空串 = 不排除任何会话（手机端有自己的「当前」概念）；
    // 助手会话仍排除（它不是工作会话，助手身份经 hello_ok.assistantSid 单独下发）
    listSessions: () => {
      const assistantSid = panel.getAssistantSessionId();
      const message = buildSessionListMessage(store, '', vscode.l10n, undefined, assistantSid);
      return { sessions: message.sessions, archivedIds: message.archivedIds, assistantSid };
    },
    // 定址：只认存储里的会话 id（草稿态无 id，天然落空 ⇒ no_session，§6.6 断路器）
    hasSession: (sessionId) => store.listSessions().includes(sessionId),
    // 相位：素材来自实时投影（不是 `_turnStates` —— 那份只在有视图时更新）
    phaseOf: (sessionId) => remotePhaseOf(panel.projectSession(sessionId).state, false),
    snapshot: (sessionId) => panel.projectSession(sessionId),
    // 投递：与 webview 同一个入口；失败只记日志（投递可靠性不靠桥重试，靠手机重拉快照）
    deliverAnswer: (sessionId, answers) => {
      void panel
        .handleInput({ type: 'input', kind: 'answer', answers: [...answers] }, sessionId)
        .catch((err: unknown) => {
          deps.log(`[REMOTE-BRIDGE] 答复投递失败 sid=${sessionId}: ${String(err)}`);
        });
    },
  };
}

/** 开发启动参数（默认不监听；只有显式设置环境变量才走到这里） */
export const REMOTE_BRIDGE_ENV = 'MEMORA_REMOTE_BRIDGE';
/** 开发端口覆盖（缺省 0 = 系统分配；日志里会打印实际端口） */
export const REMOTE_BRIDGE_PORT_ENV = 'MEMORA_REMOTE_BRIDGE_PORT';

/**
 * 按环境变量启动回环桥（profile 2 · 仅开发验证）
 *
 * **默认不监听**（D1：入站端口是风险最高的一条，不默认开）。监听失败必须显式报错并
 * 保持未监听态（§16.2），故这里把异常转成用户可见的警告，而不是静默吞掉。
 *
 * @param deps 宿主依赖
 * @returns 桥实例（未监听时也返回实例，便于 `deactivate` 无条件 `stop()`）
 */
export async function startRemoteBridgeForDev(
  deps: RemoteBridgeHostDeps,
): Promise<RemoteBridge | undefined> {
  // 未设置开关 ⇒ 不创建实例、不开端口（默认关）
  if (process.env[REMOTE_BRIDGE_ENV] !== '1') return undefined;
  const rawPort = Number.parseInt(process.env[REMOTE_BRIDGE_PORT_ENV] ?? '0', 10);
  const port = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 0;
  const bridge = new RemoteBridge(createRemoteBridgePorts(deps), {
    pcId: 'memora-loopback',
    port,
    log: deps.log,
  });
  try {
    const started = await bridge.start();
    deps.log(`[REMOTE-BRIDGE] listening on 127.0.0.1:${started.port}（profile 2 · 仅开发验证）`);
    void vscode.window.showInformationMessage(
      `Memora 远程桥（开发验证）已监听 127.0.0.1:${started.port}`,
    );
  } catch (err) {
    // 端口占用 / 权限不足：显式报错 + 保持未监听（禁止「失败但 UI 显示已连接」）
    deps.log(`[REMOTE-BRIDGE] 启动失败: ${String(err)}`);
    void vscode.window.showWarningMessage(`Memora 远程桥启动失败：${String(err)}`);
  }
  return bridge;
}
