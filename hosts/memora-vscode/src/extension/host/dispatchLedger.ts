/**
 * 派活账本（判据 C）—— «我派出去的东西现在什么状态» 的落盘数据层
 *
 * ## 只解决一个问题
 * 助手通过 `send_to_session` / `create_session` 派出去的活，在宿主侧原本只有
 * `Round.dispatchedBy`（目标轮建出来之后才有）和进程内创建者账本（重启即空）。
 * 于是「派了 5 个、回来 3 个、还有 2 个在跑」只能靠人记。本模块把每次**受理成功**的
 * 派活记成一条 `pending`，等目标轮以**系统落定事件**收场时核销成 `settled`；
 * 超过超时窗仍无结果的 `pending` 在查询时定性为 `orphaned`（悬空），绝不猜成功。
 *
 * ## 硬边界（越界即失败）
 * - 只记 `send_to_session` 与 `create_session` 两类动作，其他工具一概不记；
 * - **不是**「谁派给谁」的第二真源：归属真相仍是 `Round.dispatchedBy`，本账只记
 *   状态与时序，调用方关系仅作查询快照，任何归属判据都不许改读本账；
 * - 核销只认 `HostedSessionNotifier` 的落定回程（系统事件），不看模型正文；
 * - 只做数据层：不导出任何渲染 / 协议消息，本次也不接消费方；
 * - 旁路纪律：写失败只 `logger.warn`，绝不 throw 到派发 / 建会话路径。
 *
 * ## 存储形态：append-only JSONL
 * 文件 = `<项目>/.memora/dispatch-ledger.jsonl`（目录经 `projectDataDir.ts` 单点推导）。
 * 两类事件各占一行：
 *   - `dispatch`：受理成功时追加（kind / 调用方 / 目标 / 标题 / 原文前缀 / 时刻）；
 *   - `settle`：有结局时追加（targetSid / roundId / outcome / 时刻）。
 *
 * 事件配对只认**文件行序**：JSONL 是 append-only，行顺序就是事件的真实顺序；
 * `createdAt` / `settledAt` 只给人看，**不参与匹配**——时间戳表达「什么时候」，
 * 不表达「先后」，跨进程或高精度并写时会骗人（真机曾出现 settle 早于 dispatch 的假象）。
 * 另有两条写侧铁律：
 *   - 无主 settle（同目标没有任何在途 dispatch）**不写**——账本里不该出现无主事件；
 *   - 起流未成立的派发必须补写 `outcome: 'aborted'` 终态，否则一小时后会被误判悬空。
 *
 * 为什么不是整份 JSON 读改写：同一项目的多个 VS Code 窗口可同时写这份账，
 * 「读旧副本 → 改 → 整份覆盖」会让后写者吞掉先写者的账；追加写没有这个覆盖窗口。
 * 读侧按行折叠事件，坏行跳过并 warn（单行损坏不连坐整本账）；整文件读不了按空账 + warn。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { logger } from '@zooique/memora';
import { resolveProjectDataDir } from './projectDataDir.js';

/** 账本文件名（与目录单点同文件；落盘位置 = `<数据目录>/dispatch-ledger.jsonl`） */
export const DISPATCH_LEDGER_FILE_NAME = 'dispatch-ledger.jsonl';

/**
 * 悬空判定的超时窗口（毫秒）
 *
 * 数值待真机校准：ask_user 的保底等待是 30 分钟，这里留一倍余量，
 * 避免「正在等用户作答」的合法在途活被误判成悬空；真机采样后再调。
 */
export const DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * 原文入账的最大字符数
 *
 * 账本只用于「认出这是哪条活」，不是正文存储：超长输入只留前缀，
 * 避免单条派活把账本撑成第二份对话历史。
 */
export const DISPATCH_LEDGER_TEXT_MAX_CHARS = 500;

/** 派活动作类型（只允许这两类，与硬边界一一对应） */
export type DispatchLedgerKind = 'send' | 'create';

