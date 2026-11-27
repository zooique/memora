/**
 * 远程快照裁剪（§6.4 `TrimmedRound`）—— 出桥前的唯一裁剪点（纯函数，无 IO / 无 vscode 依赖）
 *
 * 设计源：docs/方案-手机远程控制-20261110.md
 *   - §6.4 第 1 条：`turn_update` 每次携带完整 `rounds[]`（含 `assistantLog` 全文 + 全部
 *     `processEvents`），手机上等于每步重传整段历史 ⇒ 下发前必须裁剪；
 *   - §6.4 第 2 条：`attachmentUris` 是 `asWebviewUri` 产物，手机 origin 不同必然 404
 *     ⇒ **一律不下发**，改走 blob 通道（尚未实现）。
 *
 * 为什么收成纯函数而不是散在宿主适配里：回环档与 LAN 档各有一份投影实现，
 * 若各自裁剪一次，两份上限必然漂移；收在这里后桥的 `pushSnapshot` 单点调用，
 * 任何宿主实现自动共享同一口径。
 */

import type { RoundView } from '../../../shared/protocol.js';

/**
 * 每轮保留的最近过程事件条数（单一常量）
 *
 * 取值口径：手机首屏只需「最近发生了什么」，更早的历史由后续 blob 通道按需拉取。
 * 与 §6.7 的 500 条 / 2MB **补洞窗口不是同一个量**——那个是断线重连的增量回放窗口，
 * 这里是快照体积上限；两者不合并，避免「调一个顺手改了另一个」。
 */
export const TRIMMED_RECENT_EVENTS = 50;

/** 每轮保留的最近 `assistantLog` 段数（跨暂停-续跑的前序段；末段在 `assistantMessage`） */
export const TRIMMED_RECENT_LOG = 20;

/**
 * 出桥的单轮投影（§6.4 `TrimmedRound`）
 *
 * 相对 `RoundView` 的三处差异：
 *   ① `attachmentUris` **整键删除**（不是置 `undefined`——键存在本身就会诱导消费方去拼地址）；
 *   ② `processEvents` / `assistantLog` 只保留最近 N 条；
 *   ③ 发生裁剪时带 `truncated` 计数（缺省 = 未裁剪）。
 *
 * `truncated` 是 blob 通道落地前**唯一的诚实信号**：手机据此知道「这不是全部历史」，
 * 不得把它当完整轮次渲染。它不携带原文，不构成第二个真源。
 */
export type TrimmedRound = Omit<RoundView, 'attachmentUris' | 'processEvents' | 'assistantLog'> & {
  /** 最近 N 条过程事件（原数组未超限时逐字保留） */
  processEvents?: RoundView['processEvents'];
  /** 最近 N 段前序回答（原数组未超限时逐字保留） */
  assistantLog?: RoundView['assistantLog'];
  /** 被裁掉的更早条目数（0 / 缺省 = 未裁剪；两者都 > 0 时才会出现该字段） */
  truncated?: { processEvents: number; assistantLog: number };
};

/**
 * 把一轮 webview 投影裁成出桥形态
 *
 * 不修改入参（`projectSession` 的产物可能被 webview 侧继续使用），返回新对象；
 * 未超限的数组**原样引用**（不做无意义的拷贝，顺序与内容逐字不变）。
 *
 * @param round 宿主投影出的单轮（`RoundView`）
 * @param includeProcessEvents 是否下发过程事件明细；缺省 true。§6.8 能力门控源头之一：
 *   关闭时**整键删除** `processEvents`（不是留空数组——空数组会诱导消费方当成「本轮无事件」）
 */
export function trimRound(round: RoundView, includeProcessEvents = true): TrimmedRound {
  // ① 先浅拷贝再**整键删除**附件 URL：保留键（哪怕值为 undefined）会诱导消费方去拼地址
  const trimmed = { ...round } as TrimmedRound & {
    attachmentUris?: RoundView['attachmentUris'];
    processEvents?: RoundView['processEvents'];
  };
  delete trimmed.attachmentUris;
  if (!includeProcessEvents) delete trimmed.processEvents;
  // ② 过程事件：只留尾部（`slice(-0)` 会返回整段，故 0 条时单独处理）
  const { processEvents, assistantLog } = round;
  if (includeProcessEvents && processEvents !== undefined) {
    trimmed.processEvents =
      processEvents.length > TRIMMED_RECENT_EVENTS
        ? processEvents.slice(-TRIMMED_RECENT_EVENTS)
        : processEvents;
  }
  // ③ 前序回答段：同上
  if (assistantLog !== undefined) {
    trimmed.assistantLog =
      assistantLog.length > TRIMMED_RECENT_LOG
        ? assistantLog.slice(-TRIMMED_RECENT_LOG)
        : assistantLog;
  }
  // ④ 裁剪发生时才带计数（未裁剪的快照形状与升级前一致，少一个可选字段）
  const droppedEvents = includeProcessEvents
    ? (processEvents?.length ?? 0) - (trimmed.processEvents?.length ?? 0)
    : 0;
  const droppedLog = (assistantLog?.length ?? 0) - (trimmed.assistantLog?.length ?? 0);
  if (droppedEvents > 0 || droppedLog > 0) {
    trimmed.truncated = { processEvents: droppedEvents, assistantLog: droppedLog };
  }
  return trimmed;
}
