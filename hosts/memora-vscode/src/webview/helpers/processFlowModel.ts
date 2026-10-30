/**
 * 过程流纯模型层（CHATVIEW-SLIM-2 第 5 刀·零状态批，自 chatView.ts 外置）
 *
 * 域职责：把过程事件（`ProcessEvent[]`）推导为渲染所需的中间结构——工具批、思考分桶、
 * 计划项状态、工具行状态、搜索/记忆证据解析、终态裁决。
 *
 * **边界（本模块存在的前提）**：全部为纯函数，不触达 DOM、不读写 chatView 状态、无定时器。
 * 一旦某函数需要 `document` 或任何外部状态，它就不属于这里（→ `scripts/processFlowCells`）。
 *
 * 纯搬迁，零行为变化：函数体与注释自 `chatView.ts` 原样迁出（2026-10-29，方案见
 * `tasks/方案-CHATVIEW-SLIM-2-过程流单元格外置-20261029.md`）。
 *
 * @module processFlowModel
 */
import type { ProcessEvent } from '@zooique/memora';
import type { RoundView } from '../../shared/protocol.js';
import { friendlyErrorMessage } from '../../shared/errorText.js';
import { argStr, isPlanItemBoundaryEvent, parseToolArgs } from './processEventText.js';

/**
 * 工具批（toolBatch）批内条目：一次工具调用 = tool_start + 按 toolCallId 配对的 tool_result
 * （结果未回 = 进行中条目，批内占位不拆段）。
 */
export interface ToolBatchEntry {
  /** 工具开始事件（段内容主体；行渲染的锚） */
  start: Extract<ProcessEvent, { type: 'tool_start' }>;
  /** 已回的结果（缺省 = 进行中；失败/被拒同样留段内，口径②） */
  result?: Extract<ProcessEvent, { type: 'tool_result' }>;
}

/**
 * 工具批（toolBatch）：过程条目流中前后相邻、中间无打断物的最大工具序列。
 *
 * segId = 段内首个 tool_start 的 seq——批容器唯一 DOM key（`data-tool-batch`），
 * 稳定可复现、不新造标识（口径③：批 key 用段 id，不用 toolCallId）。
 */
export interface ToolBatch {
  /** 段 id（= 段内首个 tool_start 的 seq） */
  segId: number;
  /** 段内首个 tool_start 的 ts（批块插入定位时间键，与逐条工具行同锚） */
  anchorTs: string;
  /** 段内工具按 tool_start seq 序 */
  entries: ToolBatchEntry[];
}

/**
 * web_search 裁决证据（内核 Round.evidence 的 web_search_result 变体）——证据轨的 UI 消费面。
 *
 * 定位：过程轨（processEvents）只到「工具×N（网络搜索 1）」粒度，展开后是 args(query)
 * + 结果摘要；本证据补的是**归因三件套**——实际服务端点（降级分型）、结果条数、
 * 命中标题（「搜到了什么」的最小面）。结果摘要已含搜索来源与标题文本时的重叠属**有意冗余**
 * （结构化字段比正文摘要更可靠，摘要被截断也不丢条数）。
 */
export type WebSearchEvidence = Extract<
  NonNullable<RoundView['evidence']>[number],
  { type: 'web_search_result' }
>;

/** 单条命中项（记忆 id → 展示面）：id 为 Map 键（同调用内去重）兼反馈寻址键（data-memory-id） */
export type MemoryHitEntry = { name: string; source: string; contentPreview?: string };

/**
 * 从 processEvents 提取任务项状态 map（取**最后一条** plan_snapshot——turn 内多次
 * 挂起/恢复场景以收尾终态为准）。双保险（真机反馈 2026-10-01）：
 * ① 最后快照**之后**发生的 boundary（数组序 = 事件发生序）覆盖为 active——覆盖
 *    「快照缺项/快照滞后于边界」的窗口（结构化信号，非文本推断）；
 * ② 无任何快照：最后一条 boundary 对应项置 active，其余项无图标——boundary 语义 =
 *    内核宣告「任务项开始执行」，最后宣告开始且未见完成宣告的项亮「进行中」是数据
 *    支持的诚实表达（中断轮保留现场；存量轮不再全程裸奔），其余项完成与否未知，
 *    维持无图标（不伪造 done）。
 */
