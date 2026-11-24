/**
 * 派活进度报告（B：用户问进度，能汇报真实的具体落实情况）
 *
 * ## 只解决一个问题
 * 用户在手机远程、看不到界面时，只能开口问「那件事怎么样了」。本模块把账本记录
 * 加工成一段**可以直接转述给用户的话**：已落定成功的活报目标轮正文里的具体内容，
 * 没产出的活才报状态。工具层拿到这段文本后原样端出去即可——
 * **让正确做法同时是最省力的做法**，模型没有动力重组，用户也就有原文可核。
 *
 * ## 事实边界
 * - 账本只装助手派出去的活（`send_to_session` / `create_session`）；用户自己在界面里
 *   开的会话、派的活不在账本里。查不到时必须把这条边界说出来，不能只说「没有」。
 * - 内容只来自**盘上目标轮正文**（`roundId` 由落定事件写入账本），不复制、不改写、
 *   不做二手摘要；账本仍然只记状态与时序，不是第二真相源。
 * - 状态只作兜底：有产出就报产出；没产出才报「还在跑 / 没回音 / 失败」。
 * - 超时未归只报「没回音」，不猜成功、也不冒充失败——不知道就说不知道。
 */
import type { ProcessEvent, Round, ToolDefinition } from '@zooique/memora';
import { DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS, type DispatchLedgerRecord } from './dispatchLedger.js';

/** 派活进度查询的工具名（工具定义与注册分处两地，字面量在这里单点） */
export const GET_DISPATCH_PROGRESS_TOOL_NAME = 'get_dispatch_progress';

/**
 * 工具定义（B：用户问进度时的唯一只读入口）
 *
 * 描述里的三条纪律缺一不可：
 *   1. **使用时机**：只在用户问进展 / 状态 / 那件事怎么样了时调用；不设这道闸，
 *      模型会在每轮结尾例行调用，工具本身变成新的噪音源。
 *   2. **边界**：账本只装助手派出去的活，用户自己开的会话不在里面；查不到也要说清。
 *   3. **正文即返回**：调用后回复的正文就是返回文本本身——前面不加说明、后面不加总结、不包代码块；
 *      「引用完再总结一段」同样违规（真机返工：模型引用完顺手加了 `**总结**`）。
 */
