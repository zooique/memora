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
 *   ③ 不绕过裁决直调内核：命令先过档位门 `evaluateTierGate`（§5.9）与相位表
 *      `evaluateRemoteCommand`，再交 `routeRemoteCommand`（定址 + 查表 + 投递都不在这里重写）。
 *
 * profile 2 的能力边界（写在代码里，防止后来者把它读成「桥已完成」）：
 *   - 只发 `evt{kind:'snapshot', seq:0}`，**没有** `delta` 与水位补洞（`resume` 一律回 `reset_required`）；
 *   - **只投递 `answer`**（回环档可能被任意本地进程连上，不放开写命令）；其余命令回 `err{code:'forbidden'}`；
 *   - 回环档（`security` 缺省）无配对 / 指纹 / 限流 / 审计，只绑 `127.0.0.1`。
 *
 * profile 3（LAN）的差异段（§5.9 / §16.2 / §19.9）——**判据全部由宿主经 `security` 注入**：
 *   - 连接层：设备指纹来自 TLS 客户端证书（`security.fingerprintOf`）；
 *   - 握手层：`phoneFp` 必须与 TLS 指纹一致；未配对需一次性口令 + PC 人工批准；
 *   - 命令层：设备权限档由 `security.tierOf` 决定，档位门查 `evaluateTierGate`；
 *     **本轮已接入** `answer` / `send` / `resume`（落 `handleInput`）与 `confirm_answer`
 *     （落 `ConfirmCoordinator.answerFor`，M3 审批裁决）；其余五条虽在档位表内，
 *     但宿主尚无按 sid 的落点 ⇒ 一律回 `forbidden`（**未接入**，不是相位/档位拒绝）；
 *   - 旁路：失败限流（`security.rateLimit`）与追加式审计（`security.audit`）。
 *   桥**不自己**判指纹 / 档位 / 口令——那会在真理源之外造第二份判据。
 */

import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import {
  routeConfirmAnswer,
  routeRemoteCommand,
  type ConfirmAnswerCommand,
  type RemoteInputCommand,
  type RemoteInputMessage,
} from './remoteCommandRouter.js';
import {
  REMOTE_COMMAND_CODES,
  REMOTE_CTL_CODES,
  evaluateTierGate,
  type RemoteCommand,
  type RemotePhase,
} from './remoteCommandPolicy.js';
import { normalizeFingerprint, shortFingerprint } from './remoteFingerprint.js';
import type { RemoteDeviceTier } from './remoteDevices.js';
import type { RemoteRateLimitState } from './remoteRateLimiter.js';
import type { PairingVerdict } from './remotePairing.js';
import {
  buildAppendTextDeltaFrame,
  buildConfirmAttentionFrame,
  buildProcessEventDeltaFrame,
  buildResetRequiredFrame,
  buildResumeOkFrame,
  buildSnapshotFrame,
  buildStatusDeltaFrame,
  parseBridgeFrame,
  serializeBridgeFrame,
  type BridgeClientFrame,
  type BridgeServerFrame,
  type BridgeSessionSummary,
  type EvtFrame,
  type SnapshotPayload,
} from './remoteBridgeProtocol.js';
import { diffRichDelta, initRichCursor, type RichCursor } from './remoteDeltaDiff.js';

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
  /** 该 sid 的只读投影（出桥前的裁剪见 `remoteSnapshotTrim`，端口不自行裁） */
  snapshot: (sessionId: string) => SnapshotPayload;
  /** 投递输入（实现必须就是 `panel.handleInput(input, sid)` 那条路，不另建投递链） */
  deliverInput: (sessionId: string, input: RemoteInputMessage) => void;
  /**
   * 按 sid + requestId 裁决执行类审批（实现必须就是 `ConfirmCoordinator.answerFor`，不自己 resolve）
   *
   * 返回值语义：`true` = 该会话在途请求的 id 匹配且已裁决；`false` = 无在途 / id 不匹配 /
   * 迟到回执（桥映射为 `stale_phase`）。**不返回业务成功与否**——内核执行结果是另一条流。
   * 与 `deliverInput` 分开：审批裁决走确认协调器，不是 `handleInput` 的输入消息。
   */
  answerConfirm: (sessionId: string, requestId: string, approved: boolean) => boolean;
}

/**
 * 桥的安全端口（profile 3 / LAN 档；**全部由宿主注入，桥不自己判**）
 *
 * 这一层刻意只收窄函数：桥回答「谁在连、他是什么档、口令对不对、准不准入、要不要记账」，
 * 但每个答案的生产权都在宿主（TLS 证书 / 设备表 / 一次性口令 / 限流器 / 审计文件）。
 * 若桥自己实现其中任何一条，就会出现「桥一套、宿主一套」的两份判据（§19.2 不变量 1）。
 */
export interface RemoteBridgeSecurity {
  /** 已认证设备指纹（来自 TLS 客户端证书；取不到 = 未认证连接） */
  fingerprintOf: (socket: unknown) => string | undefined;
  /** 已配对设备的权限档（undefined = 未配对） */
  tierOf: (fingerprint: string) => RemoteDeviceTier | undefined;
  /** 校验一次性配对口令（语义见 `remotePairing`） */
  verifyPasscode: (code: string) => PairingVerdict;
  /** 首次配对：请求 PC 侧人工批准（true = 允许） */
  requestApproval: (info: {
    fingerprint: string;
    shortFp: string;
    name: string;
    ip?: string;
  }) => Promise<boolean>;
  /** 配对通过后登记设备（默认 `observe` 档由宿主实现决定） */
  registerDevice: (info: { fingerprint: string; shortFp: string; name: string }) => void;
  /** 失败限流（按 IP / 指纹维度） */
  rateLimit: {
    check(key: string): RemoteRateLimitState;
    noteFailure(key: string): RemoteRateLimitState;
    noteSuccess(key: string): void;
  };
  /** 追加式审计（实现必须永不 reject；返回 Promise 时 `stop()` 会等它落盘） */
  audit: (event: {
    event: string;
    deviceFp?: string;
    ip?: string;
    detail?: string;
  }) => void | Promise<void>;
}