export function planItemStatesFromEvents(events: ProcessEvent[]): Map<string, string> {
  const snaps = events.filter(
    (e): e is Extract<ProcessEvent, { type: 'plan_snapshot' }> => e.type === 'plan_snapshot',
  );
  const last = snaps[snaps.length - 1];
  const states = new Map(last ? last.payload.items.map((i) => [i.planItemId, i.status]) : []);
  const bounds = events.filter(isPlanItemBoundaryEvent);
  if (last) {
    const lastIdx = events.lastIndexOf(last);
    for (const b of bounds) {
      if (events.indexOf(b) > lastIdx && b.payload.planItemId) {
        states.set(b.payload.planItemId, 'active');
      }
    }
  } else {
    const lastBound = bounds[bounds.length - 1];
    if (lastBound?.payload.planItemId) states.set(lastBound.payload.planItemId, 'active');
  }
  return states;
}

/** 思考折叠块标题：stepIndex 已知 = 标注第几步（一个 step 一个折叠块）；无归属 = 裸「思考」 */
export function thoughtLabel(stepIndex?: number): string {
  return stepIndex !== undefined ? `思考 · 第 ${stepIndex} 步` : '思考';
}

/**
 * 思考碎片按「所属 step」分桶（SSOT；finalize 与流式两类上下文共用）。
 *
 * 语义：**一个 step 一个思考折叠块**（step = 一次 LLM 调用 + 可选工具执行）。分桶键 =
 * 该碎片自带的 stepIndex（内核 loop 打标、随事件落盘，运行时与重放同源）。同一桶内碎片
 * 保序**原样连续**拼接（连贯）；不同 step 各自独立折叠（不跨步混批）。含 anchorSeq
 * （桶内最早碎片的 seq，做插入锚点）。stepIndex 缺省（旧数据 / 非迭代路径产出）回落
 * 'root' 整轮单桶——不猜测推断归属。有任务表时桶仍按 anchor 归入任务项分组（planItemContainerFor）。
 */
export function groupThoughtBuckets(events: ProcessEvent[]): {
  key: string;
  stepIndex?: number;
  anchorSeq: number;
  anchorTs: string;
  items: { seq: number; ts: string; content: string }[];
}[] {
  const thoughts = events
    .filter((e): e is Extract<ProcessEvent, { type: 'thought' }> => e.type === 'thought')
    .sort((a, b) => a.seq - b.seq);
  const buckets = new Map<
    string,
    {
      key: string;
      stepIndex?: number;
      anchorSeq: number;
      anchorTs: string;
      items: { seq: number; ts: string; content: string }[];
    }
  >();
  for (const t of thoughts) {
    const stepIndex = t.payload.stepIndex;
    const key = stepIndex !== undefined ? String(stepIndex) : 'root';
    const bucket = buckets.get(key) ?? {
      key,
      stepIndex,
      anchorSeq: t.seq,
      anchorTs: t.ts,
      items: [],
    };
    bucket.items.push({ seq: t.seq, ts: t.ts, content: t.payload.content });
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.anchorSeq - b.anchorSeq);
}

/**
 * 工具调用行（tool_start 配对 tool_result）——折叠行：summary = 名称(状态) 常显，
 * args + result 摘要折叠进 body，避免工具详情抢占报告主体。失败/进行中默认展开（错误直显）。
 * 宿主容器（扁平化）：直接平铺在 round-block__details 顶层（insertPlanItemInOrder 按 seq 插入）。
 */
