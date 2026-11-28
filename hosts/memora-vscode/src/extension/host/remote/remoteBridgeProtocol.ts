/**
 * 远程桥协议（L2 封套）—— 23 条 `t` 的唯一类型与解析点（纯函数，零 IO / 零 vscode）
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §6.5：封套类型 23 条 = 控制帧 6 + 通道/生命周期 6 + 业务载荷 11
 *     （`session_create` / `session_created` 为手机直接新建会话，2026-11-28 拍板补登；
 *     `role_list` / `role_list_ok` 为手机新建会话前选角色包，同日补登）
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
import type { ProcessEvent } from '@zooique/memora';

/**
 * 封套类型全集（23 条 · 唯一枚举来源）
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
  // 业务载荷（11）
  'evt',
  'cmd',
  'attention',
  'blob_get',
  'blob_data',
  'session_list',
  'session_list_ok',
  // 手机直接新建会话：跨会话帧（**不带 sid**）——新建的那一刻 sid 还不存在，
  // 所以不能复用 `cmd`（`cmd` 的定址前提就是 sid）。与 `session_list` 同属「跨会话例外」。
  'session_create',
  'session_created',
  // 角色包列表：与 `session_list` 同族（跨会话、只读），手机「＋」先取列表再建会话。
  // 不塞进 `hello_ok`：角色包可随时安装/移除，一次性的握手快照会说谎。
  'role_list',
  'role_list_ok',
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
  /**
   * 该会话当前待裁决的审批数（可选；0 时省略）
   *
   * 为什么放进列表：手机主页要在**不订阅每个会话**的前提下显示「待审批」角标。
   * 真源 = 宿主的 `ConfirmCoordinator.pendingSnapshot().count`，列表只转述，不缓存。
   */
  pendingConfirmCount?: number;
  /**
   * 该会话记录的角色包名（可选；从未选过 / 旧档案缺省）
   *
   * 真源 = `SessionMeta.activeRolePackName`（与 webview 的 `session_list_data` 同一读口），
   * 桥只透传。手机据此在会话详情顶部显示「当前角色」——**不用 `processEvents.meta` 反推**：
   * 快照裁剪只留尾部 N 条，长轮重开时 meta 已被裁掉。
   */
  activeRolePackName?: string;
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

/**
 * 手机直接新建会话（跨会话帧，**不带 `sid`**）
 *
 * 为什么不复用 `cmd.kind` 九条：`cmd` 的定址前提就是 `sid`，而新建会话正是「sid 尚不存在」
 * 的那件事——放进 `cmd` 会让定址判据与业务语义互相矛盾。这跟 `session_list` 同族
 * （跨会话例外），故用 ctl 帧。
 *
 * 权限口径：与 `send` 同档（`observe` 只读档不给写入口）；新建出的会话出生来源是
 * `user`（用户自助开的），不是 `hosted`——手机不能冒充宝。
 */
export interface SessionCreateFrame {
  t: 'session_create';
  ch?: 'ctl';
  rid: string;
  title?: string;
  /**
   * 新建会话要用的角色包名（可选；缺省 = 宿主取用户级默认 → 内核兜底包）
   *
   * 手机传的是**用户选择**，不是已校验的事实——宿主必须过角色包目录编目再采用
   * （PC 草稿路径「选择时已校验」的前提在远端不成立）。校验失败按「未指定」处理，
   * 不拦住建会话。
   */
  role?: string;
}

/**
 * 角色包列表请求（跨会话帧，**不带 `sid`**）
 *
 * 与 `session_list` 同族：手机「＋」在**建会话之前**就要知道有哪些角色包可选，
 * 此刻没有任何 `sid` 可定址。`rid` 可选（与 `session_list` 同口径：只为对账，不参与定址）。
 */