/** 派活状态：在途 / 已核销 / 悬空（悬空是查询时按超时窗推导出来的） */
export type DispatchLedgerStatus = 'pending' | 'settled' | 'orphaned';

/**
 * 核销结论
 *
 * 前三档 = 通知器系统落定回程给出的结论（同一份判定，不在宿主另判一次）；
 * `aborted` = 派发侧自身未起流（create 的 `startFlow` 抛错），没有轮可落定，
 * 但也必须留下结局，否则这笔 pending 会在超时后被误判成悬空。
 */
export type DispatchLedgerOutcome = 'success' | 'failed' | 'interrupted' | 'aborted';

/** 受理时写入账本的字段（不含状态；状态由 settle 事件 / 查询时推导） */
export interface DispatchLedgerDispatchInput {
  /** 动作类型：派给已有会话 / 新建会话 */
  kind: DispatchLedgerKind;
  /** 调用方（主控会话）id */
  callerSessionId: string;
  /** 目标会话 id */
  targetSessionId: string;
  /** 目标会话标题（受理时的展示名快照） */
  targetTitle: string;
  /** 派活原文（入账时截断到 {@link DISPATCH_LEDGER_TEXT_MAX_CHARS}） */
  text: string;
  /** 调用方当时的轮 id（可选；只作追溯线索，不参与判定） */
  callerRoundId?: string;
  /** 受理时刻（缺省 = 现在；测试可注入固定值） */
  createdAt?: string;
}

/** 核销事件入参（只来自系统落定回程） */
export interface DispatchLedgerSettlementInput {
  /** 刚收场的目标会话 id */
  targetSessionId: string;
  /** 目标会话收场轮 id（系统事件给的事实，不是猜的） */
  roundId: string;
  /** 落定结论 */
  outcome: DispatchLedgerOutcome;
  /** 落定时刻（缺省 = 现在；测试可注入固定值） */
  settledAt?: string;
}

/** 账本对外记录（读函数的返回形状；只读消费方直接用它） */
export interface DispatchLedgerRecord {
  /** 账本记录 id（受理时生成，核销不换 id） */
  id: string;
  /** 动作类型 */
  kind: DispatchLedgerKind;
  /** 调用方会话 id */
  callerSessionId: string;
  /** 目标会话 id */
  targetSessionId: string;
  /** 目标会话标题快照 */
  targetTitle: string;
  /** 派活原文前缀（已按上限截断） */
  text: string;
  /** 调用方当时的轮 id（取不到则缺省） */
  callerRoundId?: string;
  /** 受理时刻（ISO） */
  createdAt: string;
  /** 当前状态（pending / settled / orphaned） */
  status: DispatchLedgerStatus;
  /** 核销时刻（仅 settled） */
  settledAt?: string;
  /** 目标收场轮 id（仅 settled；核销靠系统事件给出） */
  roundId?: string;
  /** 落定结论（仅 settled） */
  outcome?: DispatchLedgerOutcome;
}

/** 查询参数（全部可选：缺省读全账 + 按当前时刻判悬空） */
export interface DispatchLedgerQuery {
  /** 判定悬空用的当前时刻（缺省 = Date.now()；测试可注入） */
  now?: number;
  /** 只看某个调用方派出的活 */
  callerSessionId?: string;
  /** 只看派给某个目标会话的活 */
  targetSessionId?: string;
  /** 悬空超时窗（缺省 = {@link DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS}；测试可缩短） */
  orphanTimeoutMs?: number;
}

/** 账本事件：追加写的最小单元（dispatch 与 settle 共用一行一个 JSON） */
type DispatchLedgerEvent =
  | {
      type: 'dispatch';
      id: string;
      kind: DispatchLedgerKind;
      callerSessionId: string;
      targetSessionId: string;
      targetTitle: string;
      text: string;
      callerRoundId?: string;
      createdAt: string;
    }
  | {
      type: 'settle';
      targetSessionId: string;
      /** 目标收场轮 id（系统落定必带；`aborted` 没有轮，故意缺省） */
      roundId?: string;
      outcome: DispatchLedgerOutcome;
      settledAt: string;
    };