/**
 * TS-12b：aborted 中断语义 → 展示文案（单一映射，与 error category 词典同构）。
 * 'user' → 用户停止；'interrupted' → 中断；
 * 无 stopReason（旧数据/直接构造） → 回退 reason 原文（调试可追溯，不丢原始细节）。
 * 注：'connection' 不在此映射——连接中断统一由 error chunk category 承载（TS-10b chatPanel 映射），
 * aborted 永不带此语义，假分支删除防文案双源漂移。
 */
export function stopReasonLabel(payload: { reason: string; stopReason?: string }): string {
  const map: Record<string, string> = {
    user: '用户停止了对话',
    timeout: '对话处理超时，请稍后重试',
    interrupted: '对话已中断',
  };
  return (payload.stopReason && map[payload.stopReason]) || payload.reason;
}

/**
 * TS-11a：定位「进行中工具」——tool_start 已到、tool_result 未达的最新一个（工具并行执行时以
 * 最新未完成者作为「当前正在做什么」的展示主体）。无进行中工具返回 null（相位行回退 thinking）。
 */
export function findRunningTool(
  events: ProcessEvent[],
): Extract<ProcessEvent, { type: 'tool_start' }> | null {
  const starts = events.filter(
    (e): e is Extract<ProcessEvent, { type: 'tool_start' }> => e.type === 'tool_start',
  );
  // 从最新往前找第一个没有配对的 tool_result 的 tool_start
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i]!;
    const matched = events.some(
      (e) => e.type === 'tool_result' && e.payload.toolCallId === start.payload.toolCallId,
    );
    if (!matched) return start;
  }
  return null;
}

/**
 * 工具行状态（单一推导，renderToolRow/updateToolRowState 共用）：
 * 无结果=进行中（TS-11b 默认展开 + running 标记，让正在执行的工具可见）；
 * 策略拦截（blocked）=已拦截且默认展开（拒绝文案应直接可见）；
 * 其余按 ok 成功/失败，失败默认展开（错误可见优先于整洁）。
 */
export function toolRowStatus(result: Extract<ProcessEvent, { type: 'tool_result' }> | undefined): {
  label: string;
  open: boolean;
  running: boolean;
} {
  if (!result) return { label: '进行中', open: true, running: true };
  if (result.payload.blocked === true) return { label: '已拦截', open: true, running: false };
  return result.payload.ok
    ? { label: '成功', open: false, running: false }
    : { label: '失败', open: true, running: false };
}

/**
 * 构造「web_search 工具行 → 裁决证据」解析器（每轮重放渲染建一次）。
 *
 * 配对策略（两级，SSOT = 工具调用唯一身份优先）：
 * - **主配（toolCallId）**：新证据 payload 带 `toolCallId`（= tool_start.payload.toolCallId），
 *   按唯一 ID 直配——同 query 多次搜索、被护栏硬拦的搜索（不产证据）都不再张冠李戴。
 * - **回退（query 游标）**：旧持久化轮次的证据无 `toolCallId`，退回旧的「按 query 分组 + 行序消费」
 *   启发式（保不带伤——历史轮证据照常渲染）。两级互不串味：某轮要么全带 ID 走主配、
 *   要么全无 ID 走回退，不存在同轮混用的迁移缝。
 * 证据面只留净化标题（无 URL 锚点），故误配不进一步放大——这也正是主配要消灭的不确定性。
 *
 * @param evidence 本轮 RoundView.evidence（可为空 → 解析器恒返回 undefined）
 * @returns 解析器：传入 tool_start，命中则回该 search 证据，否则 undefined
 */
