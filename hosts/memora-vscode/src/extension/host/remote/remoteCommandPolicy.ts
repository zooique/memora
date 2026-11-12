/**
 * 远程控制命令策略（R0-a）—— 相位 × 命令 的准入真值表（纯函数，无 IO / 无 vscode 依赖）
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §6.1 / §6.5：错误码固定集合（`err.code` 的 `cmd` 侧五码，本文件是它们的唯一常量来源）
 *   - §6.6：上行命令**不新造动词**，直接复用既有 `cmd.kind` 九条
 *
 * 为什么要有本文件：桥（L3）需要在**不碰 webview 焦点**的前提下判断「这条命令在这个会话的
 * 这个相位能不能执行」。若判定散落在各命令分支里，同一相位会出现两套措辞、两套取舍
 * （手机侧文案与错误码各自漂移）。故把判据收成一张**写死的表**，调用点只查表。
 *
 * 边界（刻意）：
 *   - 本文件**只**做「相位 → 准入」这一件事；`no_session` / `in_flight` 依赖相位之外的
 *     事实（会话是否存在、发送窗口是否被占），**不由本文件产出**，但常量在此登记，
 *     避免调用点自造字符串。
 *   - 不读 `TurnState` 以外的状态，不推导相位——相位素材由宿主投影给出，
 *     `remotePhaseOf` 只是把既有 `TurnState` 折算成相位名的适配器。
 */

import type { TurnState } from '../../../shared/protocol.js';

/**
 * 远程命令错误码（固定集合 · 唯一常量来源）
 *
 * 取值与语义逐字对齐方案文档 §6.1 的错误码表（`err.code`，`ch: 'cmd'`）：
 *   - `no_session`：会话不存在或未装配 Agent —— **相位之外的事实**
 *   - `stale_phase`：相位已变，本次输入失效（如 answer 到达时已不在等待问答）
 *   - `already_resumed`：重复解暂停 / 会话本就不在暂停 —— 手机侧当成功处理（幂等）
 *   - `busy`：会话正在跑，不接受新 turn（**相位层面**拒绝）
 *   - `in_flight`：同一会话发送窗口被占（**仲裁层面**拒绝，含 PC 占用）
 *
 * ⚠️ 另外两个码不属于命令面，故**不在此登记**：`bad_passcode`（ctl 握手）、
 * `reset_required` 属传输/控制面，见方案 §5.3 与 §6.2。
 */
export const REMOTE_COMMAND_CODES = {
  NO_SESSION: 'no_session',
  STALE_PHASE: 'stale_phase',
  ALREADY_RESUMED: 'already_resumed',
  BUSY: 'busy',
  IN_FLIGHT: 'in_flight',
} as const;

/** 远程命令错误码类型（由常量对象派生，禁止调用点自写字面量） */
export type RemoteCommandCode = (typeof REMOTE_COMMAND_CODES)[keyof typeof REMOTE_COMMAND_CODES];

/**
 * 远程命令相位（本策略表的行坐标）
 *
 * 与 `TurnState` 的对应关系见 `remotePhaseOf`：
 *   - `idle`：无进行中的轮次（`TurnState` 的 `idle` 与 `settled` 都折算到这里——
 *     远程命令语义上「能不能发新 turn」只关心有没有进行中的轮次，收场态同样是空闲）
 *   - `running`：正在生成
 *   - `waiting-ask`：等待用户回答提问
 *   - `waiting-pause`：已暂停 / 暂停申请在途
 *   - `confirm-pending`：有未裁决的执行类审批（**只做审批**，不代表整轮结束——
 *     此时该轮仍在进行中，只是被审批卡在工具调用点）
 */
export type RemotePhase = 'idle' | 'running' | 'waiting-ask' | 'waiting-pause' | 'confirm-pending';

/**
 * 远程命令（本策略表的列坐标）
 *
 * 取自方案 §6.5 的 `cmd.kind` 九条，**不新造动词**（新增命令必须先改该表，再改本表）。
 */
export type RemoteCommand =
  | 'send'
  | 'interject'
  | 'answer'
  | 'resume'
  | 'pause'
  | 'stop'
  | 'confirm_answer'
  | 'remove_pending_item'
  | 'clear_pending_queue';

/** 单格判定结果：准入，或带固定错误码的拒绝 */
export type RemoteCommandDecision =
  { readonly allow: true } | { readonly allow: false; readonly code: RemoteCommandCode };

/** 准入常量（复用同一对象，便于测试用引用相等断言「没有自造对象」） */
const ALLOW: RemoteCommandDecision = { allow: true };

/** 构造拒绝结果（码只从 `REMOTE_COMMAND_CODES` 取） */
function reject(code: RemoteCommandCode): RemoteCommandDecision {
  return { allow: false, code };
}