export const GET_DISPATCH_PROGRESS_DEFINITION: ToolDefinition = {
  name: GET_DISPATCH_PROGRESS_TOOL_NAME,
  group: 'orchestrate',
  description:
    '查看你通过 send_to_session / create_session 派出去的活的落实情况，返回一段可直接给用户看的报告。' +
    '使用时机：只在用户问「进展 / 状态 / 那件事怎么样了 / 我让你做的事呢」时调用；' +
    '用户没有问进度就不要调用，也不要在每轮结尾例行调用。' +
    '报告内容来自目标会话盘上原文：已落定成功的活给出正文摘录，没产出的活才报状态；不会编造结果。' +
    '边界：只记录你亲自派出去的活；用户自己在界面里新建的会话、自己派的活不在这个账本里，' +
    '查不到时报告会如实说明这一点。' +
    '拿到返回值后，你回复的正文就是它返回的这段文本本身：' +
    '前面不加任何说明，后面不加任何总结，也不要把它包进代码块。',
  parameters: {
    type: 'object',
    properties: {
      sid: {
        type: 'string',
        description:
          '只查派给这个会话的活（sid 来自 list_work_sessions）；不填 = 查你派出去的全部。',
      },
    },
    required: [],
  },
  readonly: true,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/** 单次最多展开几条（再多就折叠成一句「另有 N 条」，避免刷屏） */
export const DISPATCH_PROGRESS_MAX_ITEMS = 8;

/**
 * 交付摘录的字符上限
 *
 * 手机上一屏能读完的量级：够看出「具体做了什么」，又不至于把整篇正文塞进对话。
 */
export const DISPATCH_PROGRESS_EXCERPT_CHARS = 300;

/** 未落定活附带的派活原文上限（只用来让人认出「这是哪件活」） */
export const DISPATCH_PROGRESS_ASSIGNMENT_CHARS = 60;

/**
 * 「开场白」判据：这些句子是动作预告 / 寒暄，不是工作内容
 *
 * 规则按行首匹配（只看每一段的开头），三类：
 *   1. 应答寒暄：好的 / 收到 / 明白 / 没问题…
 *   2. 动作预告：我先看一下 / 让我查查 / 接下来我…
 *   3. 过程旁白：先确认一下 / 先读文件…
 * 只在**摘录起点**上跳过，进入正文后不再删任何句子——避免误伤正文中段的对话体。
 */
const PREAMBLE_PATTERN =
  /^(好的|好|收到|明白|了解|没问题|可以|行)[，,。.!！:：\s]|^(我先|让我|我来|接下来我|下面我|首先我|先让|先看|先查|先读|先确认|先了解)/;

/** 只说明「接下来要做什么」的元信息句，也属于开场白 */
const META_PATTERN = /^(以下是|下面是|这是|我将|我会|开始|任务[:：])/;

/**
 * 把一行候选压成可比对的正文（去 markdown 前缀与多余空白）
 *
 * @param line 原始行
 * @returns 去掉 `#` / `>` / 列表符后的文本
 */
function normalizeLine(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s*|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 判断一行是否像「有实质内容」的正文
 *
 * @param line 原始行
 * @returns true = 可作为摘录起点
 */
function isSubstantiveLine(line: string): boolean {
  const core = normalizeLine(line);
  if (core.length === 0) return false;
  // 标题行本身就是内容锚点（「# 雨夜」只有两个字，但正是用户要的开头）
  if (/^\s*#{1,6}\s+/.test(line)) return true;
  if (core.length < 12) return false;
  // 分隔线 / 代码围栏 / 纯符号行不是内容
  if (/^[-=_*`~]{3,}$/.test(core)) return false;
  if (PREAMBLE_PATTERN.test(core) || META_PATTERN.test(core)) return false;
  return true;
}

/**
 * 从产出一段正文里取「实质开头」，跳过开场白
 *
 * 判断标准（注释即口径，不另立文档）：
 *   1. 按行找第一个「实质段」：去 markdown 前缀后 ≥12 字，且不是寒暄 / 动作预告 / 元信息；
 *   2. 从该行起保留后文（不再删中段句子），折叠空白成一行；
 *   3. 全部都是开场白时退化为原文开头——宁可给出开场白，也不返回空。
 *
 * @param text 目标轮助手正文
 * @returns 已截断的摘录（无正文时为空串）
 */
export function extractSubstantiveExcerpt(text: string): string {
  const raw = text.trim();
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);
  /** 命中行的原始下标（用于保留它之后的所有内容） */
  let startLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (isSubstantiveLine(lines[index])) {
      startLine = index;
      break;
    }
  }
  const body =
    startLine >= 0
      ? lines
          .slice(startLine)
          .map((line) => normalizeLine(line))
          .filter((line) => line.length > 0)
          .join(' ')
      : raw.replace(/\s+/g, ' ').trim();
  if (body.length <= DISPATCH_PROGRESS_EXCERPT_CHARS) return body;
  return `${body.slice(0, DISPATCH_PROGRESS_EXCERPT_CHARS)}…`;
}

/**
 * 从一轮里取失败原因（只读现成的 error 事件原文，不做二次判定）
 *
 * @param round 目标轮
 * @returns 错误原文；没有 error 事件时 undefined
 */
function readFailureReason(round: Round | undefined): string | undefined {
  const event = (round?.processEvents ?? []).find((item: ProcessEvent) => item.type === 'error');
  if (!event || event.type !== 'error') return undefined;
  const message = event.payload.message?.trim();
  return message ? message.replace(/\s+/g, ' ').slice(0, 160) : undefined;
}

/**
 * 把毫秒折算成中文时长（粗粒度，够人判断「多久了」）
 *
 * @param ms 毫秒
 * @returns 例如「不到 1 分钟」「12 分钟」「3 小时」
 */
function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时`;
}

/** 参数解析结果（错误文案直接作为工具返回值，模型据此重试） */
export type DispatchProgressArgs = { ok: true; sid?: string } | { ok: false; message: string };

/**
 * 解析 `get_dispatch_progress` 参数（封闭：只接受可选的 sid）
 *
 * 为什么要有：ToolDefinition 的参数表不支持 `additionalProperties: false`，
 * 未知键必须在代码里拦，否则模型拼错字段会被静默忽略。
 *
 * @param args 模型传入的原始参数
 * @returns 解析结果
 */
export function parseDispatchProgressArgs(args: unknown): DispatchProgressArgs {
  if (args === undefined || args === null) return { ok: true };
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, message: '参数格式不对：只接受一个可选字段 sid。' };
  }
  const record = args as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'sid');
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `参数不对：不认识的字段 ${unknown.join('、')}；只接受 sid。`,
    };
  }
  if (record.sid === undefined) return { ok: true };
  if (typeof record.sid !== 'string' || record.sid.trim().length === 0) {
    return { ok: false, message: '参数不对：sid 必须是非空字符串。' };
  }
  return { ok: true, sid: record.sid.trim() };
}