/** 桥启动参数 */
export interface RemoteBridgeOptions {
  /** 稳定主机身份（多窗口区分用，§8-P1-8） */
  pcId: string;
  /** 能力协商（§6.8）：回环档只有 observe + answer */
  caps?: readonly string[];
  /** 端口；0 = 由系统分配（测试用），缺省 = 0（**不猜固定端口**，避免与真机端口占用混淆） */
  port?: number;
  /**
   * 监听地址；缺省 `127.0.0.1`
   *
   * 绑定地址是安全边界（§16.2 G1）：LAN 档由宿主显式传 `0.0.0.0`，桥不替用户决定暴露面。
   */
  host?: string;
  /**
   * 外部 HTTPS server（LAN 档）
   *
   * 提供时桥用 `new WebSocketServer({ server })` 挂上来，并在 `start()` 里让它监听；
   * 不提供时桥自己建 WS server 并只绑 `127.0.0.1`（回环档现状）。
   */
  server?: HttpsServer;
  /** 安全端口（提供 = LAN 档；缺省 = 回环档，行为与 profile 2 一致） */
  security?: RemoteBridgeSecurity;
  /** 日志口（连接级 / 服务级异常只记这里，不弹窗、不抛给 VS Code 事件循环） */
  log?: (message: string) => void;
}

/** 单条连接的会话态（只存差异段：握手过的设备与它订阅了哪些 sid） */
interface ClientConnection {
  ws: WebSocket;
  /** 握手成功后的设备 id；undefined = 未完成 hello */
  deviceId?: string;
  /** TLS 客户端证书指纹（LAN 档；undefined = 未认证 / 回环档） */
  deviceFp?: string;
  /** 来源 IP（限流维度 + 审计留痕；undefined = 取不到） */
  peerIp?: string;
  /** 本连接订阅的会话集合（订阅生命周期与「手机在看哪个 tab」解耦，§19.6.3 第 2 条） */
  subs: Set<string>;
  /**
   * 流中推送定时器（按 sid；仅 LAN 档且该会话处于 running 时存在）
   *
   * 宿主在流中每次正文 chunk 都调 `notifyTurnUpdate` 会因 chatPanel 行数顶格而无法接线，
   * 故流中富增量改由桥侧定时器驱动（§6.7 的 200–300ms 文本合并）。一条连接一份，
   * 键 = sid；`undefined` 表示本连接未武装任何 tick。
   */
  timers?: Map<string, NodeJS.Timeout>;
}

/** 默认能力协商（profile 2：只读 + 可答） */
const DEFAULT_CAPS = ['observe', 'answer'] as const;

/** 单帧上限（防开发客户端误发巨帧；正式限流随 profile 3） */
const DEFAULT_MAX_FRAME = 1024 * 1024;

/** 每设备每会话的增量窗口上限（§6.7：500 条 / 2MB，先到为准） */
const MAX_DELTA_FRAMES = 500;
const MAX_DELTA_WINDOW_BYTES = 2 * 1024 * 1024;

/**
 * 流中富增量推送周期（毫秒）
 *
 * 取自 §6.7 的「文本流 200–300ms 合并」区间中值：既让手机上的正文按可读节奏增长，
 * 又不会把每个 token 都变成一帧（那正是富 delta 要消除的伤）。
 */
const STREAM_TICK_MS = 250;

/** 回放窗内的一帧（`bytes` 用 UTF-8 实测，不拿字符数冒充） */
interface DeltaWindowEntry {
  seq: number;
  frame: EvtFrame;
  bytes: number;
}

/** 单设备单会话的发送水位与回放窗（§6.8 的 `subscribers[device][sid]` 拍平实现） */
interface DeviceStreamState {
  sentSeq: number;
  window: DeltaWindowEntry[];
  windowBytes: number;
  /** 富增量游标（正文前缀 + 事件 seq）；sub 时按当前快照初始化，防历史当增量重发 */
  rich: RichCursor;
}

/**
 * 远程桥（一个实例 = 一个 profile；回环 / LAN / 隧道只是启动参数的差别，§19.3）
 */