/**
 * 真值表（写死 · 逐格有意）
 *
 * 判据来源与取舍理由（每行一段，改格必须先改这里）：
 *
 * - `send`：只有**无进行中轮次**才准发新 turn（`idle`）。其余四相一律 `busy`——
 *   与方案 §6.1「`busy` 看相位，重试也没用（要等本轮结束）」一致；
 *   审批挂起（`confirm-pending`）属同一轮的阻塞点，不是新 turn 的空位。
 * - `interject`：只在**本轮仍在跑**时有意义（`running` / `confirm-pending`）。
 *   审批挂起时 loop 仍持有该轮，插话会进内核队列等审批后消费，故允许；
 *   其余相位没有可插话的轮次 ⇒ `stale_phase`（相位已变，不是「忙」）。
 * - `answer`：仅 `waiting-ask`。错位（迟到回答）一律 `stale_phase`——方案 §6.1 的语义。
 * - `resume`：仅 `waiting-pause` 真正解暂停；`waiting-ask` 是**相位不对**（还卡在问答，
 *   解暂停也推进不了）⇒ `stale_phase`；其余相位对齐方案「`already_resumed` = 会话已不在
 *   `waiting(pause)` ⇒ 手机侧当成功处理（幂等）」。
 * - `pause`：有进行中的轮次（`running` / `waiting-ask` / `confirm-pending`）才可请求；
 *   已暂停（`waiting-pause`）重复请求 = 目标态已达成，幂等放行；`idle` 无轮可暂停 ⇒ `stale_phase`。
 * - `stop`：**恒放行**——安全出口，必须任何相位都能按下去；且停止本身就是幂等的。
 * - `confirm_answer`：仅 `confirm-pending`；其余相位没有待裁决项 ⇒ `stale_phase`。
 * - `remove_pending_item` / `clear_pending_queue`：编辑的是插话队列，与相位无关
 *   （队列空时是 no-op），**恒放行**。
 */
const TABLE: Readonly<Record<RemoteCommand, Readonly<Record<RemotePhase, RemoteCommandDecision>>>> =
  {
    send: {
      idle: ALLOW,
      running: reject(REMOTE_COMMAND_CODES.BUSY),
      'waiting-ask': reject(REMOTE_COMMAND_CODES.BUSY),
      'waiting-pause': reject(REMOTE_COMMAND_CODES.BUSY),
      'confirm-pending': reject(REMOTE_COMMAND_CODES.BUSY),
    },
    interject: {
      idle: reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      running: ALLOW,
      'waiting-ask': reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      'waiting-pause': reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      'confirm-pending': ALLOW,
    },
    answer: {
      idle: reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      running: reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      'waiting-ask': ALLOW,
      'waiting-pause': reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      'confirm-pending': reject(REMOTE_COMMAND_CODES.STALE_PHASE),
    },
    resume: {
      idle: reject(REMOTE_COMMAND_CODES.ALREADY_RESUMED),
      running: reject(REMOTE_COMMAND_CODES.ALREADY_RESUMED),
      'waiting-ask': reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      'waiting-pause': ALLOW,
      'confirm-pending': reject(REMOTE_COMMAND_CODES.ALREADY_RESUMED),
    },
    pause: {
      idle: reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      running: ALLOW,
      'waiting-ask': ALLOW,
      'waiting-pause': ALLOW,
      'confirm-pending': ALLOW,
    },
    stop: {
      idle: ALLOW,
      running: ALLOW,
      'waiting-ask': ALLOW,
      'waiting-pause': ALLOW,
      'confirm-pending': ALLOW,
    },
    confirm_answer: {
      idle: reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      running: reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      'waiting-ask': reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      'waiting-pause': reject(REMOTE_COMMAND_CODES.STALE_PHASE),
      'confirm-pending': ALLOW,
    },
    remove_pending_item: {
      idle: ALLOW,
      running: ALLOW,
      'waiting-ask': ALLOW,
      'waiting-pause': ALLOW,
      'confirm-pending': ALLOW,
    },
    clear_pending_queue: {
      idle: ALLOW,
      running: ALLOW,
      'waiting-ask': ALLOW,
      'waiting-pause': ALLOW,
      'confirm-pending': ALLOW,
    },
  };

/** 表的行全集（供调用方/测试穷举，避免手抄一份键名） */
export const REMOTE_COMMANDS: readonly RemoteCommand[] = [
  'send',
  'interject',
  'answer',
  'resume',
  'pause',
  'stop',
  'confirm_answer',
  'remove_pending_item',
  'clear_pending_queue',
];

/** 表的列全集（供调用方/测试穷举） */
export const REMOTE_PHASES: readonly RemotePhase[] = [
  'idle',
  'running',
  'waiting-ask',
  'waiting-pause',
  'confirm-pending',
];

/**
 * 查表：某命令在某相位是否准入
 *
 * @param command 上行命令（`cmd.kind`）
 * @param phase   该会话当前相位（由宿主投影给出，见 `remotePhaseOf`）
 */
export function evaluateRemoteCommand(
  command: RemoteCommand,
  phase: RemotePhase,
): RemoteCommandDecision {
  return TABLE[command][phase];
}

/**
 * `TurnState` → 远程相位名的适配器（相位素材的唯一折算点）
 *
 * 为什么 `settled` 折算为 `idle`：本表只回答「能不能发新 turn」，收场态与空闲态在这一点上
 * 完全一致（都是「没有进行中的轮次」）；不为此在表里多开一列，避免同一语义两列各判一次。
 *
 * `confirmPending` 优先级最高：审批是安全边界，待裁决期间即使 `TurnState` 只是 `running`，
 * 远程也只能走 `confirm_answer`（其余命令按 `confirm-pending` 列判定）。
 *
 * @param state          宿主投影出的 `TurnState`
 * @param confirmPending 该会话是否有未裁决的执行类审批（`ConfirmCoordinator.pendingCount > 0`）
 */
export function remotePhaseOf(state: TurnState, confirmPending: boolean): RemotePhase {
  if (confirmPending) return 'confirm-pending';
  if (state.phase === 'waiting') return state.reason === 'ask' ? 'waiting-ask' : 'waiting-pause';
  if (state.phase === 'running') return 'running';
  // idle / settled：无进行中的轮次
  return 'idle';
}
