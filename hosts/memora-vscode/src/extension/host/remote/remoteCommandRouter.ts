/**
 * 远程命令路由（桥层执行面）—— 定址 + 查相位表 + 投递，三件事都不在桥里重写
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §6.6：上行命令**不新造动词**，`send` / `answer` / `resume` 全部落既有的
 *     `handleInput({ type:'input', kind, ... })` 那一条路；
 *   - §6.1：错误码固定集合（本文件只映射，不新增码，也不自造字符串）。
 *
 * ⚠️ 边界（这一段是给下一个改这里的人看的，不是修辞）：
 *   本文件**只**回答三件事——① 该 sid 的会话在不在；② 现在这个相位准不准这条命令；
 *   ③ 准了就交给宿主注入的 `deliverInput`。**业务判断一条都不复制**：
 *     - 不校验 answers 位次（空串占位是内核契约，桥层过滤就会错位）；
 *     - 不判断「是否重复答复」（第一次答复后相位即离开等待态，
 *       重复答复自然落进 `stale_phase`，无需第二个去重判据）；
 *     - 不判断答案 / 文本是否为空、是否越界（那是 `handleInput` 与内核的判据）。
 *   若这里加任何一条业务判断，就会与 `handleInput` 形成两套真相，
 *   且桥层看起来像「可以绕过相位裁决」——**恰恰不能绕过**，裁决仍在 handleInput。
 *
 * 与 `remoteCommandPolicy` 的分工：相位 → 准入的真值表、档位 → 命令的准入表都在那里，
 * 本文件只**消费**（`evaluateRemoteCommand`），不改写、不另存一份。
 */

import type { WebviewToExtensionMessage } from '../../../shared/protocol.js';
import {
  REMOTE_COMMAND_CODES,
  evaluateRemoteCommand,
  type RemoteCommandCode,
  type RemotePhase,
} from './remoteCommandPolicy.js';

/** 落 `handleInput` 的那条输入消息类型（桥与路由共用的唯一形状来源） */
export type RemoteInputMessage = Extract<WebviewToExtensionMessage, { type: 'input' }>;

/**
 * 本执行面承载的命令（有宿主落点的那三条）
 *
 * 用判别联合而不是 `{ command, input }` 两字段：`kind` 只写一次，
 * 相位查表与投递必然指向同一条命令，杜绝「按 send 查表、投递 answer」的错配。
 * 其余六条命令没有 input 落点 ⇒ 不进本执行面（桥直接回 `forbidden`，见 `remoteBridge`）。
 */
export type RemoteInputCommand =
  | { readonly kind: 'send'; readonly text: string }
  | { readonly kind: 'answer'; readonly answers: readonly string[] }
  | { readonly kind: 'resume' };

/**
 * 桥层依赖（由宿主注入；`deliverInput` 的实现必须就是 `panel.handleInput(input, sid)`
 * 那一条路，不得另建投递链）
 */
export interface RemoteCommandPorts {
  /** 会话是否存在且已装配（定址判据的唯一来源） */
  hasSession: (sessionId: string) => boolean;
  /** 该会话当前相位（宿主投影给出，见 remoteCommandPolicy.remotePhaseOf） */
  phaseOf: (sessionId: string) => RemotePhase;
  /** 投递到既有输入入口（不返回业务结果：受理与否由相位决定，不由这里二次判定） */
  deliverInput: (sessionId: string, input: RemoteInputMessage) => void;
}

/** 路由结果：受理，或带固定错误码的拒绝 */
export type RemoteCommandDecision = { ok: true } | { ok: false; code: RemoteCommandCode };

/**
 * 把远程命令映射成宿主既有的 input 消息（§6.6 的「落到宿主」一列）
 *
 * 只做形状搬运：`answers` 复制一份是为了满足协议侧的可变数组类型，
 * **不 trim、不过滤、不改位次**（位次不变量归内核与 handleInput）。
 */
function toInputMessage(command: RemoteInputCommand): RemoteInputMessage {
  switch (command.kind) {
    case 'send':
      return { type: 'input', kind: 'send', text: command.text };
    case 'answer':
      return { type: 'input', kind: 'answer', answers: [...command.answers] };
    case 'resume':
      return { type: 'input', kind: 'resume' };
  }
}

/**
 * 把一条远程命令路由到指定会话
 *
 * @param command   已解析的上行命令（载荷校验在桥层完成，此处不再看原始帧）
 * @param sessionId 目标会话（定址由调用方从命令载荷取，桥层不再改写）
 * @param ports     宿主注入的三个窄接口
 */
export function routeRemoteCommand(
  command: RemoteInputCommand,
  sessionId: string,
  ports: RemoteCommandPorts,
): RemoteCommandDecision {
  // ① 定址：会话不存在（或未装配 Agent）→ no_session（方案 §6.1）
  if (!ports.hasSession(sessionId)) {
    return { ok: false, code: REMOTE_COMMAND_CODES.NO_SESSION };
  }
  // ② 相位：复用真值表（send 仅 idle；answer 仅 waiting-ask；resume 仅 waiting-pause）
  const verdict = evaluateRemoteCommand(command.kind, ports.phaseOf(sessionId));
  if (!verdict.allow) return { ok: false, code: verdict.code };
  // ③ 投递：交给既有入口；不做任何业务加工——加工就是第二套判据
  ports.deliverInput(sessionId, toInputMessage(command));
  return { ok: true };
}