export function buildSearchEvidenceResolver(
  evidence: RoundView['evidence'],
): (start: Extract<ProcessEvent, { type: 'tool_start' }>) => WebSearchEvidence | undefined {
  // 主配：toolCallId → 证据（唯一身份，一对一；仅收带 ID 的新证据）
  const byToolCallId = new Map<string, WebSearchEvidence>();
  // 回退：按 query 分组（仅收无 ID 的旧证据，其余证据变体与搜索行无关）
  const byQuery = new Map<string, WebSearchEvidence[]>();
  for (const ev of evidence ?? []) {
    if (ev.type !== 'web_search_result') continue;
    if (ev.payload.toolCallId) {
      byToolCallId.set(ev.payload.toolCallId, ev);
      continue;
    }
    const bucket = byQuery.get(ev.payload.query);
    if (bucket) bucket.push(ev);
    else byQuery.set(ev.payload.query, [ev]);
  }
  // 每 query 独立的消费游标（行序 = 证据追加序，二者同为轮内时间序）——仅回退路径用
  const cursor = new Map<string, number>();
  return (start) => {
    if (start.payload.name !== 'web_search') return undefined;
    // 主配：按工具调用唯一 ID 直取（新证据路径，命中即返回，无顺序敏感）
    const byId = byToolCallId.get(start.payload.toolCallId);
    if (byId) return byId;
    // 回退：旧证据按 query 文本 + 行序消费（被硬拦行无证据时可能顺延，属历史数据的已知边界）
    const query = argStr(parseToolArgs(start.payload.args), 'query');
    if (!query) return undefined;
    const bucket = byQuery.get(query);
    if (!bucket) return undefined;
    const idx = cursor.get(query) ?? 0;
    cursor.set(query, idx + 1);
    return bucket[idx];
  };
}

/**
 * 记忆命中证据解析器（MEM-EVENT-3）：`Round.evidence` 的 `memory_hits` 变体 → toolCallId → 命中表。
 *
 * 为什么需要它：`memoryRecalled` 是**实时专属**事件（不进 processEvents），重放历史轮时
 * 宿主手上只有 `tool_result.summary` 里那 100 字截断副本——真机「重新渲染后无法完成查看」
 * 就是这个现场（截到 `(a` 半截）。证据轨给重放补上可重建的结构化明细。
 *
 * 合并口径：同一 toolCallId 的多条证据按到达序合并，**同 id 以首次为准**（与实时侧
 * `currentMemoryHitsByCall` 的 Map 去重口径一致，避免两套去重规则）。
 * 无配对键的证据跳过：`hits` 与 `toolCallId` 是**同一批**引入的字段，任何发行版都不可能
 * 只含其中之一 ⇒ 该形态不可达，不为它另造一套轮次级重放渲染。
 */
export function buildMemoryHitsEvidenceResolver(
  evidence: RoundView['evidence'],
): Map<string, Map<string, MemoryHitEntry>> {
  const byCall = new Map<string, Map<string, MemoryHitEntry>>();
  for (const ev of evidence ?? []) {
    if (ev.type !== 'memory_hits') continue;
    const callId = ev.payload.toolCallId;
    if (!callId) continue;
    const bucket = byCall.get(callId) ?? new Map<string, MemoryHitEntry>();
    for (const h of ev.payload.hits) {
      if (!bucket.has(h.id))
        bucket.set(h.id, { name: h.name, source: h.source, contentPreview: h.contentPreview });
    }
    byCall.set(callId, bucket);
  }
  return byCall;
}

/**
 * 中断轮终态单点分类（2026-10-13）：kind 写宿主 data-terminus、reason 给停止行文案——
 * 一次计算两处消费，杜绝「标签与停止行各判一遍、不一致且无测试会红」的双写伤。
 *
 * 语义映射同旧的 §已停止：error（失败：超时/连接中断）优先，其次 aborted（中断：
 * 用户停止/锁超时），皆无则 generic 兜底（旧数据）。error 优先是保守排序——二者本应
 * 互斥（failed 路径 signal 未 abort），此序仅防异常组合。
 *
 * @returns kind='用户中断' → 用户主动停止（停止行退役，底栏标签承载）；
 *          kind='异常中断' → error/锁超时等意外（原因句留折叠块外当现场）；
 *          kind=null      → 事件不足不猜态（诚实投影：无载体不撒状态，停止行照旧兜底）
 */
