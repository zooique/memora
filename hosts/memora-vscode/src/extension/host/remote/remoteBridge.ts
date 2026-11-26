/**
 * 远程桥核心（L3 的落点）—— extension host 内的 WebSocket server，按会话投递命令
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §19.2：桥是**新入口**，真理源是「按 sid 的命令执行面」；桥只写差异段
 *     （传输、按 sid 订阅扇出、rid → 载荷映射），裁决 / 投递 / 投影一律调下游
 *   - §19.3 profile 2（`loopback`）：只绑 `127.0.0.1`、只读 + 可答、**仅开发验证不交付**
 *   - §6.5 / §6.6 / §6.7：封套 19 条、命令九条、快照语义
 *
 * ⚠️ 三条硬约束（§16.4，越界 = 方案作废）——本文件**刻意**没有这些东西：
 *   ① 不调 webview 的 `post()` / 不 import `chatPanel`：所有宿主能力经 `RemoteBridgePorts` 注入；
 *   ② 不做 `switch_session`：订阅只影响「发给谁」，不改 PC 当前显示会话；
 *   ③ 不绕过相位裁决直调内核：命令先过 `evaluateRemoteCommand` 真值表，
 *      `answer` 再交 `routeRemoteAnswer`（定址 + 查表 + 投递都不在这里重写）。
 *
 * profile 2 的能力边界（写在代码里，防止后来者把它读成「桥已完成」）：
 *   - 只发 `evt{kind:'snapshot', seq:0}`，**没有** `delta` 与水位补洞（`resume` 一律回 `reset_required`）；
 *   - 只投递 `answer`（只读 + 可答档）；其余命令回 `err{code:'forbidden'}`；
 *   - 无配对 / 指纹 / E2EE / 限流 / 审计（六项安全底线随 profile 3 同批落地）。
 */

import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { RoundView, TurnState } from '../../../shared/protocol.js';
import { routeRemoteAnswer } from './remoteAnswerRouter.js';
import { REMOTE_COMMAND_CODES, type RemotePhase } from './remoteCommandPolicy.js';
import {
  parseBridgeFrame,
  serializeBridgeFrame,
  type BridgeClientFrame,
  type BridgeServerFrame,
  type BridgeSessionSummary,
} from './remoteBridgeProtocol.js';

/**
 * 桥需要的宿主能力（**只读 + 投递**，全部由调用方注入）
 *
 * 刻意拆成五个窄函数而不是「把 chatPanel 传进来」：桥一旦能拿到面板实例，
 * 就会有人顺手调 `post()` / `switch_session`，三条硬约束当场失效。
 */
export interface RemoteBridgePorts {
  /** 会话列表投影（宿主按 `session_list_data` 子集口径给出） */
  listSessions: () => {
    sessions: readonly BridgeSessionSummary[];
    archivedIds: readonly string[];
    assistantSid?: string;
  };
  /** 该 sid 是否存在于会话存储（定址判据的唯一来源） */
  hasSession: (sessionId: string) => boolean;
  /** 该 sid 当前相位（由宿主按 `deriveSessionProjection` 折算，见 `remotePhaseOf`） */
  phaseOf: (sessionId: string) => RemotePhase;
  /** 该 sid 的只读投影（不含附件 URL；桥负责剥掉 webview 专属字段） */
  snapshot: (sessionId: string) => {
    state: TurnState;
    rounds: readonly RoundView[];
    pendingQueue: readonly string[];
  };
  /** 投递答复（实现必须就是 `handleInput({kind:'answer'})` 那条路） */
  deliverAnswer: (sessionId: string, answers: readonly string[]) => void;
}

/** 桥启动参数 */
export interface RemoteBridgeOptions {
  /** 稳定主机身份（多窗口区分用，§8-P1-8） */
  pcId: string;
  /** 能力协商（§6.8）：profile 2 只有 observe + answer */
  caps?: readonly string[];
  /** 端口；0 = 由系统分配（测试用），缺省 = 0（**不猜固定端口**，避免与真机端口占用混淆） */
  port?: number;
  /** 日志口（连接级 / 服务级异常只记这里，不弹窗、不抛给 VS Code 事件循环） */
  log?: (message: string) => void;
}