/** 报告入参（全部是可注入的纯数据，模块内不读盘、不看时钟） */
export interface DispatchProgressReportInput {
  /** 账本记录（调用方已按 callerSessionId / sid 过滤） */
  records: readonly DispatchLedgerRecord[];
  /** 按 roundId 读目标轮（缺省 = 原文读口不可用，降级为只报状态） */
  readRound?: (roundId: string) => Round | undefined;
  /** 判定「没回音」用的当前时刻（缺省 = Date.now()） */
  now?: number;
  /** 没回音的阈值（缺省 = 账本同一个 60 分钟常量） */
  orphanTimeoutMs?: number;
  /** 最多展开条数（缺省 = {@link DISPATCH_PROGRESS_MAX_ITEMS}） */
  maxItems?: number;
  /** 只看某个会话时，报告抬头用它的标题（缺省 = 全部） */
  scopeTitle?: string;
}

/**
 * 把账本记录加工成一段可直接转述的报告
 *
 * 顺序：未落定（进行中 / 没回音）在前，已落定在后；组内新→旧。
 * 这样用户先看到「还在动的」，再看到「已有结果的」；异常（没回音）不会被埋在末尾。
 *
 * @param input 记录与读口
 * @returns 成品报告（纯文本）
 */
export function buildDispatchProgressReport(input: DispatchProgressReportInput): string {
  const now = input.now ?? Date.now();
  const timeout = input.orphanTimeoutMs ?? DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS;
  const maxItems = input.maxItems ?? DISPATCH_PROGRESS_MAX_ITEMS;

  // 账本边界：用户自己开的会话不在账里；查不到时也必须说清，不能只说「没有」
  const boundary = '我只记得我替你派出去的活；你自己在界面里开的会话、派的活不在我这儿。';
  if (input.records.length === 0) {
    return input.scopeTitle
      ? `没有查到我派给《${input.scopeTitle}》的活。${boundary}`
      : `没有查到我替你派出去的活。${boundary}`;
  }

  /** 组序：在跑 0 / 没回音 1 / 已落定 2 */
  const rank = (record: DispatchLedgerRecord): number =>
    record.status === 'pending' ? 0 : record.status === 'orphaned' ? 1 : 2;
  const sorted = [...input.records].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    // 组内新→旧：已落定看 settledAt，其余看派发时刻
    const aAt = a.settledAt ?? a.createdAt;
    const bAt = b.settledAt ?? b.createdAt;
    return aAt < bAt ? 1 : aAt > bAt ? -1 : 0;
  });
  const shown = sorted.slice(0, maxItems);
  const rest = sorted.length - shown.length;

  const lines = shown.map((record, index) => {
    const title = record.targetTitle || record.targetSessionId;
    const prefix = `${index + 1}. 《${title}》——`;
    if (record.status === 'pending') {
      const age = formatElapsed(now - Date.parse(record.createdAt));
      const assignment =
        record.text.length > DISPATCH_PROGRESS_ASSIGNMENT_CHARS
          ? `${record.text.slice(0, DISPATCH_PROGRESS_ASSIGNMENT_CHARS)}…`
          : record.text;
      return `${prefix}还在跑（已派出 ${age}），还没有产出。派给它的是：${assignment}`;
    }
    if (record.status === 'orphaned') {
      return `${prefix}${formatElapsed(timeout)}没有回音，可能已经中断。建议重派，或打开《${title}》看一眼`;
    }
    if (record.outcome === 'aborted') {
      return `${prefix}没有真正开始（起流失败），可以重派`;
    }
    if (record.outcome === 'success') {
      // 读口 / roundId 缺一不可：取不到原文就如实说取不到，不写成「没有正文」
      if (!input.readRound || !record.roundId) {
        return `${prefix}完成了（取不到对应那一轮的原文）`;
      }
      const round = input.readRound(record.roundId);
      const excerpt = round?.assistantMessage?.content
        ? extractSubstantiveExcerpt(round.assistantMessage.content)
        : '';
      return excerpt ? `${prefix}完成了。内容是：${excerpt}` : `${prefix}完成了，但没有留下正文`;
    }
    const reason = readFailureReason(
      record.roundId && input.readRound ? input.readRound(record.roundId) : undefined,
    );
    return reason ? `${prefix}失败了：${reason}` : `${prefix}失败了（没有留下原因）`;
  });

  const header = input.scopeTitle
    ? `我派给《${input.scopeTitle}》的活：`
    : `我派出去的活，现在是这 ${sorted.length} 件：`;
  const tail = rest > 0 ? `\n（另有 ${rest} 条更早的没展开。）` : '';
  return `${header}\n${lines.join('\n')}${tail}`;
}