export function decideTerminus(events: ProcessEvent[]): {
  kind: '用户中断' | '异常中断' | null;
  reason: string;
} {
  const errorEv = events.find(
    (e): e is Extract<ProcessEvent, { type: 'error' }> => e.type === 'error',
  );
  if (errorEv) {
    return {
      kind: '异常中断',
      reason: friendlyErrorMessage(errorEv.payload.category, errorEv.payload.message),
    };
  }
  const aborted = events.find(
    (e): e is Extract<ProcessEvent, { type: 'aborted' }> => e.type === 'aborted',
  );
  if (aborted) {
    // 判据字段 = stopReason（reason 是自由文本描述，如 'User cancelled the conversation'）
    return aborted.payload.stopReason === 'user'
      ? { kind: '用户中断', reason: stopReasonLabel(aborted.payload) }
      : { kind: '异常中断', reason: stopReasonLabel(aborted.payload) };
  }
  // 兜底案语义键放法定口袋（stopReason），字典查得中文「对话已中断」——TERM-REASON-1 收口：
  // 此前语义键塞 reason（自由文本口袋）⇒ 查表落空回落原文，用户可读面直出裸英文 'interrupted'。
  // reason 仍填同键：字典若删该条，回落的是可追溯键而非编造文案。
  return {
    kind: null,
    reason: stopReasonLabel({ stopReason: 'interrupted', reason: 'interrupted' }),
  };
}

// 中断轮整链复制源（过程叙述按序拼接）的实现已上移到 `shared/narrateText`——它与宿主侧
// 崩溃打捞的派生逻辑是**同一个事实**（「这一轮的叙述拼起来是什么」），分两处写必然让
// 「复制出来的文本」与「重启后恢复出来的文本」悄悄不一致。此名不再保留别名，消费方直取单点。

// SLIM-3 第 2 刀追加（2026-10-29）：工具批切段判据（三渲染上下文共用，自 chatView 外置）
/**
 * 批间打断物白名单（**唯一声明处**；他处引用本名，不重述集合）。
 *
 * 资格 = 「自身在过程条目流中渲染成一条可见内容」——只有这样才能充当两个相邻工具之间的视觉断面。
 * - `narrate`：工具轮叙述行（宿主渲染「AI 说什么：」后接工具块）；
 * - `text_self_review`：自审查**输出**（**非**正文——主回答正文走内容轨 `chunk`，落盘没有对应过程事件，
 *   结构上不可能出现在工具之间）。自审查只在工具循环后做一次终审，故它**常态**居工具之后；
 *   仅「审查轮交付后排队插话续跑、续跑再调工具」这一路径可让它落在两条工具之间 → **可达，保留**。
 * - `plan_item_boundary`：任务项折叠分组边界（分组容器本身即断面）。
 * 其余类型（thinking / memory_added / self_review / tool_start / tool_result / metrics / aborted / meta）
 * 都不渲染成可断面 → 不断段。
 */
export const BATCH_SPLITTER_TYPES: ReadonlySet<ProcessEvent['type']> = new Set([
  'narrate',
  'text_self_review',
  'plan_item_boundary',
]);