/** 单条连接的会话态（只存差异段：握手过的设备与它订阅了哪些 sid） */
interface ClientConnection {
  ws: WebSocket;
  /** 握手成功后的设备 id；undefined = 未完成 hello */
  deviceId?: string;
  /** 本连接订阅的会话集合（订阅生命周期与「手机在看哪个 tab」解耦，§19.6.3 第 2 条） */
  subs: Set<string>;
}

/** 默认能力协商（profile 2：只读 + 可答） */
const DEFAULT_CAPS = ['observe', 'answer'] as const;

/** 单帧上限（防开发客户端误发巨帧；正式限流随 profile 3） */
const DEFAULT_MAX_FRAME = 1024 * 1024;

/**
 * 远程桥（一个实例 = 一个 profile；回环 / LAN / 隧道只是启动参数的差别，§19.3）
 */
export class RemoteBridge {
  /** WS server（未 start 时 undefined；`stop()` 后复位） */
  private server?: WebSocketServer;
  /** 活动连接（stop 时统一关闭） */
  private readonly connections = new Set<ClientConnection>();
  /** 实际监听端口（未监听时 undefined） */
  private port?: number;

  constructor(
    private readonly ports: RemoteBridgePorts,
    private readonly options: RemoteBridgeOptions,
  ) {}

  /** 当前监听端口（未监听 = undefined；日志与开发客户端连接用） */
  get listeningPort(): number | undefined {
    return this.port;
  }