export interface RoleListFrame {
  t: 'role_list';
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
  | SessionListFrame
  | SessionCreateFrame
  | RoleListFrame;

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

/**
 * §6.8 唯一能力名：PC 声明下发 `process_event` 明细（**非档位、非命令、非帧版本**）
 *
 * `hello` 无上行 caps 字段 ⇒ 这是 PC 单向声明，不是设备协商；取值域只列**手机真实消费**的两项，
 * 不为「未来可能的能力」预留无消费点的名字（免造判据）。
 */
export const REMOTE_CAP_PROCESS_EVENTS = 'process_events' as const;

/**
 * §6.8 能力名：PC 支持 ctl 帧 `role_list`（手机「＋」建会话前选角色包）
 *
 * **为什么必须声明而不是直接发**：旧宿主把未知 `t` 当畸形帧、直接关连接（`onMessage` 的 1008），
 * 新手机对旧 PC 一发 `role_list` 就会断线。手机据此判：没有该能力就跳过选择器、
 * 按「不指定角色」建会话（`session_create.role` 是可选字段，旧宿主忽略不影响建会话）。
 */
export const REMOTE_CAP_ROLE_LIST = 'role_list' as const;

/** §6.8 默认能力集：与 hello_ok 声明同源 */
export const DEFAULT_REMOTE_CAPS: readonly string[] = [
  REMOTE_CAP_PROCESS_EVENTS,
  REMOTE_CAP_ROLE_LIST,
];

/**
 * 该桥是否声明下发过程事件明细（缺省 = 默认下发）
 *
 * 唯一判据：`hello_ok.caps` 的同一份取值。门控落点只在两个生产源头
 * （快照裁剪 / 富增量 spec），回放窗只缓存已发帧，禁止在回放时再过滤。
 */
export function hasProcessEventsCap(caps: readonly string[] | undefined): boolean {
  return (caps ?? DEFAULT_REMOTE_CAPS).includes(REMOTE_CAP_PROCESS_EVENTS);
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

/**
 * 水位可补（§6.7 第 1 分支 · profile 3）
 *
 * `fromSeq = recvSeq + 1`、`headSeq = PC 已发最后一帧`；回放区间 `[fromSeq, headSeq]`。
 * 方案原文曾写 `fromSeq = sentSeq + 1`（会跳过已发未收帧），已按 SSOT 排雷订正。
 * 带 `sid` 是因为 `resume` 可不带 sid（一次恢复全部订阅会话），必须逐会话回执。
 */
export interface ResumeOkFrame {
  t: 'resume_ok';
  ch: 'ctl';
  sid: string;
  fromSeq: number;
  headSeq: number;
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
 * 新建会话回执（`session_create` 的唯一下行）
 *
 * `sid` 由宿主在创建那一刻生成并立即下发——**不得**由手机生成或从会话列表差分反推：
 * 身份必须由创建方（上游）生产，派生型身份会让「创建」与「首个事件」之间出现无身份窗口。
 * `rid` 与上行同值，手机据此配对（错误帧 `err` 也带同一 `rid`）。
 */
export interface SessionCreatedFrame {
  t: 'session_created';
  ch: 'ctl';
  rid: string;
  sid: string;
  title: string;
  /**
   * 宿主实际落进 `SessionMeta.activeRolePackName` 的角色包名（可选；未指定 / 校验失效 = 缺省）
   *
   * 为什么回带：手机选了角色后要立刻显示「当前角色」，若手机拿自己选的名字回填，
   * 一旦宿主因目录校验回落成默认包，界面就是在造假事实。这里给宿主读过的事实。
   */
  role?: string;
}

/** 角色包列表条目的最小读面（与 PC 输入区下拉 `chat_role_packs.packs` 同一投影） */
export interface BridgeRolePackMeta {
  /** 角色包名（写进 `SessionMeta.activeRolePackName` 的值；**不是**展示名） */
  name: string;
  /** 展示名（缺省时宿主已回落为 name） */
  displayName: string;
  description?: string;
}

/**
 * 角色包列表应答（`role_list` 的唯一下行）
 *
 * `defaultName` = 用户级默认角色包（`memora.defaultRolePack`）；缺省 = 没设过，
 * 手机按「不指定角色」建会话即可（宿主再走内核兜底包）。手机只用来预选，不据此写 meta。
 */
export interface RoleListOkFrame {
  t: 'role_list_ok';
  ch: 'ctl';
  rid?: string;
  packs: readonly BridgeRolePackMeta[];
  defaultName?: string;
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
  | {
      t: 'attention';
      ch: 'events';
      sid: string;
      kind: 'confirm';
      requestId: string;
      label?: string;
    }
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
  | ResumeOkFrame
  | EvtFrame
  | ErrFrame
  | SessionListOkFrame
  | SessionCreatedFrame
  | RoleListOkFrame
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
    case 'role_list':
      return { ok: true, frame: { t: 'role_list', rid: frame.rid as string | undefined } };
    case 'session_create': {
      // rid 必填：错误帧 / 回执都按它定址，缺了手机就不知道「这条结果对应哪次点击」
      if (!isNonEmptyString(frame.rid)) return { ok: false, reason: 'session_create.rid missing' };
      if (frame.title !== undefined && typeof frame.title !== 'string') {
        return { ok: false, reason: 'session_create.title must be string' };
      }
      if (frame.role !== undefined && typeof frame.role !== 'string') {
        return { ok: false, reason: 'session_create.role must be string' };
      }
      // 空串 / 纯空白标题按「未给标题」处理：宿主会回落到默认标题，不把空串当用户意图
      const rawTitle = typeof frame.title === 'string' ? frame.title.trim() : '';
      // 角色包名同样归一：空串 = 未指定（宿主走「默认 → 兜底包」链）。
      // 这里**只校验类型**、不校验存在性——目录编目在宿主侧，桥不得自造第二份判据
      const rawRole = typeof frame.role === 'string' ? frame.role.trim() : '';
      return {
        ok: true,
        frame: {
          t: 'session_create',
          rid: frame.rid,
          ...(rawTitle.length > 0 ? { title: rawTitle } : {}),
          ...(rawRole.length > 0 ? { role: rawRole } : {}),
        },
      };
    }
    default:
      // 其余都是下行帧（hello_ok / evt / err / pong …）：手机不应上行
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
 * @param options 能力门控；缺省 `includeProcessEvents: true`，故 golden fixture 形状不变
 */
export function buildSnapshotFrame(
  sid: string,
  snapshot: SnapshotPayload,
  options: { includeProcessEvents?: boolean } = {},
): EvtFrame {
  return {
    t: 'evt',
    ch: 'events',
    sid,
    seq: 0,
    kind: 'snapshot',
    p: {
      state: snapshot.state,
      // 出桥前统一裁剪（§6.4）：剥 attachmentUris（远端 origin 必 404）+
      // processEvents / assistantLog 只留最近 N 条。裁剪口径只在 remoteSnapshotTrim 一处；
      // 能力声明不含 process_events 时整键删明细（§6.8 门控源头之一）
      rounds: snapshot.rounds.map((round) =>
        trimRound(round, options.includeProcessEvents !== false),
      ),
      pendingQueue: snapshot.pendingQueue,
    },
  };
}

/**
 * 构造下行状态增量帧（`evt` + `kind:'delta'` + `p.kind:'status'`）
 *
 * **唯一构造点**：桥的增量推送与 golden fixture 生成器都调用它。本函数只承载
 * `status`（相位变化）；文本 / 过程事件有各自的唯一构造点，不借本构造点偷渡。
 * `seq` 从 1 起（快照恒 0），由每设备每会话的水位分配，构造点只校验不分配。
 */
export function buildStatusDeltaFrame(sid: string, seq: number, state: TurnState): EvtFrame {
  if (sid.length === 0) throw new Error('delta.sid must be non-empty');
  if (!isSeqNumber(seq) || seq < 1) throw new Error('delta.seq must be >= 1');
  return { t: 'evt', ch: 'events', sid, seq, kind: 'delta', p: { kind: 'status', state } };
}

function assertDeltaHead(sid: string, seq: number, roundId: string): void {
  if (sid.length === 0) throw new Error('delta.sid must be non-empty');
  if (!isSeqNumber(seq) || seq < 1) throw new Error('delta.seq must be >= 1');
  if (roundId.length === 0) throw new Error('delta.roundId must be non-empty');
}

/**
 * 构造流内正文增量帧（`evt` + `delta` + `p.kind:'append_text'`；§6.4.1）
 *
 * **唯一构造点**：桥的差分推送调用它。`roundId` 与 `RoundView.id` 同源（live 轮 `id` 即
 * `PendingLiveRound.roundId`，`toRoundView` 单点赋值）；`text` 是本次新增的**后缀**，不是
 * 整段正文——整段重发等于每 token 重传历史，正是 §6.4 要消除的伤。
 */
export function buildAppendTextDeltaFrame(
  sid: string,
  seq: number,
  roundId: string,
  text: string,
): EvtFrame {
  assertDeltaHead(sid, seq, roundId);
  if (text.length === 0) throw new Error('delta.append_text.text must be non-empty');
  return {
    t: 'evt',
    ch: 'events',
    sid,
    seq,
    kind: 'delta',
    p: { kind: 'append_text', roundId, text },
  };
}

/**
 * 构造本轮用户气泡增量帧（`evt` + `delta` + `p.kind:'user_message'`；§6.4.2）
 *
 * **唯一构造点**：桥的差分推送调用它。`userMessage` 逐字透传 `RoundView.userMessage`
 * （不重塑字段，防第二份 DTO）；`createdAt` 取 `userMessage.timestamp` 同源于
 * `toRoundView`，手机底栏时钟据此渲染，不用本机当前时间冒充提问时刻。
 */
export function buildUserMessageDeltaFrame(
  sid: string,
  seq: number,
  roundId: string,
  userMessage: RoundView['userMessage'],
  createdAt?: string,
): EvtFrame {
  assertDeltaHead(sid, seq, roundId);
  return {
    t: 'evt',
    ch: 'events',
    sid,
    seq,
    kind: 'delta',
    p: { kind: 'user_message', roundId, userMessage, ...(createdAt ? { createdAt } : {}) },
  };
}

/**
 * 构造过程事件增量帧（`evt` + `delta` + `p.kind:'process_event'`；§6.4.1）
 *
 * **唯一构造点**：桥的差分推送调用它。`event` 逐字透传内核 `ProcessEvent` 判别联合
 * （含其 `type` / `seq` / `ts` / `payload`），桥与协议层都不猜字段、不重造 DTO——
 * 手机端复用同一形状，字段漂移由契约冒烟全等断言拦。
 *
 * 注意：`ProcessEvent` 自带 `seq` 是**事件在轮内的序号**，与封套 `EvtFrame.seq`（水位）是
 * 两个不同维度，不可互相代替；幂等差分按事件 `seq` 过滤，水位 `seq` 只按发帧递增。
 */
export function buildProcessEventDeltaFrame(
  sid: string,
  seq: number,
  roundId: string,
  event: ProcessEvent,
): EvtFrame {
  assertDeltaHead(sid, seq, roundId);
  return {
    t: 'evt',
    ch: 'events',
    sid,
    seq,
    kind: 'delta',
    p: { kind: 'process_event', roundId, event },
  };
}

/**
 * 构造水位不可补回执（`reset_required`；§6.7 第 2 分支）
 *
 * **唯一构造点**：桥的 `sendResetRequired` 调用它，手机侧 DTO 以本函数为形状真源
 * （`sid` 必带，逐会话回执）。此前桥内联拼字面量，手机复刻即第二真源——
 * 加字段时两端各自漂移且无测试会红，故收口到此处。
 */
export function buildResetRequiredFrame(sid: string): ResetRequiredFrame {
  if (sid.length === 0) throw new Error('reset_required.sid must be non-empty');
  return { t: 'reset_required', ch: 'ctl', sid };
}

/**
 * 构造水位可补回执（`resume_ok`；§6.7 订正口径）
 *
 * **唯一构造点**：桥的 `resume` 分派调用它，后续 golden fixture 生成器复用同一形状。
 * `headSeq + 1 === fromSeq` 表示空回放（手机已对齐），合法；其余倒挂即拒绝。
 */
export function buildResumeOkFrame(sid: string, fromSeq: number, headSeq: number): ResumeOkFrame {
  if (sid.length === 0) throw new Error('resume_ok.sid must be non-empty');
  if (!isSeqNumber(fromSeq) || fromSeq < 1 || !isSeqNumber(headSeq) || headSeq + 1 < fromSeq) {
    throw new Error('resume_ok range invalid');
  }
  return { t: 'resume_ok', ch: 'ctl', sid, fromSeq, headSeq };
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
 * 构造新建会话回执（`session_created`）
 *
 * **唯一构造点**：桥的 `handleSessionCreate` 调用它。`sid` 必须由创建方（宿主）给出，
 * 构造点只校验非空——它不生产身份，只把身份送上网。
 *
 * @param rid 与上行 `session_create.rid` 同值（手机据此配对）
 * @param sid 宿主创建出的会话 id
 * @param title 会话标题（宿主实际写入的展示名，非手机传入值）
 */
export function buildSessionCreatedFrame(
  rid: string,
  sid: string,
  title: string,
  role?: string,
): SessionCreatedFrame {
  if (rid.length === 0) throw new Error('session_created.rid must be non-empty');
  if (sid.length === 0) throw new Error('session_created.sid must be non-empty');
  return { t: 'session_created', ch: 'ctl', rid, sid, title, ...(role ? { role } : {}) };
}

/**
 * 构造角色包列表应答（`role_list_ok`）
 *
 * **唯一构造点**：桥的 `handleRoleList` 调用它（不另写一份形状）。
 * 过滤 / 排序由宿主投影负责（与 PC 输入区下拉同一 `listMeta` 真源），本函数只搬字段。
 *
 * @param packs 宿主投影出的角色包最小面
 * @param defaultName 用户级默认角色包名（未设置 = 缺省）
 * @param rid 与上行 `role_list.rid` 同值（未带则不回填）
 */
export function buildRoleListOkFrame(
  packs: readonly BridgeRolePackMeta[],
  defaultName: string | undefined,
  rid?: string,
): RoleListOkFrame {
  return {
    t: 'role_list_ok',
    ch: 'ctl',
    ...(rid !== undefined ? { rid } : {}),
    packs,
    ...(defaultName ? { defaultName } : {}),
  };
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
