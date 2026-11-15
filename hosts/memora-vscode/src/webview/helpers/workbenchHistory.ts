/**
 * 工作台清单 — 从代理会话历史重建「它开出去过哪些会话」+「它最近派给谁什么」
 *
 * 为什么能重建：`create_session` 每次成功都向模型返回过 `{ ok, sid, title }`，
 * 这次调用与结果已经作为过程事件落在代理会话自己的轮里（`tool_start.args` +
 * `tool_result.summary`）。本模块只是**读既有事实**，不新增持久化字段、不建
 * child→creator 关系表（那与「在管集合不记父子、不建树、不落盘」冲突）。
 *
 * 派发记录同理但更直接：`send_to_session` 的 `tool_start.args` 里就有完整的
 * `{ sid, text }`，回执只有 `{ ok, accepted }`（不含 sid）——所以目标只能从**入参**
 * 取，靠 `toolCallId` 与同轮结果配对确认「这次真派成功了」。这条记录是**主控自己
 * 的工作记录**，单向：不写目标会话任何字段，目标不感知自己被派过。
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
import {
  CREATE_SESSION_TOOL_NAME,
  SEND_TO_SESSION_TOOL_NAME,
} from '../../extension/host/workSessionTools.js';
import type { WorkbenchCoverage } from '../../shared/workbenchDto.js';

/** 单次重建最多读多少轮（改这里必须同时改文案：界面会把这个数字说给用户） */
export const WORKBENCH_REBUILD_MAX_ROUNDS = 60;

/**
 * 派发内容摘录的字符上限（与 `read_memory_summary` 的单条轮摘要同口径）
 *
 * 摘录只用于让主控想起「我派过什么」，不是全文；全文就在代理自己轮的 `args` 里。
 */
export const WORKBENCH_DISPATCH_EXCERPT_CHARS = 120;

/** 历史读取面（由面板注入；本模块不持有存储） */
export interface WorkbenchHistorySources {
  /** 会话的轮 id 列表（有序真源） */
  readRoundIds: (sessionId: string) => readonly string[];
  /** 按轮 id 读整轮（读不到返回 undefined） */
  readRound: (roundId: string) => Round | undefined;
  /** 全部会话 id（反查「被派过活」的候选面；不读轮、只读会话索引） */
  listSessionIds: () => readonly string[];
  /**
   * 按轮 id 读派发归属（**索引级，不读盘**；缺省 / 旧数据返回 undefined）
   *
   * 为什么不用 `readRound`：那是整轮文件读，按会话 × 轮数扫会拖慢开工作台。
   */
  readRoundDispatch: (roundId: string) => Round['dispatchedBy'] | undefined;
}

/** 反查「被派过活」时每个会话最多回看的轮数（从末尾往前、命中即停） */
export const WORKBENCH_DISPATCH_LOOKBACK_ROUNDS = 20;

/** 重建出的子会话（sid 必有；title 可能缺省，由会话元数据兜底） */
export interface WorkbenchHistoryChild {
  /** 子会话标识（`create_session` 返回值里的 sid） */
  sessionId: string;
  /** 创建时给的标题（`tool_start.args.title`；可能缺省） */
  title?: string;
  /**
   * 这条会话是怎么进到工作台的（**两种来源不许混成一种**）
   *
   * - `'create'`：助手开会话（历史里的 `create_session` 成功结果）；
   * - `'delegate'`：被派过活（反查目标会话最近轮的 `Round.dispatchedBy` 得到）。
   *   已经被 `create` 认定的会话不因后来的派发改档：创造是更早的事实。
   */
  via: 'create' | 'delegate';
}

/** 重建出的派发记录（目标会话 + 这次派给它的内容摘录 + 时间） */
export interface WorkbenchHistoryDispatch {
  /** 目标会话标识（`send_to_session.args.sid`；回执里没有 sid，不能从结果解析） */
  sessionId: string;
  /** 派发内容摘录（超长按 `WORKBENCH_DISPATCH_EXCERPT_CHARS` 截断并加省略号） */
  excerpt: string;
  /** 派发时间（ISO 8601；`null` = 事件与轮都没时间戳，不编一个） */
  at: string | null;
}