/**
 * 账本文件的绝对路径（目录推导仍走 `projectDataDir.ts` 单点，本模块不拼 `.memora`）
 *
 * @param projectPath 项目 / 工作区根
 * @returns `<数据目录>/dispatch-ledger.jsonl`
 */
function ledgerFilePath(projectPath: string): string {
  return join(resolveProjectDataDir(projectPath), DISPATCH_LEDGER_FILE_NAME);
}

/**
 * 把一条派活受理记入账本（旁路写，失败只 warn）
 *
 * 调用点必须在「受理成功」之后：被拒 / 参数错 / 目标不存在都不入账，
 * 否则账本会把没派出去的活算成在途。
 *
 * @param projectPath 项目 / 工作区根
 * @param input 受理事实（目标 sid / 标题 / 原文等）
 */
export function recordDispatchLedger(
  projectPath: string,
  input: DispatchLedgerDispatchInput,
): void {
  const createdAt = input.createdAt ?? new Date().toISOString();
  appendLedgerEvent(projectPath, {
    type: 'dispatch',
    id: randomUUID(),
    kind: input.kind,
    callerSessionId: input.callerSessionId,
    targetSessionId: input.targetSessionId,
    targetTitle: input.targetTitle,
    text: clipLedgerText(input.text),
    ...(input.callerRoundId ? { callerRoundId: input.callerRoundId } : {}),
    createdAt,
  });
}

/**
 * 把一次系统落定事件记入账本（核销的唯一入口）
 *
 * 只由 `HostedSessionNotifier` 的落定回程调用；调用方不得拿模型发言、
 * 轮状态字符串或 UI 事件来核销。
 *
 * **无主不写**：同一目标上找不到未结 dispatch 时直接返回——判在写之前，
 * 不靠读侧过滤。零派发的普通对话轮走的就是这条路径，账本零新增。
 *
 * @param projectPath 项目 / 工作区根
 * @param input 落定事实（目标 sid / roundId / 结论）
 * @returns true = 真的追加了一条核销事件；false = 无主 / 参数不全，未写
 */
export function settleDispatchLedger(
  projectPath: string,
  input: DispatchLedgerSettlementInput,
): boolean {
  // roundId 是核销的硬凭据：没有它就不是系统落定事件，宁可不记也不猜
  if (!input.targetSessionId || !input.roundId) return false;
  return appendSettlementIfPending(projectPath, {
    type: 'settle',
    targetSessionId: input.targetSessionId,
    roundId: input.roundId,
    outcome: input.outcome,
    settledAt: input.settledAt ?? new Date().toISOString(),
  });
}

/** 派发中止入参（起流未成立：没有轮、没有 roundId，只有目标） */
export interface DispatchLedgerAbortInput {
  /** 起流失败的目标会话 id */
  targetSessionId: string;
  /** 中止时刻（缺省 = 现在；测试可注入固定值） */
  settledAt?: string;
}

/**
 * 给一笔「已记账但起流失败」的派发补终态（`outcome: 'aborted'`）
 *
 * 为什么必须做：`create` 的记账已前移到 `startFlow` 之前；若起流抛错，
 * 这笔 pending 永远不会收到轮落定，一小时后会被查询侧误判成 `orphaned`——
 * 那等于把「失败被标悬空」，同样是撒谎。写一条终态让它有结局。
 *
 * 同样受「无主不写」约束：没有对应 pending 时不追加（例如记账本身也失败了）。
 *
 * @param projectPath 项目 / 工作区根
 * @param input 中止事实（目标 sid）
 * @returns true = 真的追加了一条终态事件；false = 无在途 / 未写
 */
export function abortDispatchLedger(projectPath: string, input: DispatchLedgerAbortInput): boolean {
  if (!input.targetSessionId) return false;
  return appendSettlementIfPending(projectPath, {
    type: 'settle',
    targetSessionId: input.targetSessionId,
    // aborted 没有目标轮，刻意不带 roundId（真落定的硬凭据仍然必须带）
    outcome: 'aborted',
    settledAt: input.settledAt ?? new Date().toISOString(),
  });
}

