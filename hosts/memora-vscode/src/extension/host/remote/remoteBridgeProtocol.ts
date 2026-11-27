/**
 * 远程桥协议（L2 封套）—— 19 条 `t` 的唯一类型与解析点（纯函数，零 IO / 零 vscode）
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §6.5：封套类型 19 条 = 控制帧 6 + 通道/生命周期 6 + 业务载荷 7
 *   - §6.1：帧封套字段（`t` / `ch` / `sid` / `rid` / `seq` / `kind` / `p`）与固定错误码
 *   - §6.2：`hello` / `hello_ok` 的字段（`hello_ok.assistantSid?` 为字段扩展）
 *
 * 为什么要有本文件：桥要**先按 `t` 分派通道、再按 `kind` 分派业务**（§6.3 的层级约定），
 * 而 `cmd.kind` 的封闭集合已经是 `remoteCommandPolicy.REMOTE_COMMANDS`。若在桥里另抄一份
 * 「能收哪些命令」，第二份清单会与真值表各自漂移（含测试都拦不住）。故：
 *   - 封套类型清单只此一份（`BRIDGE_ENVELOPE_TYPES`）
 *   - 命令动词**直接复用** `REMOTE_COMMANDS`，不新抄
 *
 * 边界：本文件只回答「这条帧是否合法、属于哪条通道」，**不判相位、不判权限档**——
 * 那两件事分别归 `remoteCommandPolicy`（相位真值表）与桥的设备档位（profile 3）。
 */

import {
  REMOTE_COMMANDS,
  type RemoteCommand,
  type RemoteCommandCode,
  type RemoteCtlCode,
} from './remoteCommandPolicy.js';
import { trimRound } from './remoteSnapshotTrim.js';
import type { RoundView, TurnState } from '../../../shared/protocol.js';

/**
 * 封套类型全集（19 条 · 唯一枚举来源）
 *
 * 分组与方案 §6.5 表格逐条对应；`snapshot` / `delta` **不在**此表——它们是 `t:'evt'` 的 `kind`，
 * 属封套内的第二层分派（§6.3 层级约定）。
 */
export const BRIDGE_ENVELOPE_TYPES = [
  // 控制帧（6）
  'hello',
  'hello_ok',
  'resume',
  'resume_ok',
  'reset_required',
  'host_state',
  // 通道 / 生命周期（6）
  'ping',
  'pong',
  'ack',
  'err',
  'sub',
  'unsub',
  // 业务载荷（7）
  'evt',
  'cmd',
  'attention',
  'blob_get',
  'blob_data',
  'session_list',
  'session_list_ok',
] as const;

/** 封套类型名（由常量数组派生，禁止调用点自写字面量联合） */
export type BridgeEnvelopeType = (typeof BRIDGE_ENVELOPE_TYPES)[number];

/** 桥通道（`ch`；ctl 帧可省） */
export type BridgeChannel = 'ctl' | 'events' | 'cmd' | 'blob';

/** 业务下行事件的 `kind`（§6.4：先快照、后增量） */
export type BridgeEventKind = 'snapshot' | 'delta';

// `attention` 的 kind 取值（§6.5 四种）直接写在下方判别联合里，不另建导出类型：
// 宿主另有 `attentionNotice.AttentionKind`（confirm|ask|settled，本地提醒域），
// 两份同名类型取值不同，导出第二份会诱导调用点混用——判别联合字面量即唯一契约。

/** 会话摘要（§6.3「会话列表 = `session_list_data` 的子集」；桥只透传宿主投影，不另造 DTO） */
export interface BridgeSessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  messageCount?: number;
  origin?: 'user' | 'hosted';
  lastOutcome?: 'completed' | 'interrupted' | 'unsettled';
}

// ─── 上行帧（手机 → PC） ───────────────────────────────────────────────

/**
 * 握手帧（连接后第一帧）
 *
 * `mode` 三取值：省略 = Mode R（中继/直连回环），`tunnel` = Mode T，`direct` = Mode D；
 * 后两者必须带一次性口令 `pid`（§5.3）。回环档永远不带 `pid`。
 */
