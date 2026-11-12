/**
 * 远程应答路由（R0-c 的 ask 半边 · 桥层）—— 只做定址与错误码映射
 *
 * 设计源：docs/方案-手机远程控制-20261110.md §6.6（`cmd.kind:'answer'` → `handleInput({kind:'answer'})`）
 *
 * ⚠️ 边界（这一段是给下一个改这里的人看的，不是修辞）：
 *   本文件**只**回答三件事——① 该 sid 的会话在不在；② 它现在是什么相位；
 *   ③ 不在等待问答就映射成固定错误码。**业务判断一条都不复制**：
 *     - 不校验 answers 位次（空串占位是内核契约，桥层过滤就会错位）；
 *     - 不判断「是否重复答复」（第一次答复后相位即离开 waiting-ask，
 *       重复答复自然落进 `stale_phase`，无需第二个去重判据）；
 *     - 不判断答案是否为空 / 是否越界（那是 `answerQuestion` 与内核的判据）。
 *   若这里加任何一条业务判断，就会与 `handleInput` 形成两套真相，
 *   且桥层看起来像「可以绕过相位裁决」——**恰恰不能绕过**，裁决仍在 handleInput。
 *
 * 相位 → 准入的判据不在此处重写：直接复用 `remoteCommandPolicy` 的张量（`answer` 行），
 * 真值表只此一份。
 */

import {
  REMOTE_COMMAND_CODES,
  evaluateRemoteCommand,
  type RemoteCommandCode,
  type RemotePhase,
} from './remoteCommandPolicy.js';

/**
 * 桥层依赖（由宿主注入；`deliverAnswer` 的实现必须就是
 * `handleInput({ type:'input', kind:'answer', answers })` 那一条路，不得另建投递链）
 */
export interface RemoteAnswerPorts {
  /** 会话是否存在且已装配（定址判据的唯一来源） */
  hasSession: (sessionId: string) => boolean;
  /** 该会话当前相位（宿主投影给出，见 remoteCommandPolicy.remotePhaseOf） */
  phaseOf: (sessionId: string) => RemotePhase;
  /** 投递答复到既有入口（不返回业务结果：受理与否由相位决定，不由这里二次判定） */
  deliverAnswer: (sessionId: string, answers: readonly string[]) => void;
}

/** 路由结果：受理，或带固定错误码的拒绝 */
export type RemoteAnswerDecision = { ok: true } | { ok: false; code: RemoteCommandCode };

/**
 * 把一条远程答复命令路由到指定会话
 *
 * @param sessionId 目标会话（定址由调用方从命令载荷取，桥层不再改写）
 * @param answers   答复载荷（**原样透传**，位次 / 空串 / 长度均不在此处处理）
 * @param ports     宿主注入的三个窄接口
 */
export function routeRemoteAnswer(
  sessionId: string,
  answers: readonly string[],
  ports: RemoteAnswerPorts,
): RemoteAnswerDecision {
  // ① 定址：会话不存在（或未装配 Agent）→ no_session（方案 §6.1）
  if (!ports.hasSession(sessionId)) {
    return { ok: false, code: REMOTE_COMMAND_CODES.NO_SESSION };
  }
  // ② 相位：复用真值表 answer 行（仅 waiting-ask 放行；其余 stale_phase）
  const verdict = evaluateRemoteCommand('answer', ports.phaseOf(sessionId));
  if (!verdict.allow) return { ok: false, code: verdict.code };
  // ③ 投递：不复制 answers，也不做任何业务加工——加工就是第二套判据
  ports.deliverAnswer(sessionId, answers);
  return { ok: true };
}