/** 重建结果 */
export interface WorkbenchHistoryResult {
  /** 历史里能确认创建成功的子会话（按发现顺序，已按 sid 去重） */
  children: WorkbenchHistoryChild[];
  /**
   * 历史里确认派发成功的记录（每个目标会话只保留最近一次）
   *
   * 空数组 = 这段窗口里没读到派发记录，**不等于**「从未派过」：窗口截断 / 读不到
   * 由 `coverage` 说明。只读代理自己的轮，不触碰目标会话的任何字段。
   */
  dispatches: WorkbenchHistoryDispatch[];
  /** 本次读到哪：complete / partial / unreadable */
  coverage: WorkbenchCoverage;
  /** 该会话总轮数 */
  totalRounds: number;
  /** 实际扫描轮数 */
  scannedRounds: number;
  /** 成功调用但解析不出 sid / 派发目标 / 内容的记录数（界面据此说「部分历史读不到」） */
  unreadableRecords: number;
  /**
   * 反查「被派过活」的扫描口径（覆盖度如实上报）
   *
   * `truncated` = 有会话的轮数超过回看上限（说明更早的派发可能读不到，
   * 这是**按设计**排在后面，不是「读失败」；真读失败另计 `unreadableRecords`）。
   */
  dispatchScan: {
    /** 实际参与反查的候选会话数（不含创建者自身、不含已由 create 认定的） */
    sessions: number;
    /** 轮数超过回看上限、只扫了末尾一段的会话数 */
    truncated: number;
  };
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
      dispatches: [],
      coverage: 'unreadable',
      totalRounds: 0,
      scannedRounds: 0,
      unreadableRecords: 0,
      dispatchScan: { sessions: 0, truncated: 0 },
    };
  }
  // 只扫最近 N 轮：超了如实标 partial（旧会话多半在更早的轮里，界面会说明读不全）
  const scanned = roundIds.slice(-WORKBENCH_REBUILD_MAX_ROUNDS);
  const byId = new Map<string, WorkbenchHistoryChild>();
  /** 目标 sid → 最近一次派发（扫描按轮序正序，后到的覆盖先到的） */
  const dispatches = new Map<string, WorkbenchHistoryDispatch>();
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
    collectFromRound(round, byId, dispatches, () => {
      unreadableRecords += 1;
    });
  }
  // 反查「被派过活」：重启后账本为空，靠目标会话最近轮的 `dispatchedBy` 把清单补回来
  const dispatchScan = collectDispatchedChildren(orchestratorId, sources, byId);
  return {
    children: [...byId.values()],
    dispatches: [...dispatches.values()],
    coverage: roundIds.length > scanned.length || unreadableRecords > 0 ? 'partial' : 'complete',
    totalRounds: roundIds.length,
    scannedRounds: scanned.length,
    unreadableRecords,
    dispatchScan,
  };
}

/**
 * 反查「被这位创建者派过活」的会话，并入子会话清单
 *
 * 只认 `Round.dispatchedBy.from === 创建者`——这是「谁派给谁」的唯一真相源；
 * 不拿过程事件倒推创建者（那是同一事实的第二份来源，容易和轮文件打架）。
 *
 * 扫描口径（用户拍板 A）：**从末尾往前、命中即停、每会话最多 20 轮**。
 * 「最近被派过」才有路由价值；很久以前派过、之后又自己聊了很多轮的会话本来就该排后面。
 * 每步走索引级读口（`readRoundDispatch`），零磁盘 IO。
 *
 * @param orchestratorId 创建者会话 id
 * @param sources 读取面
 * @param byId 子会话累加器（已由 `create_session` 认定的不覆盖：创造是更早的事实）
 * @returns 扫描口径（供覆盖度如实上报）
 */
function collectDispatchedChildren(
  orchestratorId: string,
  sources: WorkbenchHistorySources,
  byId: Map<string, WorkbenchHistoryChild>,
): { sessions: number; truncated: number } {
  let ids: readonly string[];
  try {
    ids = sources.listSessionIds();
  } catch {
    // 会话列表读不出来：不补任何「猜测的」子会话，扫描口径如实报 0
    return { sessions: 0, truncated: 0 };
  }
  let sessions = 0;
  let truncated = 0;
  for (const sessionId of ids) {
    if (sessionId === orchestratorId) continue;
    // 已由 create_session 认定：来源以「创造」为准，不因后来的派发改档
    if (byId.has(sessionId)) continue;
    let roundIds: readonly string[];
    try {
      roundIds = sources.readRoundIds(sessionId);
    } catch {
      continue;
    }
    sessions += 1;
    if (roundIds.length > WORKBENCH_DISPATCH_LOOKBACK_ROUNDS) truncated += 1;
    // 从末尾往前扫：命中即停（越近的派发越有路由价值）
    for (
      let i = roundIds.length - 1, seen = 0;
      i >= 0 && seen < WORKBENCH_DISPATCH_LOOKBACK_ROUNDS;
      i -= 1, seen += 1
    ) {
      let dispatch: Round['dispatchedBy'];
      try {
        dispatch = sources.readRoundDispatch(roundIds[i] as string);
      } catch {
        continue;
      }
      // 只认「这位创建者派来的」；别人的派发与旧数据（无字段）一律不算
      if (dispatch?.from === orchestratorId) {
        byId.set(sessionId, { sessionId, via: 'delegate' });
        break;
      }
    }
  }
  return { sessions, truncated };
}