export interface HelloFrame {
  t: 'hello';
  ch?: 'ctl';
  v: 1;
  deviceId: string;
  nonce: string;
  phoneFp: string;
  mode?: 'relay' | 'tunnel' | 'direct';
  pid?: string;
}

/** 心跳（应用层保活） */
export interface PingFrame {
  t: 'ping';
  ch?: 'ctl';
}

/** 订阅 / 退订某会话的事件流（**仅上行**；下行用 `evt` 或 `err` 回应） */
export interface SubFrame {
  t: 'sub';
  ch?: 'ctl';
  sid: string;
}

export interface UnsubFrame {
  t: 'unsub';
  ch?: 'ctl';
  sid: string;
}

/** 手机确认 PC 的下行（背压 credit 回收，§6.2；profile 2 不启用 credit，仅解析不拒） */
export interface AckFrame {
  t: 'ack';
  ch: 'events' | 'cmd' | 'blob';
  seq: number;
}

/** 重连水位恢复（§6.7；profile 2 无增量水位，桥一律回 `reset_required`） */
export interface ResumeFrame {
  t: 'resume';
  ch?: 'ctl';
  upSeq: number;
  recvSeq: number;
  sid?: string;
}

/** 业务命令（`kind` 九条复用真值表，不新造动词） */
export interface CmdFrame {
  t: 'cmd';
  ch: 'cmd';
  rid: string;
  sid: string;
  kind: RemoteCommand;
  p?: unknown;
}

/** 会话列表请求（跨会话帧，**不带 `sid`**——§6.5 补登说明里的唯一例外） */
export interface SessionListFrame {
  t: 'session_list';
  ch?: 'ctl';
  rid?: string;
}

/** 桥可解析的上行帧联合 */
export type BridgeClientFrame =
  | HelloFrame
  | PingFrame
  | SubFrame
  | UnsubFrame
  | AckFrame
  | ResumeFrame
  | CmdFrame
  | SessionListFrame;

// ─── 下行帧（PC → 手机） ───────────────────────────────────────────────

/** 握手应答（`assistantSid` = 助手会话 id，由宿主按工作区指针下发；§19.6.1 第 8 条） */
export interface HelloOkFrame {
  t: 'hello_ok';
  ch: 'ctl';
  serverTime: number;
  pcId: string;
  caps: readonly string[];
  limits: { maxFrame: number; credit: number };
  assistantSid?: string;
}

/** 事件帧（profile 2 只发 `snapshot`，`seq` 恒 0；增量与水位随 profile 3） */
export interface EvtFrame {
  t: 'evt';
  ch: 'events';
  sid: string;
  seq: number;
  kind: BridgeEventKind;
  p: unknown;
}

/** 心跳应答 */
export interface PongFrame {
  t: 'pong';
  ch?: 'ctl';
}

/** 水位不可补 → 手机重拉快照（§6.7 第 2 分支；profile 2 对任何 `resume` 都走这条） */
export interface ResetRequiredFrame {
  t: 'reset_required';
  ch: 'ctl';
  sid: string;
}

/** 错误帧（`code` 只从固定集合取：命令面 `REMOTE_COMMAND_CODES` + 控制面 `REMOTE_CTL_CODES`，禁自造字符串） */
export interface ErrFrame {
  t: 'err';
  ch: 'ctl' | 'events' | 'cmd' | 'blob';
  rid?: string;
  sid?: string;
  code: RemoteCommandCode | RemoteCtlCode;
  msg?: string;
}

/** 会话列表应答（载荷逐字沿用 §6.3 的 `session_list_data` 子集口径） */
export interface SessionListOkFrame {
  t: 'session_list_ok';
  ch: 'ctl';
  sessions: readonly BridgeSessionSummary[];
  archivedIds: readonly string[];
  assistantSid?: string;
}