/**
 * 读取并折叠账本（纯只读：不在读路径写盘）
 *
 * 折叠规则：
 *   - `dispatch` 生成一条 pending 记录；
 *   - `settle` 按**文件行序**匹配同一 target 上**第一条未结**的 dispatch
 *     （行序才是事件顺序；时间戳不参与判定）；
 *   - 匹配不上任何 pending 的 settle 直接忽略——写侧已拦无主事件，这里是旧账容错；
 *   - 剩余 pending 超过超时窗 ⇒ 输出时定性为 orphaned，但不回写盘。
 *
 * @param projectPath 项目 / 工作区根
 * @param query 过滤与超时参数
 * @returns 按受理时间升序的记录副本（调用方可安全修改）
 */
export function readDispatchLedger(
  projectPath: string,
  query: DispatchLedgerQuery = {},
): DispatchLedgerRecord[] {
  const records = foldLedgerEvents(readLedgerEvents(projectPath));

  // 悬空只影响读出的状态，不写回盘：同一份账在不同时刻读到不同结论是预期行为
  const now = query.now ?? Date.now();
  const timeout = query.orphanTimeoutMs ?? DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS;
  for (const record of records) {
    if (record.status !== 'pending') continue;
    const created = Date.parse(record.createdAt);
    // 时间戳损坏时不判悬空：没有可信时刻就没有可信超时结论
    if (!Number.isFinite(created)) continue;
    if (now - created > timeout) record.status = 'orphaned';
  }

  return records
    .filter((record) =>
      query.callerSessionId ? record.callerSessionId === query.callerSessionId : true,
    )
    .filter((record) =>
      query.targetSessionId ? record.targetSessionId === query.targetSessionId : true,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/**
 * 按文件行序折叠事件（读路径与写侧护栏共用同一份配对判据）
 *
 * 为什么不能用时间戳：`createdAt` / `settledAt` 表达「什么时候」，
 * 不表达「先后」；跨进程或高精度并写时会出现 settle 的 `settledAt` 早于
 * dispatch 的 `createdAt`（真机缺陷 2）。JSONL 是 append-only，行顺序就是事件顺序。
 *
 * @param events 文件顺序的事件列表
 * @returns pending / settled 记录（未做悬空推导）
 */
function foldLedgerEvents(events: DispatchLedgerEvent[]): DispatchLedgerRecord[] {
  /** 受理记录（push 顺序 = 文件行序） */
  const records: DispatchLedgerRecord[] = [];
  for (const event of events) {
    if (event.type === 'dispatch') {
      records.push({
        id: event.id,
        kind: event.kind,
        callerSessionId: event.callerSessionId,
        targetSessionId: event.targetSessionId,
        targetTitle: event.targetTitle,
        text: event.text,
        ...(event.callerRoundId ? { callerRoundId: event.callerRoundId } : {}),
        createdAt: event.createdAt,
        status: 'pending',
      });
      continue;
    }
    // 行序即事件顺序：同一 target 上第一条仍在途的 dispatch 就是这次终态的对象
    const target = records.find(
      (record) => record.targetSessionId === event.targetSessionId && record.status === 'pending',
    );
    if (!target) continue;
    target.status = 'settled';
    target.settledAt = event.settledAt;
    target.outcome = event.outcome;
    // aborted 没有轮；真落定才有 roundId
    if (event.roundId) target.roundId = event.roundId;
  }
  return records;
}

/**
 * 写侧护栏：有在途才允许追加终态事件（「判在写之前」）
 *
 * 账本里压根不该出现无主事件：零派发的普通对话轮、账本启用前的老落定、
 * 用户手工轮，都必须在写入前被拦住，而不是留给读侧过滤。
 *
 * @param projectPath 项目 / 工作区根
 * @param settlement 待追加的终态事件
 * @returns true = 已追加；false = 无在途 / 读失败，未写
 */
function appendSettlementIfPending(
  projectPath: string,
  settlement: Extract<DispatchLedgerEvent, { type: 'settle' }>,
): boolean {
  const hasPending = foldLedgerEvents(readLedgerEvents(projectPath)).some(
    (record) =>
      record.targetSessionId === settlement.targetSessionId && record.status === 'pending',
  );
  if (!hasPending) return false;
  appendLedgerEvent(projectPath, settlement);
  return true;
}

/**
 * 追加一条事件（同步单行写；失败只 warn）
 *
 * 同步的理由：一行通常不足 1KB，同步写几乎无感，却能保证同一进程内
 * dispatch 与 settle 的追加顺序；异常在模块内吞掉，绝不冒泡到派发路径。
 *
 * @param projectPath 项目 / 工作区根
 * @param event 待追加事件
 */
function appendLedgerEvent(projectPath: string, event: DispatchLedgerEvent): void {
  try {
    const dir = resolveProjectDataDir(projectPath);
    mkdirSync(dir, { recursive: true });
    appendFileSync(ledgerFilePath(projectPath), `${JSON.stringify(event)}\n`, 'utf8');
  } catch (err) {
    logger.warn({ err, eventType: event.type }, '派活账本写入失败（旁路，不影响派发）');
  }
}

/**
 * 容错读全部事件（文件不存在 / 读失败 / 坏行都不 throw）
 *
 * 坏行跳过并 warn：追加写可能因进程被杀留下半行，单行损坏不应让整本账作废；
 * 整文件读不了（权限 / 目录异常）按空账处理并 warn，调用方仍能拿到 []。
 *
 * @param projectPath 项目 / 工作区根
 * @returns 通过形状校验的事件列表（文件顺序）
 */
function readLedgerEvents(projectPath: string): DispatchLedgerEvent[] {
  const file = ledgerFilePath(projectPath);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    logger.warn({ err, file }, '派活账本读取失败，按空账处理');
    return [];
  }
  const events: DispatchLedgerEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLedgerEvent(parsed)) {
        events.push(parsed);
      } else {
        logger.warn({ file, line: index + 1 }, '派活账本存在形状不符的行，已跳过');
      }
    } catch (err) {
      logger.warn({ err, file, line: index + 1 }, '派活账本存在坏行，已跳过');
    }
  }
  return events;
}

