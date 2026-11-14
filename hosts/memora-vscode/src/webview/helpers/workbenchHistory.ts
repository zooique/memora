/**
 * 工作台清单 — 从代理会话历史重建「它开出去过哪些会话」
 *
 * 为什么能重建：`create_session` 每次成功都向模型返回过 `{ ok, sid, title }`，
 * 这次调用与结果已经作为过程事件落在代理会话自己的轮里（`tool_start.args` +
 * `tool_result.summary`）。本模块只是**读既有事实**，不新增持久化字段、不建
 * child→creator 关系表（那与「在管集合不记父子、不建树、不落盘」冲突）。
 *
 * 读取边界（硬约束）：
 *   - 只在打开工作台时调用一次（调用方负责），不在启动时全量扫；
 *   - 单次最多扫描 `WORKBENCH_REBUILD_MAX_ROUNDS` 轮；超出时 `coverage='partial'`，
 *     由界面明说「只读了最近 N 轮」（不悄悄截断当完整）；
 *   - 轮读不出来 / 成功调用解析不出 sid ⇒ 计入 `unreadableRecords`，界面显示「读不到」；
 *     **不把读失败渲染成空清单**（空清单 = 一条活都没有，是谎报）。
 *
 * 已知的数据形态约束：`tool_result.summary` 会被内核截到 100 字符，但 `sid` 出现在
 * 结果 JSON 的前部，可稳定解析；标题优先取 `tool_start.args`（完整未截断），
 * 取不到时再由调用方用会话元数据标题兜底。
 *
 * 🔒 与产生点的互锁（WORKBENCH-SID-1）：摘要文本由宿主
 * `extension/host/workSessionTools.ts` 的 `serializeCreateSessionResult` 唯一产生；
 * 本节的前缀假设与 `parseCreateSessionSid` 的解析是同一份契约，改动必须同步，
 * 由 `__tests__/workbenchSidContract.test.ts` 钉住。解析失败一律计入 `unreadableRecords`
 * （界面显示「部分历史读不到」），**不**静默跳过、**不**当成「没有」。
 */
import type { Round } from '@zooique/memora';
import { CREATE_SESSION_TOOL_NAME } from '../../extension/host/workSessionTools.js';
import type { WorkbenchCoverage } from '../../shared/workbenchDto.js';

/** 单次重建最多读多少轮（改这里必须同时改文案：界面会把这个数字说给用户） */
export const WORKBENCH_REBUILD_MAX_ROUNDS = 60;

/** 历史读取面（由面板注入；本模块不持有存储） */
export interface WorkbenchHistorySources {
  /** 会话的轮 id 列表（有序真源） */
  readRoundIds: (sessionId: string) => readonly string[];
  /** 按轮 id 读整轮（读不到返回 undefined） */
  readRound: (roundId: string) => Round | undefined;
}

/** 重建出的子会话（sid 必有；title 可能缺省，由会话元数据兜底） */
export interface WorkbenchHistoryChild {
  /** 子会话标识（`create_session` 返回值里的 sid） */
  sessionId: string;
  /** 创建时给的标题（`tool_start.args.title`；可能缺省） */
  title?: string;
}

/** 重建结果 */
export interface WorkbenchHistoryResult {
  /** 历史里能确认创建成功的子会话（按发现顺序，已按 sid 去重） */
  children: WorkbenchHistoryChild[];
  /** 本次读到哪：complete / partial / unreadable */
  coverage: WorkbenchCoverage;
  /** 该会话总轮数 */
  totalRounds: number;
  /** 实际扫描轮数 */
  scannedRounds: number;
  /** 成功调用但解析不出 sid 的记录数（界面据此说「部分历史读不到」） */
  unreadableRecords: number;
}

/**
 * 从代理会话历史重建子会话清单
 *
 * @param orchestratorId 座位会话 id（代理自己那条会话）
 * @param sources 轮列表与整轮读取口
 * @returns 重建结果（永不抛；读失败用 `coverage='unreadable'` 表达）
 */