/**
 * 提醒帧（§6.5 `attention`）—— 事件通知，手机据此知道"有审批要处理"
 *
 * `requestId` 只在 `kind:'confirm'` 时必带（手机回执 `confirm_answer` 的定址凭据）；
 * 其余 kind 省略。用**判别联合**表达"confirm 必带、其余不带"，而非一个可选字段——
 * 可选字段会让编译器放过 `buildAttentionFrame('s','confirm',{})` 这种缺凭据的构造，
 * 正是上轮"只加可选 requestId"会造出的僵尸字段伤。
 */
export type AttentionFrame =
  | { t: 'attention'; ch: 'events'; sid: string; kind: 'confirm'; requestId: string; label?: string }
  | {
      t: 'attention';
      ch: 'events';
      sid: string;
      kind: 'ask' | 'settled' | 'error';
      requestId?: never;
      label?: string;
    };

/** 桥会主动下发的帧联合（其余封套由 profile 3 补，profile 2 不构造） */
export type BridgeServerFrame =
  | HelloOkFrame
  | PongFrame
  | ResetRequiredFrame
  | EvtFrame
  | ErrFrame
  | SessionListOkFrame
  | AttentionFrame;

/** 解析成功 */
export interface ParseOk {
  ok: true;
  frame: BridgeClientFrame;
}
/** 解析失败（`reason` 供日志与开发客户端排障；**不**回给手机——错误码是封闭集合） */
export interface ParseFail {
  ok: false;
  reason: string;
}
/** 解析结果 */
export type ParseResult = ParseOk | ParseFail;

/** 非空字符串判据（帧字段一律要求非空，空串等价于缺字段） */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 有限非负整数判据（`seq` / `upSeq` / `recvSeq`） */
function isSeqNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** `cmd.kind` 是否在真值表的封闭集合内（复用 REMOTE_COMMANDS，不新抄九条） */
function isRemoteCommand(value: unknown): value is RemoteCommand {
  return typeof value === 'string' && (REMOTE_COMMANDS as readonly string[]).includes(value);
}

/**
 * 解析一条上行帧
 *
 * @param raw WebSocket 文本帧原文（JSON）
 * @returns 合法帧，或带原因的拒绝（拒绝理由只进日志，不回给手机）
 */
export function parseBridgeFrame(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not an object' };
  }
  const frame = parsed as Record<string, unknown>;
  const t = frame.t;
  if (typeof t !== 'string' || !(BRIDGE_ENVELOPE_TYPES as readonly string[]).includes(t)) {
    return { ok: false, reason: `unknown t: ${String(t)}` };
  }
  switch (t) {
    case 'hello': {
      // Mode T / Mode D 必须带一次性口令；回环档不带（带了也不拒，由 profile 3 的握手判）
      if (frame.v !== 1) return { ok: false, reason: 'hello.v must be 1' };
      if (!isNonEmptyString(frame.deviceId)) return { ok: false, reason: 'hello.deviceId missing' };
      if (!isNonEmptyString(frame.nonce)) return { ok: false, reason: 'hello.nonce missing' };
      if (!isNonEmptyString(frame.phoneFp)) return { ok: false, reason: 'hello.phoneFp missing' };
      return { ok: true, frame: frame as unknown as HelloFrame };
    }
    case 'ping':
      return { ok: true, frame: { t: 'ping' } };
    case 'sub':
    case 'unsub': {
      if (!isNonEmptyString(frame.sid)) return { ok: false, reason: `${t}.sid missing` };
      return { ok: true, frame: { t, sid: frame.sid } as SubFrame | UnsubFrame };
    }
    case 'ack': {
      if (!isNonEmptyString(frame.ch)) return { ok: false, reason: 'ack.ch missing' };
      if (!isSeqNumber(frame.seq)) return { ok: false, reason: 'ack.seq invalid' };
      return { ok: true, frame: frame as unknown as AckFrame };
    }
    case 'resume': {
      if (!isSeqNumber(frame.upSeq)) return { ok: false, reason: 'resume.upSeq invalid' };
      if (!isSeqNumber(frame.recvSeq)) return { ok: false, reason: 'resume.recvSeq invalid' };
      return { ok: true, frame: frame as unknown as ResumeFrame };
    }
    case 'cmd': {
      if (frame.ch !== 'cmd') return { ok: false, reason: 'cmd.ch must be cmd' };
      if (!isNonEmptyString(frame.rid)) return { ok: false, reason: 'cmd.rid missing' };
      if (!isNonEmptyString(frame.sid)) return { ok: false, reason: 'cmd.sid missing' };
      if (!isRemoteCommand(frame.kind)) return { ok: false, reason: 'cmd.kind unknown' };
      return { ok: true, frame: frame as unknown as CmdFrame };
    }
    case 'session_list':
      return { ok: true, frame: { t: 'session_list', rid: frame.rid as string | undefined } };
    default:
      // 其余 11 条都是下行帧（hello_ok / evt / err / pong …）：手机不应上行
      return { ok: false, reason: `downlink-only type from client: ${t}` };
  }
}