export class RemoteBridge {
  /** WS server（未 start 时 undefined；`stop()` 后复位） */
  private server?: WebSocketServer;
  /** 外部 HTTPS server（LAN 档；stop 时一并关闭，幂等） */
  private externalServer?: HttpsServer;
  /** 活动连接（stop 时统一关闭） */
  private readonly connections = new Set<ClientConnection>();
  /** 每设备每会话的水位与回放窗（跨断连保留，设备撤销 / stop 才清） */
  private readonly streams = new Map<string, DeviceStreamState>();
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
   * 两种形态（同一个 `start()`，差异只在是否有外部 server）：
   *   - **回环档**（无 `server`）：桥自建 WS server，**只绑 `127.0.0.1`**——
   *     绑定地址是安全边界（§16.2 G1），不接受 host 参数；
   *   - **LAN 档**（有 `server`）：挂在宿主传入的 HTTPS server 上，由它监听 `host` / `port`；
   *     安全底线（TLS / 配对 / 限流 / 审计）由 `security` 端口提供。
   *
   * @returns 实际端口（`port:0` 时由系统分配）
   * @throws 监听失败（端口占用 / 权限不足）——调用方必须显式报错并保持未监听态
   */
  start(): Promise<{ port: number }> {
    if (this.server) return Promise.reject(new Error('RemoteBridge already started'));
    const external = this.options.server;
    const server = external
      ? new WebSocketServer({ server: external, maxPayload: DEFAULT_MAX_FRAME })
      : new WebSocketServer({
          host: '127.0.0.1',
          port: this.options.port ?? 0,
          maxPayload: DEFAULT_MAX_FRAME,
        });
    this.server = server;
    this.externalServer = external;
    // 连接回调带 req：LAN 档要从 `req.socket` 取 TLS 指纹与来源 IP
    server.on('connection', (ws, req) => this.onConnection(ws, req));
    // 常驻 error 监听：EventEmitter 的 'error' 无人接管会直接抛出，把扩展宿主进程拖崩
    server.on('error', (err) => this.options.log?.(`[REMOTE-BRIDGE] server error: ${String(err)}`));
    // 有外部 server 时，监听事件发在它身上（ws 只是 upgrade 的旁挂）
    const listenTarget = external ?? server;
    return new Promise((resolve, reject) => {
      // 监听失败必须冒泡（§16.2：禁止「失败但 UI 显示已连接」）
      listenTarget.once('error', (err) => {
        this.server = undefined;
        this.externalServer = undefined;
        this.port = undefined;
        reject(err);
      });
      listenTarget.once('listening', () => {
        const address = listenTarget.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        this.port = port;
        // 外部 HTTPS server 的常驻 error 监听（除上面的 reject 监听外还要兜后续错误）
        if (external) {
          external.on('error', (err) =>
            this.options.log?.(`[REMOTE-BRIDGE] https server error: ${String(err)}`),
          );
        }
        resolve({ port });
      });
      if (external) {
        external.listen({ host: this.options.host ?? '127.0.0.1', port: this.options.port ?? 0 });
      }
    });
  }

  /**
   * 停止监听并关闭全部连接
   *
   * 幂等：未启动时直接返回（deactivate 会无条件调用）。带外部 server 时一并关闭它
   * （half-open 的 HTTPS server 比「关干净」更危险：端口占着、却没有 WS 消费者）。
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    const external = this.externalServer;
    this.server = undefined;
    this.externalServer = undefined;
    this.port = undefined;
    for (const conn of this.connections) {
      // 停桥即停流中 tick：定时器不清会继续对已关闭连接触发（虽 send 会静默丢弃，但句柄泄漏）
      this.clearAllStreamTicks(conn);
      // 1001 = going away：告诉对端是宿主主动关闭，不是网络故障
      conn.ws.close(1001, 'bridge stopped');
    }
    this.connections.clear();
    this.streams.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (external) {
      await new Promise<void>((resolve) => {
        if (!external.listening) {
          resolve();
          return;
        }
        external.close(() => resolve());
      });
    }
    // 监听停止是安全事实（§16.2 G5）：只在实际监听过的 LAN 档（有 security）留痕。
    // ⚠️ 必须 **await**：deactivate 里 stop() 返回后扩展宿主进程随即退出，
    // fire-and-forget 的 append 会来不及落盘（真机实测丢过 bridge_stopped）。
    // 边界：Shift+F5 / 进程被杀等**强杀**不执行 deactivate，该路径没有停止审计
    // （与 `extension.ts` deactivate 已登记的「崩溃 / 强杀不承诺清理」同一边界）。
    const security = this.options.security;
    if (security) {
      try {
        await security.audit({ event: 'bridge_stopped' });
      } catch (err) {
        this.options.log?.(`[REMOTE-BRIDGE] audit failed: ${String(err)}`);
      }
    }
  }

  /**
   * 断开某台已配对设备的全部连接（设备撤销时调用）
   *
   * 判据用 `conn.deviceFp`（TLS 层认证过的指纹），**不信**客户端自称的 `deviceId`：
   * LAN 档 `deviceId` 已由握手归一为指纹，但回环档没有指纹，故回环下恒为 0。
   *
   * 为什么必须断开而不是只靠 `tierOf` 拒绝：撤销后连接仍在，订阅的 `evt snapshot`
   * 会继续推送会话内容——「撤销」必须连读权限一起终止（§5.9 撤销语义）。
   *
   * @param fingerprint 设备证书指纹（大小写不敏感）
   * @returns 实际断开的连接数
   */
  disconnectDevice(fingerprint: string): number {
    const target = normalizeFingerprint(fingerprint);
    let closed = 0;
    for (const conn of this.connections) {
      if (conn.deviceFp !== target) continue;
      // 撤销 = 读通道恒终止：流中 tick 也一并停掉，避免断开前的最后几拍仍推内容
      this.clearAllStreamTicks(conn);
      conn.ws.close(1008, 'device revoked');
      closed += 1;
    }
    // 撤销 = 读通道与水一起终止：回放窗若留着，重连后仍能补出已撤销设备的会话增量
    // ⚠️ 前缀必须是**真 NUL**（与 `streamKey()` 的 `\u0000` 同源）。写成 `\\u0000`
    // 是字面反斜杠+u0000 六字符，startsWith 永不命中 ⇒ 回放窗清不掉。
    for (const key of [...this.streams.keys()]) {
      if (key.startsWith(`${target}\u0000`)) this.streams.delete(key);
    }
    return closed;
  }

