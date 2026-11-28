/**
 * 富增量差分（§6.4.1 的 `append_text` / `process_event`）—— 纯函数，零 IO / 零 vscode
 *
 * 为什么是独立纯函数而不是塞进桥：桥负责连接、水位、回放窗等有状态职责，差分判据若散在
 * 其中，测试只能靠端到端帧序间接覆盖；收成纯函数后「不重不漏」可直接对拍游标与快照。
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §6.4.1（判别联合三类逐字段）、§6.7
 * （文本流 200–300ms 合并、watermark 回放）。本文件只产规格（载荷描述），帧构造一律
 * 回 `remoteBridgeProtocol` 的唯一构造点，避免第二真源。
 */

import type { ProcessEvent, RoundMessage } from '@zooique/memora';
import type { SnapshotPayload } from './remoteBridgeProtocol.js';

/**
 * 富增量游标（每设备每会话一份，挂在 `DeviceStreamState` 上）
 *
 * - `roundId`：上次差分的 live 轮身份；`RoundView.id` 即 `PendingLiveRound.roundId`
 *   （`toRoundView` 单点赋值），轮切换即整轮重置，避免跨轮正文/事件串味。
 * - `text`：上次已发的正文字串（前缀）。流内正文单调追加，新文本必以它为前缀；
 *   若不满足（异常回退），本轮不发正文帧、游标仍推进——宁可漏一次也不发重复/错位正文。
 * - `eventSeq`：上次已发的最大 `ProcessEvent.seq`（轮内序号，非封套水位）；事件按它过滤，
 *   重复触发同一快照时零增量。
 */
export interface RichCursor {
  roundId?: string;
  text: string;
  eventSeq: number;
}

/** 差分规格（载荷形状；帧由协议层唯一构造点落） */
export type RichDeltaSpec =
  | { kind: 'append_text'; roundId: string; text: string }
  | { kind: 'process_event'; roundId: string; event: ProcessEvent }
  /**
   * 本轮用户气泡（§6.4.2 · 上屏时机挂在轮锚确立这一刻，不挂队列消费）。
   *
   * 为什么需要独立 kind：手机只从 `rounds[].userMessage` 画气泡，而 `append_text` /
   * `process_event` 都不带它 ⇒ 收场快照到达前手机只能画空壳正文，表现为「用户输入后
   * 要等任务结束才出现气泡」。本规格与 `toRoundView` 同源：`userMessage` 逐字透传、
   * `createdAt` 取 `userMessage.timestamp`（不另造 ts，对齐 PC 的 `fmtTime` 口径）。
   *
   * 时机边界：只在**轮切换**分支产出——订阅那刻的快照已含 userMessage（游标 roundId
   * 已初始化为该轮），重推等于把历史当用户新输入；首轮无 roundId 时不产（无锚气泡）。
   */
  | { kind: 'user_message'; roundId: string; userMessage: RoundMessage; createdAt?: string };

/** 一个 live 轮内的最大事件 seq（无事件返回 0） */
function maxEventSeq(events: readonly ProcessEvent[] | undefined): number {
  let max = 0;
  if (!events) return max;
  for (const event of events) {
    if (event.seq > max) max = event.seq;
  }
  return max;
}

/** live 轮的正文（末段 `assistantMessage.content`；无流返回空串） */
function liveText(snapshot: SnapshotPayload): string {
  const live = snapshot.rounds.find((round) => round.live === true);
  return live?.assistantMessage?.content ?? '';
}

/**
 * 用当前快照初始化游标（`sub` / 重订阅必调）
 *
 * 不初始化会把订阅那刻已有的正文与历史事件当增量重发——手机刚拿到整帧 snapshot，
 * 紧接又收一份重复正文，就是「重」。这是富 delta 的第一道 fail-closed。
 */
export function initRichCursor(snapshot: SnapshotPayload): RichCursor {
  const live = snapshot.rounds.find((round) => round.live === true);
  return {
    roundId: live?.id,
    text: liveText(snapshot),
    eventSeq: maxEventSeq(live?.processEvents),
  };
}

/**
 * 从当前快照与上游标差分出富增量规格，并给出推进后的游标
 *
 * 返回空 `specs` 表示本次无新增正文/事件——调用方**仍可发 status 帧**（相位是独立维度），
 * 但不得伪造富帧。新游标取当前快照的真实状态（等价于 `initRichCursor`），故重复调用
 * 同一快照必零增量（幂等）。
 *
 * 轮切换（`roundId` 变化）视为新轮：把当前正文与事件全量作为增量发出——此时手机侧
 * 上一轮已收场、新一轮未见过，全量即「不漏」，不是把历史重发。
 */
export interface RichDeltaResult {
  specs: RichDeltaSpec[];
  next: RichCursor;
  /**
   * 正文前缀断裂（内核 `narrate.withdrawn` 回抽等回退）：append-only 增量无法撤回已发正文，
   * 桥必须补一帧 `snapshot` 让手机全量重建；单靠游标推进会把错字永久留在手机上。
   */
  resync: boolean;
}

export function diffRichDelta(snapshot: SnapshotPayload, cursor: RichCursor): RichDeltaResult {
  const next = initRichCursor(snapshot);
  const live = snapshot.rounds.find((round) => round.live === true);
  const specs: RichDeltaSpec[] = [];
  // 流已收场（无 live 轮）：富增量无可指轮，静默零增量；落盘内容由下一次 snapshot 覆盖。
  if (!live || !next.roundId) return { specs, next, resync: false };
  const roundId = next.roundId;

  if (cursor.roundId !== roundId) {
    // 新轮整轮基础事实：用户气泡先于正文/过程事件上屏——轮锚已确立，真实 ts 同源可取。
    // 只在 userMessage 存在时产（resume 轮无 seed 且落盘未补时整轮本就不并入，见 mergeLiveRound）。
    if (live.userMessage) {
      specs.push({
        kind: 'user_message',
        roundId,
        userMessage: live.userMessage,
        ...(live.createdAt ? { createdAt: live.createdAt } : {}),
      });
    }
    if (next.text.length > 0) specs.push({ kind: 'append_text', roundId, text: next.text });
    for (const event of live.processEvents ?? []) {
      specs.push({ kind: 'process_event', roundId, event });
    }
    return { specs, next, resync: false };
  }

  // 前缀差分：只在正文单调追加时发后缀；回退标 resync 让桥补快照全量重建（手机端全量替换语义）
  const broken = cursor.text.length > 0 && !next.text.startsWith(cursor.text);
  if (!broken && next.text.length > cursor.text.length) {
    specs.push({ kind: 'append_text', roundId, text: next.text.slice(cursor.text.length) });
  }
  // 事件按轮内 seq 过滤；序号不回退（内核单调打标），故 `>` 即严格新增
  for (const event of live.processEvents ?? []) {
    if (event.seq > cursor.eventSeq) specs.push({ kind: 'process_event', roundId, event });
  }
  return { specs, next, resync: broken };
}