/**
 * 快照载荷（宿主只读投影的最小入参）
 *
 * 与 `RemoteBridgePorts.snapshot` 的返回结构同源；桥与 golden fixture 生成器
 * 共用这一份形状，避免「桥一套、生成器一套」的第二真源。
 */
export interface SnapshotPayload {
  /** turn 相位原始对象（`state.phase`） */
  state: TurnState;
  /** 未裁剪的宿主投影（裁剪在 [buildSnapshotFrame] 内统一做） */
  rounds: readonly RoundView[];
  /** 待处理队列（宿主端口类型是 `readonly string[]`） */
  pendingQueue: readonly string[];
}

/**
 * 构造下行快照帧（`evt` + `kind:'snapshot'`）
 *
 * **唯一构造点**：桥的 `pushSnapshot` 与 golden fixture 生成器都调用它。
 * 若在桥里内联构造、生成器另写一份，两份形状会从落笔那刻开始漂移且无测试会红。
 *
 * @param sid 会话定址
 * @param snapshot 宿主只读投影（内部经 `trimRound` 统一裁剪）
 */
export function buildSnapshotFrame(sid: string, snapshot: SnapshotPayload): EvtFrame {
  return {
    t: 'evt',
    ch: 'events',
    sid,
    seq: 0,
    kind: 'snapshot',
    p: {
      state: snapshot.state,
      // 出桥前统一裁剪（§6.4）：剥 attachmentUris（远端 origin 必 404）+
      // processEvents / assistantLog 只留最近 N 条。裁剪口径只在 remoteSnapshotTrim 一处
      rounds: snapshot.rounds.map(trimRound),
      pendingQueue: snapshot.pendingQueue,
    },
  };
}

/**
 * 构造下行审批提醒帧（`attention` + `kind:'confirm'`）
 *
 * **唯一构造点**：桥的 `notifyAttention` 与 golden fixture 生成器都调用它（后者随 profile 3
 * 补）。`requestId` 必填且非空——它是手机回执的定址凭据，缺了就是"提醒了却批不了"的假闭环。
 *
 * 为什么只构造 `confirm`：`ask` / `settled` / `error` 三种是 §6.5 的完整 kind 集合，
 * 但 M3 里程碑只落执行类审批提醒；未落地的 kind 不造构造点（僵尸容器拒入库）。
 *
 * @param sid       会话定址
 * @param requestId 待裁决请求的 id（与 `ConfirmCoordinator` 的 `current.requestId` 同源）
 * @param label     `工具：文件名` 简写（与决策记录同一取法；禁传 diff 全文）
 */
export function buildConfirmAttentionFrame(
  sid: string,
  requestId: string,
  label?: string,
): AttentionFrame {
  if (sid.length === 0) throw new Error('attention.sid must be non-empty');
  if (requestId.length === 0) throw new Error('attention.requestId must be non-empty');
  return { t: 'attention', ch: 'events', sid, kind: 'confirm', requestId, label };
}

/**
 * 序列化一条下行帧
 *
 * @param frame 下行帧
 * @returns 可直接 `ws.send()` 的 JSON 文本
 */
export function serializeBridgeFrame(frame: BridgeServerFrame): string {
  return JSON.stringify(frame);
}