  /**
   * 开始监听
   *
   * **只绑 `127.0.0.1`**：绑定地址是安全边界（§19.1 第 3 条），不是可替换实现细节，
   * 故这里不接受 host 参数——要开 LAN 档必须走 profile 3 的六项安全底线，而不是改个字符串。
   *
   * @returns 实际端口（`port:0` 时由系统分配）
   * @throws 监听失败（端口占用 / 权限不足）——调用方必须显式报错并保持未监听态
   */
  start(): Promise<{ port: number }> {
    if (this.server) return Promise.reject(new Error('RemoteBridge already started'));
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: this.options.port ?? 0,
      maxPayload: DEFAULT_MAX_FRAME,
    });
    this.server = server;
    server.on('connection', (ws) => this.onConnection(ws));
    return new Promise((resolve, reject) => {
      // 监听失败必须冒泡（§16.2：禁止「失败但 UI 显示已连接」）
      server.once('error', (err) => {
        this.server = undefined;
        this.port = undefined;
        reject(err);
      });
      server.once('listening', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        this.port = port;
        // 监听后仍需一个常驻 error 监听：EventEmitter 的 'error' 无人接管会直接抛出，
        // 把扩展宿主进程拖崩（端口这类已建立的监听之后仍可能有底层错误）
        server.on('error', (err) =>
          this.options.log?.(`[REMOTE-BRIDGE] server error: ${String(err)}`),
        );
        resolve({ port });
      });
    });
  }

  /**
   * 停止监听并关闭全部连接
   *
   * 幂等：未启动时直接返回（deactivate 会无条件调用）。
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.port = undefined;
    for (const conn of this.connections) {
      // 1001 = going away：告诉对端是宿主主动关闭，不是网络故障
      conn.ws.close(1001, 'bridge stopped');
    }
    this.connections.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * 会话投影变化通知（**宿主 → 桥的推送触发口**）
   *
   * 由宿主在每次「该 sid 的 turn 投影可能变化」时调用（接线点见 chatPanel 的 onTurnProjected）；
   * 桥只对**已订阅该 sid** 的连接扇出一帧 `evt snapshot`。未监听 / 无订阅时零开销。
   *
   * ⚠️ profile 2 只发整帧快照（无 `delta`、无水位）：供本地回环上的开发客户端验证
   * 「后台会话状态实时可见」。真正的增量在 profile 3 落地时替换**帧形态**，
   * 本触发口（谁在什么时刻通知桥）不变——故这里是生长点而非一次性实现。
   *
   * @param sessionId 投影发生变化的会话
   */
  notifyTurnUpdate(sessionId: string): void {
    if (!this.server) return;
    for (const conn of this.connections) {
      if (conn.subs.has(sessionId)) this.pushSnapshot(conn, sessionId);
    }
  }

  // ─── 连接与帧分派 ───────────────────────────────────────────────────

  /** 新连接：登记 + 绑定两个事件（close 时移除，避免连接集合泄漏） */
  private onConnection(ws: WebSocket): void {
    const conn: ClientConnection = { ws, subs: new Set() };
    this.connections.add(conn);
    ws.on('close', () => this.connections.delete(conn));
    // 连接级错误必须接管：未接管的 'error' 会以未捕获异常形式冒到宿主进程
    ws.on('error', (err) => this.options.log?.(`[REMOTE-BRIDGE] connection error: ${String(err)}`));
    ws.on('message', (data) => this.onMessage(conn, data));
  }

  /** 收到一帧：解析 → 分派；解析失败按协议错误关闭（不伪装成业务错误码） */
  private onMessage(conn: ClientConnection, data: RawData): void {
    const result = parseBridgeFrame(data.toString());
    if (!result.ok) {
      // 畸形帧不是业务拒绝：用 WS 协议关闭码如实告知，避免把「帧写坏了」误报成相位错误
      conn.ws.close(1008, `bad frame: ${result.reason}`);
      return;
    }
    try {
      this.dispatch(conn, result.frame);
    } catch (err) {
      // 单个命令的宿主异常不得拖垮整条连接集合：记录后关闭该连接
      conn.ws.close(1011, `internal error: ${(err as Error).message}`);
    }
  }

  /** 按封套类型分派（先 `t` 再 `kind`，与 §6.3 层级约定一致） */
  private dispatch(conn: ClientConnection, frame: BridgeClientFrame): void {
    // 握手前只受理 hello：其余一律 forbidden（并断开——未握手的连接不该继续发帧）
    if (!conn.deviceId && frame.t !== 'hello') {
      this.send(conn, {
        t: 'err',
        ch: 'ctl',
        code: REMOTE_COMMAND_CODES.FORBIDDEN,
        msg: 'hello required',
      });
      conn.ws.close(1008, 'hello required');
      return;
    }
    switch (frame.t) {
      case 'hello':
        this.handleHello(conn, frame.deviceId);
        return;
      case 'ping':
        this.send(conn, { t: 'pong', ch: 'ctl' });
        return;
      case 'ack':
        // profile 2 无 credit 背压：确认帧只作解析（不拒，避免开发客户端误以为协议不认）
        return;
      case 'resume':
        // 无增量水位 ⇒ 只能重拉快照（§6.7 的 reset_required 语义），逐订阅会话如实告知
        for (const sid of conn.subs) {
          this.send(conn, { t: 'reset_required', ch: 'ctl', sid });
        }
        return;
      case 'sub':
        this.handleSub(conn, frame.sid);
        return;
      case 'unsub':
        conn.subs.delete(frame.sid);
        return;
      case 'session_list':
        this.handleSessionList(conn);
        return;
      case 'cmd':
        this.handleCommand(conn, frame);
        return;
    }
  }

  /** 握手应答（`assistantSid` 直接取宿主投影，桥不推断助手身份） */
  private handleHello(conn: ClientConnection, deviceId: string): void {
    conn.deviceId = deviceId;
    const assistantSid = this.ports.listSessions().assistantSid;
    const frame: BridgeServerFrame = {
      t: 'hello_ok',
      ch: 'ctl',
      serverTime: Date.now(),
      pcId: this.options.pcId,
      caps: this.options.caps ?? DEFAULT_CAPS,
      limits: { maxFrame: DEFAULT_MAX_FRAME, credit: 0 },
      assistantSid,
    };
    this.send(conn, frame);
  }

  /** 订阅：定址判据只问 `hasSession`；命中即回一次快照（`seq` 归零重建，§6.7） */
  private handleSub(conn: ClientConnection, sid: string): void {
    if (!this.ports.hasSession(sid)) {
      this.send(conn, {
        t: 'err',
        ch: 'events',
        sid,
        code: REMOTE_COMMAND_CODES.NO_SESSION,
      });
      return;
    }
    conn.subs.add(sid);
    this.pushSnapshot(conn, sid);
  }

  /** 会话列表（跨会话帧，不带 sid；助手会话由宿主投影决定是否排除） */
  private handleSessionList(conn: ClientConnection): void {
    const { sessions, archivedIds, assistantSid } = this.ports.listSessions();
    this.send(conn, { t: 'session_list_ok', ch: 'ctl', sessions, archivedIds, assistantSid });
  }

  /**
   * 业务命令
   *
   * 顺序不可换：**先权限档、再相位表、最后投递**。
   *   - 权限档：profile 2 只放行 `answer`（只读 + 可答），其余回 `forbidden`；
   *   - 相位表：由 `routeRemoteAnswer` 内部查 `evaluateRemoteCommand('answer', …)`——
   *     桥不自己再查一遍，避免「桥一套、路由一套」的两份判据；
   *   - 投递：`routeRemoteAnswer` 定址 + 查表 + 调宿主端口，三件事都不在桥里重写。
   */
  private handleCommand(
    conn: ClientConnection,
    frame: Extract<BridgeClientFrame, { t: 'cmd' }>,
  ): void {
    const { sid, rid, kind } = frame;
    if (kind !== 'answer') {
      this.send(conn, { t: 'err', ch: 'cmd', rid, sid, code: REMOTE_COMMAND_CODES.FORBIDDEN });
      return;
    }
    const answers = readAnswers(frame.p);
    if (!answers) {
      // 载荷写坏了 → 协议错误（不是相位问题，也不是权限问题）
      conn.ws.close(1008, 'cmd.p.answers must be string[]');
      return;
    }
    const decision = routeRemoteAnswer(sid, answers, {
      hasSession: (id) => this.ports.hasSession(id),
      // 相位素材来自宿主投影（`remotePhaseOf` 是唯一折算点，桥不再从 TurnState 推第二遍）
      phaseOf: (id) => this.ports.phaseOf(id),
      deliverAnswer: (id, list) => this.ports.deliverAnswer(id, list),
    });
    if (!decision.ok) {
      this.send(conn, { t: 'err', ch: 'cmd', rid, sid, code: decision.code });
      return;
    }
    // 受理后立刻回推该会话快照：开发客户端无需再发一次 sub 就能看到相位变化
    if (conn.subs.has(sid)) this.pushSnapshot(conn, sid);
  }

  /** 回推一次快照（profile 2 唯一的下行事件形态） */
  private pushSnapshot(conn: ClientConnection, sid: string): void {
    const snapshot = this.ports.snapshot(sid);
    this.send(conn, {
      t: 'evt',
      ch: 'events',
      sid,
      seq: 0,
      kind: 'snapshot',
      p: {
        state: snapshot.state,
        // 附件预览 URL 是 webview 专属产物（远端 origin 必 404，方案 §6.4 第 2 条），出桥前剥掉
        rounds: snapshot.rounds.map(({ attachmentUris: _unused, ...rest }) => rest),
        pendingQueue: snapshot.pendingQueue,
      },
    });
  }

  /** 发送一帧（连接已关闭时静默丢弃——发送失败不改变任何业务裁决） */
  private send(conn: ClientConnection, frame: BridgeServerFrame): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(serializeBridgeFrame(frame));
  }
}

/** 从命令载荷里取答复数组（**不做 trim / 过滤**：答案位次不变量归内核与 handleInput） */
function readAnswers(payload: unknown): readonly string[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const answers = (payload as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return undefined;
  if (!answers.every((a): a is string => typeof a === 'string')) return undefined;
  return answers;
}