export function rebuildWorkbenchChildren(
  orchestratorId: string,
  sources: WorkbenchHistorySources,
): WorkbenchHistoryResult {
  // 轮列表读失败 = 历史读不出来：如实标 unreadable，不返回「空清单」冒充没有
  let roundIds: readonly string[];
  try {
    roundIds = sources.readRoundIds(orchestratorId);
  } catch {
    return {
      children: [],
      coverage: 'unreadable',
      totalRounds: 0,
      scannedRounds: 0,
      unreadableRecords: 0,
    };
  }
  // 只扫最近 N 轮：超了如实标 partial（旧会话多半在更早的轮里，界面会说明读不全）
  const scanned = roundIds.slice(-WORKBENCH_REBUILD_MAX_ROUNDS);
  const byId = new Map<string, WorkbenchHistoryChild>();
  let unreadableRecords = 0;
  for (const roundId of scanned) {
    let round: Round | undefined;
    try {
      round = sources.readRound(roundId);
    } catch {
      round = undefined;
    }
    // 轮读不到：它可能含 create_session 记录 ⇒ 计入读不到，不能当「这一轮没有」
    if (!round) {
      unreadableRecords += 1;
      continue;
    }
    collectFromRound(round, byId, () => {
      unreadableRecords += 1;
    });
  }
  return {
    children: [...byId.values()],
    coverage: roundIds.length > scanned.length || unreadableRecords > 0 ? 'partial' : 'complete',
    totalRounds: roundIds.length,
    scannedRounds: scanned.length,
    unreadableRecords,
  };
}

/**
 * 从一轮的过程事件里收集 `create_session` 的成功结果
 *
 * 配对方式：同 `toolCallId` 的 `tool_start` 给标题、`tool_result(ok)` 给 sid。
 * 结果事件没带 sid ⇒ 记录读不到（成功过、但认不出是哪条会话）。
 *
 * @param round 整轮
 * @param byId 结果累加器（sid → 子会话；重复 sid 只保留首次）
 * @param noteUnreadable 记录「读不到」的回调
 */
function collectFromRound(
  round: Round,
  byId: Map<string, WorkbenchHistoryChild>,
  noteUnreadable: () => void,
): void {
  /** 本轮的调用 → 标题（args 完整；解析失败为 undefined，不阻断 sid 提取） */
  const titles = new Map<string, string | undefined>();
  for (const event of round.processEvents ?? []) {
    if (event.type === 'tool_start' && event.payload.name === CREATE_SESSION_TOOL_NAME) {
      titles.set(event.payload.toolCallId, parseTitle(event.payload.args));
      continue;
    }
    if (
      event.type !== 'tool_result' ||
      event.payload.name !== CREATE_SESSION_TOOL_NAME ||
      !event.payload.ok
    ) {
      continue;
    }
    const sid = parseCreateSessionSid(event.payload.summary ?? '');
    if (!sid) {
      // 成功过但认不出 sid：不能静默丢，计入「读不到」
      noteUnreadable();
      continue;
    }
    if (!byId.has(sid)) {
      byId.set(sid, { sessionId: sid, title: titles.get(event.payload.toolCallId) });
    }
  }
}

/**
 * 从 `tool_result.summary`（可能被截断）里提取 sid
 *
 * 🔒 互锁（WORKBENCH-SID-1）：本解析**假设**文本由
 * `extension/host/workSessionTools.ts` 的 `serializeCreateSessionResult` 产出——
 * `{\n  "ok": true,\n  "sid": "<sid>", …`，且 sid 落在内核 100 字符摘要窗口内。
 * 改那边的缩进 / 键序 / 字段名，必须同步改这里与互锁测试
 * `src/webview/__tests__/workbenchSidContract.test.ts`。解析不出来时调用方会计入
 * 「读不到」（不静默丢、不当成没有）。
 *
 * 结果 JSON 形如 `{ "ok": true, "sid": "2026-11-14-session-xxx", ... }`；
 * sid 在前部，100 字符足够完整出现。容忍空格 / 单双引号差异。
 *
 * @param summary 工具结果摘要（截断后的 JSON 文本）
 * @returns sid；解析不到返回 undefined
 */
export function parseCreateSessionSid(summary: string): string | undefined {
  const match = /["']?sid["']?\s*:\s*["']([^"']+)["']/.exec(summary);
  return match?.[1];
}

/**
 * 从 `tool_start.args` 里提取创建时给的标题
 *
 * 范围声明不走这里：它随创建写进会话元数据（`SessionMeta.declaredPaths`），
 * 读侧直接读元数据，不靠 60 轮窗口反推。
 *
 * @param args 工具入参 JSON 文本（完整；可能非法）
 * @returns 标题；未给 / 解析失败返回 undefined（由元数据标题兜底）
 */
function parseTitle(args: string | undefined): string | undefined {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as { title?: unknown };
    return typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : undefined;
  } catch {
    return undefined;
  }
}