/** 每轮内部上下文最多列几条（比成品报告更紧，避免每轮吃太多上下文） */
export const DISPATCH_TURN_CONTEXT_MAX_ITEMS = 6;

/** 内部上下文里每条结果 / 派活摘要的字符上限 */
export const DISPATCH_TURN_CONTEXT_TEXT_CHARS = 60;

/** 每轮内部账本上下文的入参（记录由调用方现读账本得到，本函数不读盘） */
export interface DispatchTurnContextInput {
  /** 调用方派出去的账本记录（readDispatchLedger 原样结果） */
  records: readonly DispatchLedgerRecord[];
  /** 按 roundId 读目标轮（取已完成活的结果开头；缺省则不取正文） */
  readRound?: (roundId: string) => Round | undefined;
  /** 最多列几条（缺省 = {@link DISPATCH_TURN_CONTEXT_MAX_ITEMS}） */
  maxItems?: number;
  /** 快照时刻（HH:MM:SS；只给模型判断新旧，不许转述给用户） */
  stamp?: string;
}

/**
 * 把账本记录压成一段**内部上下文快照**（每轮注入，不进用户界面）
 *
 * 与 `buildDispatchProgressReport` 的分工：那份是给用户看的成品（长、带细节）；
 * 这份是给模型看的背景数据（短、只防"说出账本里没有的记录"）。两者同源
 * （同一批 `readDispatchLedger` 记录），不互为副本。
 *
 * 纪律写在注入文本自身（system 角色）：用户没问进度就不要提，防止模型在无关话题上多嘴。
 *
 * @param input 记录与读口
 * @returns 注入文本；账本为空时 undefined（不给每个会话每轮塞一句"空账本"）
 */