  /**
   * 会话投影变化通知（**宿主 → 桥的推送触发口**）
   *
   * 由宿主在每次「该 sid 的 turn 投影可能变化」时调用（接线点见 chatPanel 的 onTurnProjected）；
   * 桥只对**已订阅该 sid** 的连接扇出。未监听 / 无订阅时零开销。
   *
   * ⚠️ 帧形态按档分：profile 2 仍发整帧 `evt snapshot`（seq 恒 0，无水位）；profile 3
   * 发 `evt delta`（先 `p.kind:'status'`，再按需追加 `append_text` / `process_event`；
   * seq 按设备独立递增并进回放窗）。本触发口（谁在什么时刻通知桥）两档共用，
   * 富 `delta.kind` 已在此生长，不改接线。
   *
   * ⚠️ 流中节奏由谁驱动：宿主只在**生命周期节点**（开流 / 提问 / 插话变长 / 收场）通知，
   * 正文 chunk 与 process_event 逐条**不通知**（chatPanel 行数顶格，无处接线）。因此
   * profile 3 在 running 期间由桥侧 250ms tick 补推富增量（见 `onStreamTick`）；本口每次
   * 通知仍保证 status 相位不丢——tick **只推富增量、不推 status**，两条职责不重叠。
   *
   * @param sessionId 投影发生变化的会话
   */
  notifyTurnUpdate(sessionId: string): void {
    if (!this.server) return;
    const subscribers = [...this.connections].filter((conn) => conn.subs.has(sessionId));
    if (subscribers.length === 0) return;
    // 流中 tick 只服务 LAN 档；回环档（无 security）继续整帧快照，不武装定时器。
    // 相位取一次快照（同一 sid 对所有订阅者同值），不让每条连接各读一遍。
    const running = this.options.security
      ? this.ports.snapshot(sessionId).state.phase === 'running'
      : false;
    for (const conn of subscribers) {
      this.pushUpdate(conn, sessionId);
      // running 期间武装 250ms tick 补推流中富增量；离开 running 立刻停表（收场内容由本拍 pushDelta 带走）
      if (running) this.armStreamTick(conn, sessionId);
      else this.disarmStreamTick(conn, sessionId);
    }
  }

  /**
   * 按 sid 广播审批提醒（`attention` + `kind:'confirm'`，§6.5 / M3）
   *
   * 与 `notifyTurnUpdate` 同构的"宿主通知 → 桥扇出"生长点：只发给订阅了该会话的连接，
   * 不切换 PC 焦点（§16.4）。帧构造走唯一入口 `buildConfirmAttentionFrame`。
   *
   * ⚠️ 提醒与相位分工：`pendingCount>0` 已让 `phaseOf` 折算为 `confirm-pending`（挡 send/answer），
   * 本方法只负责"把 requestId 送到手机"——手机没有 requestId 就构造不出合法回执，
   * 那才是上轮"只加字段"留下的假闭环。无 requestId（如非 confirm 类提醒）时不发。
   *
   * @param sessionId 会话定址
   * @param requestId 待裁决请求 id（来自 `ConfirmCoordinator` 的 in-flight 项）
   * @param label     `工具：文件名` 简写，禁传全文
   */
  notifyAttention(sessionId: string, requestId: string, label?: string): void {
    if (!this.server || !requestId) return;
    const frame = buildConfirmAttentionFrame(sessionId, requestId, label);
    for (const conn of this.connections) {
      if (conn.subs.has(sessionId)) this.send(conn, frame);
    }
  }

  // ─── 连接与帧分派 ───────────────────────────────────────────────────