/**
 * 事件形状校验（读侧防线：手改 / 跨版本 / 半截写都不能让折叠逻辑抛错）
 *
 * @param value JSON.parse 的未知结果
 * @returns 是否为可消费的账本事件
 */
function isLedgerEvent(value: unknown): value is DispatchLedgerEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (event.type === 'dispatch') {
    return (
      typeof event.id === 'string' &&
      (event.kind === 'send' || event.kind === 'create') &&
      typeof event.callerSessionId === 'string' &&
      typeof event.targetSessionId === 'string' &&
      typeof event.targetTitle === 'string' &&
      typeof event.text === 'string' &&
      typeof event.createdAt === 'string'
    );
  }
  if (event.type === 'settle') {
    return (
      typeof event.targetSessionId === 'string' &&
      (event.roundId === undefined || typeof event.roundId === 'string') &&
      (event.outcome === 'success' ||
        event.outcome === 'failed' ||
        event.outcome === 'interrupted' ||
        event.outcome === 'aborted') &&
      typeof event.settledAt === 'string' &&
      // 真落定必须带轮；aborted 没有轮，是唯一允许缺省 roundId 的结论
      (event.outcome === 'aborted' || typeof event.roundId === 'string')
    );
  }
  return false;
}

/**
 * 截断入账原文（只留可辨认前缀，不改写内容）
 *
 * @param text 派活原文
 * @returns 不超过上限的原文前缀
 */
function clipLedgerText(text: string): string {
  return text.length > DISPATCH_LEDGER_TEXT_MAX_CHARS
    ? text.slice(0, DISPATCH_LEDGER_TEXT_MAX_CHARS)
    : text;
}
