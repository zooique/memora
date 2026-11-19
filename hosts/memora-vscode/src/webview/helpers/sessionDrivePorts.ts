/**
 * 会话驱动权读盘判据的面板侧适配器（外置以守 `chatPanel.ts` 行数闸门）
 *
 * 为什么单独成文件：`chatPanel.ts` 贴有效行上限，而 notifier 需要一份读盘判据闭包
 * （取代内存 `agentDriven` 集合，见 HOSTED-ROUND-ORIGIN-1）。判据本身在 `shared/sessionStatus.ts`
 * 唯一实现，这里只做「面板私有表 → 读口」的接线，不含第二份判断。
 *
 * 硬约束：
 *   - **只读**：全部经延迟闭包读既有表，不建记录、不缓存、不投消息；
 *   - **懒取**：sources 全是 `() => …`，避开面板字段初始化顺序（notifier 字段早于 workbench / roundStore）；
 *   - **fail-closed**：三态 `undefined` 折 false，与停止 / 暂停 / 工作台同一口径。
 */
import {
  isAgentDrivenFailClosed,
  isUserTakingOverFailClosed,
  type SessionStatusReadPorts,
} from '../../shared/sessionStatus.js';
import type { Round, SessionMeta } from '@zooique/memora';

/** 面板侧可提供的读盘源（全部延迟取，避免字段初始化顺序问题） */
export interface SessionDrivePortSources {
  peekActivity: () => SessionStatusReadPorts['peekActivity'];
  readMeta: () => (sessionId: string) => SessionMeta | undefined;
  readRoundIds: () => (sessionId: string) => readonly string[];
  readRound: () => (roundId: string) => Round | undefined;
}

/**
 * 造一个「该会话当前是否由代理驱动」的读盘判据闭包
 *
 * `readRoundStatus` 刻意不接：判据对最近轮的收场判定有 `round.status` 兜底，面板本就没有
 * 独立的 round 状态索引，传 `() => undefined` 走整轮自带状态，与 extension 侧索引同口径。
 */
export function makeAgentDrivenCheck(
  sources: SessionDrivePortSources,
): (sessionId: string) => boolean {
  return (sessionId) =>
    isAgentDrivenFailClosed(
      {
        peekActivity: sources.peekActivity(),
        readMeta: sources.readMeta(),
        readRoundIds: sources.readRoundIds(),
        readRound: sources.readRound(),
        readRoundStatus: () => undefined,
      },
      sessionId,
    );
}

/**
 * 造一个「用户是否正在这条会话里接管」的读盘判据闭包（派活门禁专用）
 *
 * 与 `makeAgentDrivenCheck` 共用 `SessionDrivePortSources`（同一批延迟闭包），只是判据函数换
 * 成 `isUserTakingOverFailClosed`——派活目标可以是自建会话，门禁看「用户在不在手发轮未收场」
 * 而非「代理在不在驱动」。readRoundStatus 同样走整轮兜底（面板无独立状态索引）。
 */
export function makeUserTakingOverCheck(
  sources: SessionDrivePortSources,
): (sessionId: string) => boolean {
  return (sessionId) =>
    isUserTakingOverFailClosed(
      {
        peekActivity: sources.peekActivity(),
        readMeta: sources.readMeta(),
        readRoundIds: sources.readRoundIds(),
        readRound: sources.readRound(),
        readRoundStatus: () => undefined,
      },
      sessionId,
    );
}