/**
 * 工具批切段（SSOT；三渲染上下文共用：运行时流式 / finalize 全量重建 / pending 行升级）
 *
 * 判据（docs/architecture/tool-batch-splitting.md §4.1；扩展 方案-工具批折叠合并-20260925.md §3.1）：
 *   · 打断物（一切断段）：`BATCH_SPLITTER_TYPES` 三成员（narrate / text_self_review / plan_item_boundary）。
 *   · **步切换（新增）**：`thought` 归属新 step（其 `stepIndex` ≠ 当前批所属 step）→ 断段。
 *     语义 = 「可见分隔物」——思考块换步即视觉断面，工具随之按步分块。**同 step 的思考碎片**
 *     （同 `stepIndex`）**不断段**（step 内伴随物）；两侧任一 `stepIndex` 缺省（旧数据）→ 回落相邻性。
 *     无思考分隔的跨 step 工具序列（模型不产 reasoning）→ 维持相邻合并（无可见断面即不切）。
 *   · `tool_start` / `tool_result` 为段内容（结果按 toolCallId 配对归属其 tool_start）。
 *   · **外部可见条目（新增）**：`boundaryTs` 非空时，相邻两条工具的 ts 之间若夹着外部可见条目
 *     （问答卡，见 `visibleInputTs`）→ 断段。判据 = 「桶号」（小于该工具 ts 的边界数）变化，
 *     与落位同用 ts 键——呈现在哪、断面就在哪。
 * 其余条目（thinking / memory_added 等）不在打断物清单内 → 不断段。
 *
 * @param events     当前轮全部过程事件（流式与重放同源输入）
 * @param boundaryTs 外部可见条目（问答卡）的 ts 集。**必传、不设默认值**：空数组的语义 = 「无外部
 *   条目即无断面」，而那正是缺陷 BATCH-SPLIT-1 的形态——设默认值等于让漏传者静默回落缺陷行为
 * @returns 批数组（按段内首个 tool_start 的 seq 升序；空流返回空数组）
 */
export function groupToolBatches(
  events: ProcessEvent[],
  boundaryTs: readonly string[],
): ToolBatch[] {
  // 全序按 seq 稳定排序（宿主可见 ProcessEvent 全序，方案 §二约束：判据只读 seq/类型/toolCallId）
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  // 桶号 = 小于该 ts 的边界条目数：相邻工具桶号不同 ⇒ 二者之间夹着问答卡 ⇒ 断段
  const bucketOf = (ts: string): number => {
    let n = 0;
    for (const b of boundaryTs) if (b < ts) n += 1;
    return n;
  };
  // toolCallId → 结果（段内容配对表；先建表后分组，结果可晚于打断物到达仍归属其 start）
  const results = new Map<string, Extract<ProcessEvent, { type: 'tool_result' }>>();
  for (const e of ordered) {
    if (e.type === 'tool_result') results.set(e.payload.toolCallId, e);
  }
  const batches: ToolBatch[] = [];
  // 当前开放中的段（null = 下一个 tool_start 开新段）
  let current: ToolBatch | null = null;
  // 当前批所属 step（= 开批那条 tool_start 的 stepIndex；undefined = 旧数据无归属 → 不参与步切换判据）
  let currentStep: number | undefined;
  // 当前批的边界桶号（开批时定；与新工具比对，变化即断段）
  let currentBucket = 0;
  for (const e of ordered) {
    if (e.type === 'tool_start') {
      const bucket = bucketOf(e.ts);
      // 外部可见条目断面：跨过问答卡 → 关批（由下方开新批）
      if (current && bucket !== currentBucket) current = null;
      if (!current) {
        current = { segId: e.seq, anchorTs: e.ts, entries: [] };
        currentStep = e.payload.stepIndex;
        currentBucket = bucket;
        batches.push(current);
      }
      current.entries.push({ start: e, result: results.get(e.payload.toolCallId) });
    } else if (BATCH_SPLITTER_TYPES.has(e.type)) {
      // 打断物（白名单 = BATCH_SPLITTER_TYPES 唯一声明）：断段；其余条目穿插不断段
      current = null;
    } else if (e.type === 'thought') {
      // 步切换断段：思考归属新 step（两侧 stepIndex 均已知且不同）→ 可见分隔物出现，断段
      const s = e.payload.stepIndex;
      if (current && currentStep !== undefined && s !== undefined && s !== currentStep) {
        current = null;
      }
    }
  }
  return batches;
}