  /**
   * 新连接：登记 + 绑定两个事件（close 时移除，避免连接集合泄漏）
   *
   * LAN 档额外做一次 TLS 身份采集：`security` 存在却取不到客户端证书指纹 ⇒ 立刻断开
   * （不回业务帧，避免给探测者任何信号），并留一条审计。
   */
  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const conn: ClientConnection = {
      ws,
      subs: new Set(),
      peerIp: req.socket.remoteAddress,
    };
    const security = this.options.security;
    if (security) {
      const fingerprint = security.fingerprintOf(req.socket);
      if (!fingerprint) {
        this.audit(security, { event: 'tls_identity_missing', ip: conn.peerIp });
        ws.close(1008, 'tls identity missing');
        return;
      }
      conn.deviceFp = fingerprint;
    }
    this.connections.add(conn);
    ws.on('close', () => {
      this.connections.delete(conn);
      // 连接关闭必须停掉本连接所有流中 tick（否则定时器对着死连接空转，句柄泄漏）
      this.clearAllStreamTicks(conn);
      // 已握手设备的断开也留痕（只记完成 hello 的连接：握手前的探测断开不制造噪音）
      if (security && conn.deviceFp && conn.deviceId) {
        this.audit(security, {
          event: 'device_disconnected',
          deviceFp: conn.deviceFp,
          ip: conn.peerIp,
        });
      }
    });
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
        // 握手可能 await 人工批准：异步失败必须收回本连接，不能漏成未处理拒绝
        void this.handleHello(conn, frame).catch((err: unknown) => {
          this.options.log?.(`[REMOTE-BRIDGE] hello failed: ${String(err)}`);
          conn.ws.close(1011, 'hello failed');
        });
        return;
      case 'ping':
        this.send(conn, { t: 'pong', ch: 'ctl' });
        return;
      case 'ack':
        // profile 2 无 credit 背压：确认帧只作解析（不拒，避免开发客户端误以为协议不认）
        return;
      case 'resume':
        this.handleResume(conn, frame);
        return;
      case 'sub':
        this.handleSub(conn, frame.sid);
        return;
      case 'unsub':
        conn.subs.delete(frame.sid);
        // 退订即停该 sid 的流中 tick（不再为已退订会话轮询快照）
        this.disarmStreamTick(conn, frame.sid);
        return;
      case 'session_list':
        this.handleSessionList(conn);
        return;
      case 'cmd':
        this.handleCommand(conn, frame);
        return;
    }
  }

  /**
   * 握手（回环档 = 直接接受；LAN 档 = 指纹核对 + 已配对判定 + 一次性口令 + 人工批准）
   *
   * 判据顺序不可换（§5.3 / §5.8 / §5.9）：
   *   ① TLS 身份必须存在（连接层已拦，这里只是防御分支）；
   *   ② `phoneFp`（客户端声明）必须等于 TLS 证书指纹——声明与证书不符 = 冒充；
   *   ③ 已配对（设备表有该指纹）⇒ 直接 `hello_ok`，不弹窗（首次信任即固定，§5.4）；
   *   ④ 未配对 ⇒ 先查限流（封禁中直接拒绝），再校验一次性口令，最后 PC 人工批准；
   *   ⑤ 批准 ⇒ 登记为 `observe` 档（默认最小权限，§5.9）并清掉失败计数。
   */
  private async handleHello(
    conn: ClientConnection,
    frame: Extract<BridgeClientFrame, { t: 'hello' }>,
  ): Promise<void> {
    const security = this.options.security;
    if (!security) {
      // 回环档（profile 2）：保持今天的行为——不校验 phoneFp、不需要 pid
      conn.deviceId = frame.deviceId;
      this.sendHelloOk(conn);
      return;
    }
    const deviceFp = conn.deviceFp;
    if (!deviceFp) {
      // 正常路径不会到这里（连接层已断开）；保留分支是为了 fail-closed，而不是 fail-open。
      // 不新增文档外错误码：未认证连接按「不给探测信号」直接断开（§4.5.5）。
      this.audit(security, { event: 'hello_identity_missing', ip: conn.peerIp });
      conn.ws.close(1008, 'tls identity missing');
      return;
    }
    if (frame.phoneFp.trim().toUpperCase() !== deviceFp) {
      this.audit(security, {
        event: 'hello_fp_mismatch',
        deviceFp,
        ip: conn.peerIp,
        detail: 'phoneFp 与 TLS 证书指纹不符',
      });
      this.send(conn, { t: 'err', ch: 'ctl', code: REMOTE_CTL_CODES.BAD_PASSCODE });
      conn.ws.close(1008, 'phone fingerprint mismatch');
      return;
    }
    // 已配对：首次信任已固定，后续连接只校验指纹，不再弹窗（§5.4）
    if (security.tierOf(deviceFp)) {
      conn.deviceId = deviceFp;
      this.audit(security, { event: 'device_connected', deviceFp, ip: conn.peerIp });
      this.sendHelloOk(conn);
      return;
    }
    // ── 未配对：限流 → 口令 → 人工批准（三步缺一不可） ──
    const ip = conn.peerIp ?? 'unknown';
    if (security.rateLimit.check(ip).blocked) {
      this.audit(security, { event: 'pairing_rate_limited', deviceFp, ip });
      this.send(conn, { t: 'err', ch: 'ctl', code: REMOTE_CTL_CODES.BAD_PASSCODE });
      conn.ws.close(1008, 'rate limited');
      return;
    }
    const verdict = security.verifyPasscode(frame.pid ?? '');
    if (verdict !== 'ok') {
      security.rateLimit.noteFailure(ip);
      this.audit(security, { event: 'pairing_rejected', deviceFp, ip, detail: verdict });
      this.send(conn, { t: 'err', ch: 'ctl', code: REMOTE_CTL_CODES.BAD_PASSCODE });
      conn.ws.close(1008, 'pairing rejected');
      return;
    }
    const shortFp = shortFingerprint(deviceFp);
    const approved = await security.requestApproval({
      fingerprint: deviceFp,
      shortFp,
      name: frame.deviceId,
      ip: conn.peerIp,
    });
    // 审批期间连接可能已断开（用户取消 / 网络断了）：不再尝试回帧
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (!approved) {
      security.rateLimit.noteFailure(ip);
      this.audit(security, { event: 'pairing_denied', deviceFp, ip });
      this.send(conn, { t: 'err', ch: 'ctl', code: REMOTE_CTL_CODES.BAD_PASSCODE });
      conn.ws.close(1008, 'pairing denied');
      return;
    }
    security.registerDevice({ fingerprint: deviceFp, shortFp, name: frame.deviceId });
    security.rateLimit.noteSuccess(ip);
    this.audit(security, { event: 'device_paired', deviceFp, ip });
    // 配对成功同时就是一次「已连接」：两个事实分别写，事后可按连接/配对两种视角回查
    this.audit(security, { event: 'device_connected', deviceFp, ip });
    conn.deviceId = deviceFp;
    this.sendHelloOk(conn);
  }

  /** 握手应答（`assistantSid` 直接取宿主投影，桥不推断助手身份） */
  private sendHelloOk(conn: ClientConnection): void {
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

  /** 审计旁路（实现约定永不抛出；这里再兜一层，保证审计异常不影响握手 / 连接） */
  private audit(
    security: RemoteBridgeSecurity,
    event: { event: string; deviceFp?: string; ip?: string; detail?: string },
  ): void {
    try {
      security.audit(event);
    } catch (err) {
      this.options.log?.(`[REMOTE-BRIDGE] audit failed: ${String(err)}`);
    }
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
    // 订阅即快照归零重建（§6.7）：profile 3 同步重置该设备该会话的发送水位与回放窗
    if (this.options.security) this.resetStream(this.deviceOf(conn), sid);
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
   * 顺序不可换：**先档位门、再载荷解析、最后定址/相位/投递**。
   *   - 档位门：LAN 档查 `evaluateTierGate`（设备档由宿主设备表给出）；回环档保持
   *     profile 2 能力边界——只放行 `answer`，不因「没有档位表」就默认高权限；
   *   - 载荷解析：本切片的桥层职责（未知/未接入命令 → `forbidden`；写坏 → 断开连接）；
   *   - 定址 + 相位 + 投递：全在 `routeRemoteCommand`，桥不自己再查一遍相位表，
   *     避免「桥一套、路由一套」的两份判据。
   *
   * ⚠️ 未接入 ≠ 相位/档位拒绝：`interject / pause / stop /
   * remove_pending_item / clear_pending_queue` 在档位表内是允许的，但宿主尚无按 sid 的落点，
   * 这里统一回 `forbidden`（固定错误码集合里没有「未实现」格，不新增码）。
   * `confirm_answer` 已接入（M3）：走 `routeConfirmAnswer` → `answerFor`。
   */
  private handleCommand(
    conn: ClientConnection,
    frame: Extract<BridgeClientFrame, { t: 'cmd' }>,
  ): void {
    const { sid, rid, kind } = frame;
    const security = this.options.security;
    if (security) {
      // 档位判定放在桥里是因为「这台设备能不能发这个命令」是桥的授权面（§5.6 L3），
      // 但档位本身由宿主设备表给出（`tierOf`），桥只查表，不维护第二份权限表
      const tier = conn.deviceFp ? security.tierOf(conn.deviceFp) : undefined;
      if (!tier) {
        this.send(conn, { t: 'err', ch: 'cmd', rid, sid, code: REMOTE_COMMAND_CODES.FORBIDDEN });
        return;
      }
      const gate = evaluateTierGate(tier, kind);
      if (!gate.allow) {
        this.send(conn, { t: 'err', ch: 'cmd', rid, sid, code: gate.code });
        return;
      }
    } else if (kind !== 'answer') {
      // 回环档可能被任意本地进程连上：写命令一律拒绝（缺省拒绝写在分支里，不靠档位缺省值）
      this.send(conn, { t: 'err', ch: 'cmd', rid, sid, code: REMOTE_COMMAND_CODES.FORBIDDEN });
      return;
    }
    const parsed = parseCommand(kind, frame.p);
    if (parsed === 'malformed') {
      // 载荷写坏了 → 协议错误（不是相位问题，也不是权限问题）
      conn.ws.close(1008, 'cmd payload malformed');
      return;
    }
    if (!parsed) {
      // 本切片未接入的命令：如实拒绝，不伪造执行
      this.send(conn, { t: 'err', ch: 'cmd', rid, sid, code: REMOTE_COMMAND_CODES.FORBIDDEN });
      return;
    }
    // 两条投递面在此分流，判据仍各归其源（相位表只读一份、裁决只走 answerFor）
    const decision =
      parsed.kind === 'confirm_answer'
        ? routeConfirmAnswer(parsed, sid, {
            hasSession: (id) => this.ports.hasSession(id),
            phaseOf: (id) => this.ports.phaseOf(id),
            answerConfirm: (id, requestId, approved) =>
              this.ports.answerConfirm(id, requestId, approved),
          })
        : routeRemoteCommand(parsed, sid, {
            hasSession: (id) => this.ports.hasSession(id),
            // 相位素材来自宿主投影（`remotePhaseOf` 是唯一折算点，桥不再从 TurnState 推第二遍）
            phaseOf: (id) => this.ports.phaseOf(id),
            deliverInput: (id, input) => this.ports.deliverInput(id, input),
          });
    if (!decision.ok) {
      this.send(conn, { t: 'err', ch: 'cmd', rid, sid, code: decision.code });
      return;
    }
    // 受理后立刻回推该会话变化：开发客户端无需再发一次 sub 就能看到相位变化
    if (conn.subs.has(sid)) this.pushUpdate(conn, sid);
  }

  /** 回推一次快照（两档共用的归零重建形态；构造唯一入口 = `buildSnapshotFrame`） */
  private pushSnapshot(conn: ClientConnection, sid: string): void {
    this.send(conn, buildSnapshotFrame(sid, this.ports.snapshot(sid)));
  }

  /** 设备身份：profile 3 用 TLS 指纹，回环档用握手声明的 deviceId（缺省即 fail-closed） */
  private deviceOf(conn: ClientConnection): string {
    const device = conn.deviceFp ?? conn.deviceId;
    if (!device) throw new Error('remote stream device missing');
    return device;
  }

  /** 水位键：(device, sid) 复合，等价 §6.8 的嵌套 map；禁把 tab 当水位维度 */
  private streamKey(device: string, sid: string): string {
    return `${device}\u0000${sid}`;
  }

  /** 订阅 / 重订阅：快照 seq 归零，回放窗同步重建（§6.7） */
  private resetStream(device: string, sid: string): DeviceStreamState {
    // 富游标以「订阅那刻的快照」为基准初始化：手机刚收到整帧 snapshot，之后的富增量
    // 只能从这之后的长出来算起，否则订阅即重发历史正文/事件（「重」的伤）。
    const state: DeviceStreamState = {
      sentSeq: 0,
      window: [],
      windowBytes: 0,
      rich: initRichCursor(this.ports.snapshot(sid)),
    };
    this.streams.set(this.streamKey(device, sid), state);
    return state;
  }

  /** 按档申诉更新形态：回环档仍整帧快照，LAN 档走带水位的 status 增量 */
  private pushUpdate(conn: ClientConnection, sid: string): void {
    if (this.options.security) this.pushDelta(conn, sid);
    else this.pushSnapshot(conn, sid);
  }

  /**
   * LAN 档增量推送（status 相位帧 + 富增量帧；§6.4.1 / §6.7）
   *
   * 无水位状态时**不凭空发 seq=1**：先补一次快照让手机与 PC 对齐，下一帧才从 1 起。
   * 这是防「手机没收到快照却拿到增量」的 fail-closed，不是静默降级。
   *
   * 一帧 status 后接 0~N 帧富增量（append_text / process_event），各自占一个水位 seq 并入
   * 回放窗。富增量取数走差分纯函数（remoteDeltaDiff），帧构造回协议层唯一构造点；桥只
   * 分配水位与推进游标，不碰正文前缀/事件序号的判据。
   */
  private pushDelta(conn: ClientConnection, sid: string): void {
    const device = this.deviceOf(conn);
    let state = this.streams.get(this.streamKey(device, sid));
    if (!state) {
      state = this.resetStream(device, sid);
      this.pushSnapshot(conn, sid);
      return;
    }
    const snapshot = this.ports.snapshot(sid);
    const seq = state.sentSeq + 1;
    const frame = buildStatusDeltaFrame(sid, seq, snapshot.state);
    this.recordDelta(state, frame);
    this.send(conn, frame);
    // 相位帧之后的富增量与 tick 共用同一条差分通道，避免「通知时一套、定时器时另一套」两份判据
    this.pushRich(conn, sid, snapshot, state);
  }

  /**
   * 只推富增量（append_text / process_event），**不含 status**
   *
   * 抽成独立方法是为了让两条驱动共用一个执行面：
   *   - 生命周期通知（`pushDelta`）：先 status 再富增量；
   *   - 流中定时器（`onStreamTick`）：**只**富增量——相位没变就不该再发 status，
   *     而相位变化必然伴随生命周期通知，故 tick 发 status 属重复。
   * 水位 seq 与游标推进全在此处单点分配，调用方不碰。
   */
  private pushRich(
    conn: ClientConnection,
    sid: string,
    snapshot: SnapshotPayload,
    state: DeviceStreamState,
  ): void {
    const { specs, next } = diffRichDelta(snapshot, state.rich);
    state.rich = next;
    for (const spec of specs) {
      const richSeq = state.sentSeq + 1;
      const richFrame =
        spec.kind === 'append_text'
          ? buildAppendTextDeltaFrame(sid, richSeq, spec.roundId, spec.text)
          : buildProcessEventDeltaFrame(sid, richSeq, spec.roundId, spec.event);
      this.recordDelta(state, richFrame);
      this.send(conn, richFrame);
    }
  }

  // ─── 流中 250ms 富增量 tick ────────────────────────────────────────────

  /**
   * 武装某连接的流中 tick（幂等：已武装则不动）
   *
   * 只在 LAN 档 + 会话 running 时由 `notifyTurnUpdate` 调用。`unref()` 让定时器
   * 不阻止进程退出（测试 / 停桥时不拖尾巴）。
   */
  private armStreamTick(conn: ClientConnection, sid: string): void {
    conn.timers ??= new Map();
    if (conn.timers.has(sid)) return;
    const timer = setInterval(() => this.onStreamTick(conn, sid), STREAM_TICK_MS);
    timer.unref?.();
    conn.timers.set(sid, timer);
  }

  /** 停某连接某 sid 的 tick（未武装时无操作） */
  private disarmStreamTick(conn: ClientConnection, sid: string): void {
    const timers = conn.timers;
    const timer = timers?.get(sid);
    if (!timers || !timer) return;
    clearInterval(timer);
    timers.delete(sid);
  }

  /** 停某连接全部 tick（连接关闭 / 停桥 / 设备撤销时调用） */
  private clearAllStreamTicks(conn: ClientConnection): void {
    const timers = conn.timers;
    if (!timers) return;
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
  }

  /**
   * 一拍流中 tick：只补推富增量，任何一条不满足就自动停表
   *
   * 停表条件（任一命中）：桥已停 / 连接已退订该 sid / 回环档 / 无水状态 / 会话已离开 running。
   * 离开 running（waiting / settled）时收场内容已由当拍生命周期通知的 `pushDelta` 带走，
   * 故这里无需再推。定时器回调里的异常必须自吞并停表——否则会以未捕获异常冒到宿主进程。
   */
  private onStreamTick(conn: ClientConnection, sid: string): void {
    if (!this.server || !this.options.security || !conn.subs.has(sid)) {
      this.disarmStreamTick(conn, sid);
      return;
    }
    try {
      const device = conn.deviceFp ?? conn.deviceId;
      if (!device) {
        this.disarmStreamTick(conn, sid);
        return;
      }
      const state = this.streams.get(this.streamKey(device, sid));
      if (!state) {
        this.disarmStreamTick(conn, sid);
        return;
      }
      const snapshot = this.ports.snapshot(sid);
      if (snapshot.state.phase !== 'running') {
        this.disarmStreamTick(conn, sid);
        return;
      }
      this.pushRich(conn, sid, snapshot, state);
    } catch (err) {
      // 定时器里抛错 = 未捕获异常（能拖崩扩展宿主）；自吞 + 停表，留给下一次生命周期通知重建
      this.options.log?.(`[REMOTE-BRIDGE] stream tick failed (${sid}): ${String(err)}`);
      this.disarmStreamTick(conn, sid);
    }
  }

  /** 入窗并按「500 条或 2MB 先到为准」淘汰（§6.7；UTF-8 字节实测，不用字符数冒充） */
  private recordDelta(state: DeviceStreamState, frame: EvtFrame): void {
    const bytes = Buffer.byteLength(serializeBridgeFrame(frame), 'utf8');
    state.window.push({ seq: frame.seq, frame, bytes });
    state.sentSeq = frame.seq;
    state.windowBytes += bytes;
    while (state.window.length > MAX_DELTA_FRAMES || state.windowBytes > MAX_DELTA_WINDOW_BYTES) {
      const dropped = state.window.shift();
      if (!dropped) break;
      state.windowBytes -= dropped.bytes;
    }
  }

  /**
   * 重连水位恢复（§6.7 订正口径）
   *
   * `recvSeq` 是手机声明但**不被信任**的提示：PC 用窗口验证 `(recvSeq, sentSeq]` 每帧都在，
   * 才回 `resume_ok{fromSeq:recvSeq+1, headSeq:sentSeq}` 并顺序回放；否则重置。
   * 方案原文 `fromSeq=sentSeq+1` 会跳过已发未收帧，已同批订正。
   */
  private handleResume(
    conn: ClientConnection,
    frame: Extract<BridgeClientFrame, { t: 'resume' }>,
  ): void {
    if (!this.options.security) {
      for (const sid of conn.subs) this.sendResetRequired(conn, sid);
      return;
    }
    const sids = frame.sid ? [frame.sid] : [...conn.subs];
    for (const sid of sids) {
      if (!conn.subs.has(sid)) {
        this.sendResetRequired(conn, sid);
        continue;
      }
      const state = this.streams.get(this.streamKey(this.deviceOf(conn), sid));
      // 四类不可补：谱系丢失（上层短路）/ 水位超前 / 差超 500 / 窗口已淘汰（后三类见下）
      if (!state || !this.ports.hasSession(sid)) {
        this.sendResetRequired(conn, sid);
        continue;
      }
      const reason = this.resumeFailureReason(state, frame.recvSeq);
      if (reason) {
        this.options.log?.(`[REMOTE-BRIDGE] reset_required ${sid}: ${reason}`);
        this.sendResetRequired(conn, sid);
        continue;
      }
      const fromSeq = frame.recvSeq + 1;
      const headSeq = state.sentSeq;
      this.send(conn, buildResumeOkFrame(sid, fromSeq, headSeq));
      for (let seq = fromSeq; seq <= headSeq; seq += 1) {
        const entry = state.window.find((item) => item.seq === seq);
        if (entry) this.send(conn, entry.frame);
      }
    }
  }

  /** 水位失败分类（日志用；判据只有「回不回 reset_required」，不新增错误码） */
  private resumeFailureReason(
    state: DeviceStreamState,
    recvSeq: number,
  ): 'recv-ahead' | 'gap-too-large' | 'window-evicted' | undefined {
    if (recvSeq > state.sentSeq) return 'recv-ahead';
    if (state.sentSeq - recvSeq > MAX_DELTA_FRAMES) return 'gap-too-large';
    if (!this.replayWindowComplete(state, recvSeq)) return 'window-evicted';
    return undefined;
  }

  /** 待补区间每帧都在窗内才算可回放（空区间 = 已对齐，也算成功） */
  private replayWindowComplete(state: DeviceStreamState, recvSeq: number): boolean {
    for (let seq = recvSeq + 1; seq <= state.sentSeq; seq += 1) {
      if (!state.window.some((item) => item.seq === seq)) return false;
    }
    return state.windowBytes <= MAX_DELTA_WINDOW_BYTES;
  }

  private sendResetRequired(conn: ClientConnection, sid: string): void {
    this.send(conn, buildResetRequiredFrame(sid));
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

/**
 * 从命令载荷里取 send 正文
 *
 * 空串 / 纯空白按「写坏」处理：发一条空消息没有意义，还会白占一次 turn
 * （真正的空态拦截在 webview，这里只是不替它兜底造行为）。
 */
function readText(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const text = (payload as { text?: unknown }).text;
  if (typeof text !== 'string') return undefined;
  return text.trim().length > 0 ? text : undefined;
}

/**
 * 载荷解析结果：已解析命令 / 未接入（`undefined`）/ 写坏（`'malformed'`）
 *
 * 三种结果对应三条不同的处置：正常路由 / 回固定码 `forbidden` / 断开连接，
 * 所以不用 `undefined` 同时表达两种失败——那会把「协议错误」与「未实现」混成一句话。
 */
type ParsedCommand = RemoteInputCommand | ConfirmAnswerCommand | 'malformed' | undefined;

/** 从载荷取审批回执的 `{ requestId, approved }`（§6.6；两者缺一 / 类型错即写坏） */
function readConfirmAnswer(payload: unknown): { requestId: string; approved: boolean } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const fields = payload as { requestId?: unknown; approved?: unknown };
  if (typeof fields.requestId !== 'string' || fields.requestId.length === 0) return undefined;
  if (typeof fields.approved !== 'boolean') return undefined;
  return { requestId: fields.requestId, approved: fields.approved };
}

/**
 * 把上行命令解析成本切片执行面的命令（§6.6 的载荷形状）
 *
 * @param kind    命令名（已过档位门）
 * @param payload 原始载荷（`frame.p`，未信任）
 */
function parseCommand(kind: RemoteCommand, payload: unknown): ParsedCommand {
  switch (kind) {
    case 'send': {
      const text = readText(payload);
      return text === undefined ? 'malformed' : { kind: 'send', text };
    }
    case 'answer': {
      const answers = readAnswers(payload);
      return answers === undefined ? 'malformed' : { kind: 'answer', answers };
    }
    case 'resume':
      // 业务命令 resume（解暂停）≠ ctl 帧 `t:'resume'`（重连水位），此处无载荷
      return { kind: 'resume' };
    case 'confirm_answer': {
      const answer = readConfirmAnswer(payload);
      return answer === undefined
        ? 'malformed'
        : { kind: 'confirm_answer', requestId: answer.requestId, approved: answer.approved };
    }
    default:
      // 其余五条本切片没有按 sid 的宿主落点（interject 还需新的回执载荷），故未接入
      return undefined;
  }
}