/**
 * 从一轮的过程事件里收集 `create_session` / `send_to_session` 的成功结果
 *
 * 配对方式：同 `toolCallId` 的 `tool_start` 给完整入参、`tool_result(ok)` 确认这次真成功。
 * - 建会话：结果摘要里解析 sid（入参给标题）；
 * - 派发：入参里取 `{ sid, text }`（结果里没有 sid），并取事件时间。
 *
 * 成功过却认不出「哪条会话 / 派了什么」⇒ 记录读不到，不静默丢、不拿别的字段顶替。
 *
 * @param round 整轮
 * @param byId 建会话累加器（sid → 子会话；重复 sid 只保留首次）
 * @param dispatches 派发累加器（目标 sid → 最近一次；后到的覆盖先到的）
 * @param noteUnreadable 记录「读不到」的回调
 */
function collectFromRound(
  round: Round,
  byId: Map<string, WorkbenchHistoryChild>,
  dispatches: Map<string, WorkbenchHistoryDispatch>,
  noteUnreadable: () => void,
): void {
  /** 本轮的建会话调用 → 标题（args 完整；解析失败为 undefined，不阻断 sid 提取） */
  const titles = new Map<string, string | undefined>();
  /** 本轮的派发调用 → 目标与内容（解析失败为 undefined，结果 ok 时计入读不到） */
  const sends = new Map<string, { sid: string; text: string; at: string | null } | undefined>();
  for (const event of round.processEvents ?? []) {
    if (event.type === 'tool_start') {
      if (event.payload.name === CREATE_SESSION_TOOL_NAME) {
        titles.set(event.payload.toolCallId, parseTitle(event.payload.args));
        continue;
      }
      if (event.payload.name === SEND_TO_SESSION_TOOL_NAME) {
        const parsed = parseSendArgs(event.payload.args);
        sends.set(
          event.payload.toolCallId,
          parsed ? { ...parsed, at: resolveEventTime(event.ts, round.createdAt) } : undefined,
        );
      }
      continue;
    }
    if (event.type !== 'tool_result' || !event.payload.ok) continue;
    if (event.payload.name === SEND_TO_SESSION_TOOL_NAME) {
      const send = sends.get(event.payload.toolCallId);
      if (!send) {
        // 成功过但入参认不出目标 / 内容：不能静默丢，也不能编一个目标
        noteUnreadable();
        continue;
      }
      dispatches.set(send.sid, {
        sessionId: send.sid,
        excerpt: excerptOf(send.text),
        at: send.at,
      });
      continue;
    }
    if (event.payload.name !== CREATE_SESSION_TOOL_NAME) continue;
    const sid = parseCreateSessionSid(event.payload.summary ?? '');
    if (!sid) {
      // 成功过但认不出 sid：不能静默丢，计入「读不到」
      noteUnreadable();
      continue;
    }
    if (!byId.has(sid)) {
      // 来源 = 助手开会话（与「被派过活」分档，界面不许混成一种）
      byId.set(sid, { sessionId: sid, title: titles.get(event.payload.toolCallId), via: 'create' });
    }
  }
}

/**
 * 从 `tool_start.args` 里提取派发的目标会话与内容
 *
 * 与 `send_to_session` 的入参封闭契约一致（`{ sid, text }` 且都是非空字符串）。
 * 形状不对返回 undefined，由调用方计入「读不到」——不猜目标、不拿别的键顶替。
 *
 * @param args 工具入参 JSON 文本（完整；可能非法）
 * @returns 目标与内容；解析失败返回 undefined
 */
function parseSendArgs(args: string | undefined): { sid: string; text: string } | undefined {
  if (!args) return undefined;
  try {
    const parsed = JSON.parse(args) as { sid?: unknown; text?: unknown };
    if (typeof parsed.sid !== 'string' || parsed.sid.trim() === '') return undefined;
    if (typeof parsed.text !== 'string' || parsed.text.trim() === '') return undefined;
    return { sid: parsed.sid, text: parsed.text };
  } catch {
    return undefined;
  }
}

/**
 * 解析事件时间：优先工具调用事件自身的 `ts`，缺失时回退整轮创建时间
 *
 * 两者都没有（极旧数据 / 手工构造）时如实返回 `null`，不拿当前时间冒充历史时间。
 *
 * @param ts 事件时间（可能缺省）
 * @param roundCreatedAt 整轮创建时间（可能缺省）
 * @returns ISO 时间或 null
 */
function resolveEventTime(
  ts: string | undefined,
  roundCreatedAt: string | undefined,
): string | null {
  return ts || roundCreatedAt || null;
}

/**
 * 把派发内容截成摘录（只影响展示长度，不改写内容）
 *
 * @param text 派发原文（`send_to_session.args.text`，完整未截断）
 * @returns 不超过上限的摘录；超长时以省略号结尾
 */
function excerptOf(text: string): string {
  return text.length > WORKBENCH_DISPATCH_EXCERPT_CHARS
    ? `${text.slice(0, WORKBENCH_DISPATCH_EXCERPT_CHARS)}…`
    : text;
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