export function buildDispatchLedgerTurnContext(
  input: DispatchTurnContextInput,
): string | undefined {
  if (input.records.length === 0) return undefined;
  const maxItems = input.maxItems ?? DISPATCH_TURN_CONTEXT_MAX_ITEMS;
  const counts = {
    pending: input.records.filter((r) => r.status === 'pending').length,
    orphaned: input.records.filter((r) => r.status === 'orphaned').length,
    success: input.records.filter((r) => r.status === 'settled' && r.outcome === 'success').length,
    failed: input.records.filter(
      (r) => r.status === 'settled' && (r.outcome === 'failed' || r.outcome === 'aborted'),
    ).length,
  };
  // 新→旧：已落定看 settledAt，其余看派发时刻
  const sorted = [...input.records].sort((a, b) => {
    const aAt = a.settledAt ?? a.createdAt;
    const bAt = b.settledAt ?? b.createdAt;
    return aAt < bAt ? 1 : aAt > bAt ? -1 : 0;
  });
  const shown = sorted.slice(0, maxItems);
  const rest = sorted.length - shown.length;
  const lines = shown.map((record) => {
    const title = record.targetTitle || record.targetSessionId;
    // 对账键与落定通知同源：通知写 `sid=…`（有收场轮时再带 `round=…`），这里就用
    // 同一组标识，宝才能把「这一行」和「那条落定通知」对上号。不写账本内部 id——
    // 那个标识只在本进程账本里存在，通知侧从不出场，带了也 join 不上。
    const roundKey = record.roundId ? `, round=${record.roundId}` : '';
    const head = `- 《${title}》(sid=${record.targetSessionId}${roundKey}) · `;
    if (record.status === 'pending') {
      return `${head}进行中 · 派的是：${clipForContext(record.text, DISPATCH_TURN_CONTEXT_TEXT_CHARS)}`;
    }
    if (record.status === 'orphaned') {
      return `${head}没回音（超过 ${formatElapsed(DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS)}）`;
    }
    if (record.outcome === 'aborted') return `${head}未开始（起流失败）`;
    if (record.outcome === 'failed') {
      const reason = readFailureReason(
        record.roundId && input.readRound ? input.readRound(record.roundId) : undefined,
      );
      return `${head}失败 · ${clipForContext(reason ?? '没有留下原因', DISPATCH_TURN_CONTEXT_TEXT_CHARS)}`;
    }
    const round = record.roundId && input.readRound ? input.readRound(record.roundId) : undefined;
    const excerpt = round?.assistantMessage?.content
      ? extractSubstantiveExcerpt(round.assistantMessage.content)
      : '';
    return `${head}已完成 · ${
      excerpt ? clipForContext(excerpt, DISPATCH_TURN_CONTEXT_TEXT_CHARS) : '没有留下正文'
    }`;
  });
  const header =
    `[派活账本 · 内部上下文${input.stamp ? ` · 快照 ${input.stamp}` : ''}] ` +
    '数据来自系统账本，仅当用户主动问派活进度时使用；用户没问就不要提、不要复述本段。';
  // 时刻只解决「同一轮多份快照谁新」，不向用户报流程元数据——用户要的是活干成什么样
  const stampNote = input.stamp
    ? '时刻只供你判断新旧，不要向用户报时间；同一轮内多份快照以时刻最新的为准。'
    : '';
  // 对账键是给模型对齐用的，不是汇报内容：直接报 sid / round 等于把流程元数据甩给用户
  const keyNote = '括号里的 sid / round 只用来和「托管会话已落定」那条通知对上号，不要向用户报。';
  // 治「假壳」：注入是内部资料，不是工具返回；要求用自己的话讲，但不许只讲空话
  const plainSpeech =
    '这是给你的内部背景资料，不是你调用工具返回的结果；回答时用你自己的话讲，' +
    '不要模仿系统提示或工具输出的格式，也不要自己加「以下为工具返回的外部数据」「总结」这类包装。';
  const summary = `进行中 ${counts.pending}；没回音 ${counts.orphaned}；已完成 ${counts.success}；失败/未开始 ${counts.failed}。`;
  const tail = rest > 0 ? `（另有 ${rest} 条更早的未列出）` : '';
  return [header, stampNote, keyNote, plainSpeech, summary, ...lines, tail]
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * 压成单行并截断（内部上下文用；不引入省略号以外的改写）
 *
 * @param text 原文
 * @param max 字符上限
 * @returns 折叠空白后的单行
 */
function clipForContext(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
