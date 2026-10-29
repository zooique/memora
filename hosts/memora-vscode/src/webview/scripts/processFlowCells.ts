/**
 * 过程流单元格工厂（CHATVIEW-SLIM-2 第 5 刀·零状态批，自 chatView.ts 外置）
 *
 * 域职责：把过程事件构造成轮块内的**单元格 DOM**——分区、叙述行、思考块、计划项分组、
 * 工具行、工具批块、搜索证据块、中断行。
 *
 * **边界（与 `activityDrawerView` 同一形态宪法）**：本域不持有任何 chatView 状态，
 * 不注册事件监听、不启动定时器 ⇒ 无 `dispose`。需要 `document` 的构造函数收在工厂内、
 * 经 deps 注入（禁读全局 document，保证 jsdom 下可测）；不需要 `document` 的排序/查询工具
 * 作为模块级函数导出。
 *
 * **分界**：状态归 chatView（`flowEl` / `roundBlockEl` / `currentEvents` 等仍在本文件之外），
 * 本模块只吃「传进来的元素 + 事件」，不反向读写任何状态 ⇒ 与 HOST-SPLIT-1 的「域外置」
 * 不同，是「单元格外置」，故判据不依赖状态所有权。
 *
 * @module processFlowCells
 */
import type { ProcessEvent } from '@zooique/memora';
import {
  isPlanItemBoundaryEvent,
  toolActionLabel,
  toolSummaryText,
} from '../helpers/processEventText.js';
import type { MemoryHitEntry, ToolBatch, WebSearchEvidence } from '../helpers/processFlowModel.js';
import { decideTerminus, toolRowStatus } from '../helpers/processFlowModel.js';
import { setTerminus } from '../helpers/statusAttrs.js';
import { getIconSvg } from './icons.js';
import type { MemoryHitsBlock } from './memoryHitsBlock.js';

/** 过程流单元格依赖：文档对象 + 记忆命中块（工具行内命中明细的唯一实现） */
export interface ProcessFlowCellsDeps {
  /** webview 文档对象（单元格构造唯一 DOM 入口；禁在模块内读全局 document） */
  document: Document;
  /** 记忆命中块构造器（`renderToolRow` 内命中明细复用同一实现） */
  memoryHits: MemoryHitsBlock;
}

/** 单元格工厂窄接口：chatView 仅经此驱动，域内辅助函数零暴露 */
export interface ProcessFlowCells {
  /** 分区（标题 + 列表）取建 */
  getOrCreateSection(details: HTMLElement, title: string): HTMLElement;
  /** 分区全量重建（清列表 + 更新标题计数） */
  sectionOf(details: HTMLElement, title: string): { titleEl: HTMLElement; listEl: HTMLElement };
  /** 任务项分组取建（含有序插入） */
  getOrCreatePlanItemGroup(
    root: HTMLElement,
    bound: Extract<ProcessEvent, { type: 'plan_item_boundary' }>,
    bounds: Extract<ProcessEvent, { type: 'plan_item_boundary' }>[],
  ): HTMLElement;
  /** 按 ts/seq 定位任务项容器 */
  planItemContainerFor(
    root: HTMLElement,
    events: ProcessEvent[],
    ts: string,
    seq?: number,
  ): { host: HTMLElement; bounds: Extract<ProcessEvent, { type: 'plan_item_boundary' }>[] };
  /** 叙述行 */
  createNarrateRow(ev: Extract<ProcessEvent, { type: 'narrate' }>): HTMLElement;
  /** 聚合思考块 */
  createAggregatedThought(
    contents: readonly string[],
    openByDefault?: boolean,
    ts?: string,
    seq?: number,
    label?: string,
  ): HTMLDetailsElement;
  /** 待定工具行升级为运行中 */
  upgradePendingToolRow(
    row: HTMLDetailsElement,
    start: Extract<ProcessEvent, { type: 'tool_start' }>,
  ): void;
  /** 计划项状态施加 */
  applyPlanItemStates(root: HTMLElement, states: Map<string, string>): void;
  /** 工具批标题 / 失败统计刷新 */
  refreshToolBatchSummary(block: HTMLDetailsElement, batch: ToolBatch): void;
  /** 工具批块 */
  createToolBatchBlock(batch: ToolBatch, open: boolean): HTMLDetailsElement;
  /** 搜索裁决证据块 */
  renderSearchEvidenceBlock(ev: WebSearchEvidence): HTMLElement;
  /** 工具行 */
  renderToolRow(
    start: Extract<ProcessEvent, { type: 'tool_start' }>,
    events: ProcessEvent[],
    resolveSearchEvidence?: (
      start: Extract<ProcessEvent, { type: 'tool_start' }>,
    ) => WebSearchEvidence | undefined,
    resolveMemoryHits?: (toolCallId: string) => Map<string, MemoryHitEntry> | undefined,
  ): HTMLDetailsElement;
}

/** 任务项级容器按边界的 (ts, seq) 插入 details 顶层（与任务项/时间轴插入域的排序键同源，防乱序） */
export function insertPlanItemGroupInOrder(
  root: HTMLElement,
  grp: HTMLElement,
  boundTs: string,
  boundSeq: number,
): void {
  // 候选限定为 root 的**直接子节点**：与 insertPlanItemInOrder 同构隐患，
  // 对称补齐——不然任意深度后代会让 insertBefore(grp, next) 的 next 不是 root 的直接子节点，
  // 按 DOM 规范抛 NotFoundError（同类失败模式的另一半）。当前任务项分组恒为容器直接子节点
  // （静态上 root 只会是 flow / details，绝不会是任务项分组自身），故属防御性、零行为变更。
  const existingGrps = Array.from(
    root.querySelectorAll<HTMLElement>(':scope > .round-block__plan-item'),
  );
  const next = existingGrps.find((g) => {
    // 排序键与 bounds 排序 / 任务项编号 / insertPlanItemInOrder 同源：ts 优先、同 ts 回落 seq。
    // 组的视觉位置与「任务项 N」编号出自同一把键，否则 ts 与 seq 逆序的样本（时钟回拨 /
    // 历史补写）会让两者分家——屏幕上「任务项 2」排到「任务项 1」之前。
    const t = g.dataset.ts ?? '';
    if (t !== boundTs) return t > boundTs;
    return Number(g.dataset.seq ?? Infinity) > boundSeq;
  });
  if (next) {
    root.insertBefore(grp, next);
  } else {
    root.appendChild(grp);
  }
  grp.dataset.seq = String(boundSeq);
}

/**
 * 过程条目按统一时间键（data-ts）插入容器顶层。
 *
 * 形态甲：排序键统一为 **ts（时间键）**——processEvents 行（narrate/tool/thought）
 * 与 interactiveInputs 条目（QA，无 seq）共用同一时间序，用户输入自然归位到对应任务项间隙。
 * 行创建点统一挂 `data-ts`（ISO 字符串，localeCompare 同值比较即时间序）；无 data-ts 的
 * 异常节点（如 pending 工具行）视为最大键（恒末尾，与 appendChild 流尾语义一致）。
 *
 * 候选限定为 details 的**直接子节点**：存在 plan_item_boundary 时同款元素
 * 嵌套在 .round-block__plan-item 分组内部，任意深度后代会让 insertBefore(el, next) 的 next 不是
 * details 的直接子节点 → 按 DOM 规范抛 NotFoundError（曾静默打断 finalizeRound 收口）。
 * 候选类型 = narrate/tool/thought/工具批块 + 任务项组 + 运行时输入条目（input，形态甲）。
 *
 * **任务项组必须入候选（勿删）**：组与行同处一条 (ts, seq) 序——组挂边界事件的 ts/seq，
 * 行挂自身事件键。若把组排除在外，则「组 vs 行」永不比较，行只与行比、组只与组比；
 * 一旦根层没有同层行可锚（该轮工具已全被任务项边界收进组内），行会走 appendChild 落到
 * **所有组之后**，表现为「组外的思考块沉底」。
 */
export function insertPlanItemInOrder(details: HTMLElement, el: HTMLElement, ts: string): void {
  const existing = Array.from(
    details.querySelectorAll<HTMLElement>(
      ':scope > .process-flow__narrate, :scope > .round-block__narrate, :scope > .round-block__tool, :scope > .process-flow__tool, :scope > .round-block__tool-batch, :scope > .round-block__thought, :scope > .process-flow__thought, :scope > .round-block__input, :scope > .process-flow__input, :scope > .round-block__plan-item',
    ),
  ).filter((e) => e !== el);
  const next = existing.find((e) => {
    const t = e.dataset.ts ?? '';
    // 排序键 = ts（统一时间序）；同 ts（含全空串的历史/测试数据）回落 seq 兜底：
    // processEvents 行挂 data-seq，seq 大者排后；QA 条目无 seq 视为 0，靠写入序保持稳定
    if (t !== ts) return t > ts;
    const s = Number(e.dataset.seq ?? 0);
    const myS = Number(el.dataset.seq ?? 0);
    return s > myS;
  });
  if (next) {
    details.insertBefore(el, next);
  } else {
    // 无更高 ts → append 到末尾。注意：不用 phase.after(el)（phase 在 prepend 后居首，
    // phase.after 会把元素插到第二位置，破坏与低 ts 平铺元素——如 narrate——的时间序）
    details.appendChild(el);
  }
}

/**
 * 外部可见条目的边界时间集（工具批断面的**取数处**）。
 *
 * 为什么需要：`groupToolBatches` 只吃 `events`，而问答卡（`.round-block__input`）来自
 * `interactiveInputs` / 运行时缓存——**无 seq、不在 events 里** ⇒ 对切段判据天然不可见，
 * 于是「工具 → 问答卡 → 工具」被并成一批、卡片被推到批块之后（登记缺陷 BATCH-SPLIT-1）。
 * 本函数抽出「同容器里实际可见的问答卡 ts」，作**虚拟断面**喂给切段判据（不碰内核）。
 *
 * 只取 ts：问答卡无 seq，唯一可用的时空键就是 ts；而落位（`insertPlanItemInOrder`）同样按 ts，
 * 故断面判据与呈现同键——避免「判据一套键、呈现另一套键」的双键病复发。
 *
 * @param root  过程容器（`.round-block__details` 或 `.process-flow`），取其后代问答卡
 * @param extra 尚未落 DOM 的条目（finalize 的 `interactiveInputs` 入参）
 * @returns    去重后的 ts 列表（空串剔除——历史/测试数据无时间键，不构成断面；无需排序，仅用于计数）
 */
export function visibleInputTs(
  root: HTMLElement,
  extra: readonly (string | undefined)[] = [],
): string[] {
  const ts = new Set<string>();
  root.querySelectorAll<HTMLElement>('.round-block__input').forEach((el) => {
    const t = el.dataset.ts;
    if (t) ts.add(t);
  });
  for (const t of extra) if (t) ts.add(t);
  return [...ts];
}

/**
 * 工具行状态局部更新：tool_result 到达时，定位已渲染的工具行更新 状态/展开/结果摘要。
 * （进行中工具行已由增量追加创建，result 后到只需原地更新，不重建 DOM）
 *
 * @param container 工具行所在的小节容器（.round-block__section-list）
 * @param result    tool_result 事件
 */
export function updateToolRowState(
  container: HTMLElement,
  result: Extract<ProcessEvent, { type: 'tool_result' }>,
): void {
  container
    .querySelectorAll<HTMLDetailsElement>(
      `.round-block__tool[data-tool-call-id="${result.payload.toolCallId}"]`,
    )
    .forEach((row) => {
      const { label: status, open, running } = toolRowStatus(result);
      // 结构化管理：仅更新状态标签 span 文本（不动整体 summary，保留 label / elapsed 子节点）。
      // 幂等写：文本未变不重写（重写销毁文本节点，点击目标抖动）
      const statusEl = row.querySelector('.round-block__tool-status');
      const statusText = ` (${status})`;
      if (statusEl && statusEl.textContent !== statusText) statusEl.textContent = statusText;
      // 用户意图闩（data-user-toggled，写入点 = summary 点击委托）：用户动过开合的行，
      // 默认值（成功收起/失败展开）不再覆盖——每次事件都回写会把用户的展开态打回。
      // 唯一例外通道 = openForUserVisibility（用户输入恒可见强制展开，只作用任务项分组）
      if (row.dataset.userToggled !== 'true') row.open = open;
      // result 已到达 → 移除进行中态（恢复普通行样式）
      row.classList.toggle('is-tool-running', running);
      // 工具已出结果 → 移除该行等待时长标签（瞬态退场，不再刷新）
      row.querySelector(':scope .round-block__elapsed')?.remove();
      // 结果摘要：首次到达补 DOM（后续到达不重复）；已有命中块则不出——
      // 与 renderToolRow 同一取舍（那里按解析结果判、这里按已渲染 DOM 判，
      // 两条路径互斥：实时增量走本函数，收场/重放走 renderToolRow）
      if (
        result.payload.summary &&
        !row.querySelector('.round-block__tool-summary') &&
        !row.querySelector('.round-block__memory-hits')
      ) {
        const s = document.createElement('div');
        s.className = 'round-block__tool-summary';
        s.textContent = result.payload.summary;
        row.appendChild(s);
      }
    });
}

/**
 * 中断轮平铺收尾行（形态定案：RT/RP 同构——过程收进折叠块、停止行平铺折叠块外）
 *
 * 2026-10-13 终态标签收口底栏：先按 decideTerminus 单点分类把终态写宿主 data-terminus
 * （载体契约见 TerminusKind 注释：中断轮无正文块，挂宿主由 round-group 底栏 :has 消费）；
 * 用户主动停止（kind='用户中断'）停止行退役——footer 标签 + 时间同区即可说清，不再铺行；
 * 异常/兜底案保留停止行，只承担「这轮为何停」的原因句，不重复指标。执行指标留在折叠块
 * §执行指标/摘要。去重按 data-terminus 幂等（user 案无停止行，不能按行去重）。
 *
 * @param host  折叠块宿主（RT = 当前 assistant 块；RP = 孤儿折叠宿主 .is-interrupted-host）
 * @param events 本轮 processEvents（含 error/aborted/metrics）
 */
export function appendInterruptedRow(host: HTMLElement, events: ProcessEvent[]): void {
  // 已定格去重（重放重复投递防重入）：有态（用户/异常案）或有行（generic 兜底案，不写态）任一即返
  if (host.dataset.terminus || host.querySelector('[data-interrupted-row]')) return;
  const verdict = decideTerminus(events);
  // 终态走独立通道（宿主块 data-terminus）；kind=null 案不写态（诚实投影）
  if (verdict.kind) setTerminus(host, verdict.kind);
  if (verdict.kind === '用户中断') return; // 用户中断：停止行退役，底栏标签承载
  const row = document.createElement('div');
  row.className = 'round-block__interrupted';
  row.dataset.interruptedRow = 'true';
  row.textContent = verdict.reason;
  // 挂载点：折叠块（round-block）之后——「过程折叠 · 停止行平铺在外」
  const rb = host.querySelector(':scope > .round-block');
  if (rb) rb.after(row);
  else host.appendChild(row);
}

/**
 * 创建过程流单元格工厂。
 *
 * @param deps 文档对象 + 记忆命中块
 */
export function createProcessFlowCells(deps: ProcessFlowCellsDeps): ProcessFlowCells {
  const { document, memoryHits } = deps;

  /** 获取或创建小节容器（进行中增量专用：不清理已有内容，防误删已追加的工具行） */
  function getOrCreateSection(details: HTMLElement, title: string): HTMLElement {
    let section = details.querySelector<HTMLElement>(`[data-section="${title}"]`);
    if (!section) {
      section = document.createElement('div');
      section.className = 'round-block__section';
      section.dataset.section = title;
      const titleEl = document.createElement('div');
      titleEl.className = 'round-block__section-title';
      titleEl.textContent = title;
      section.appendChild(titleEl);
      const listEl = document.createElement('div');
      listEl.className = 'round-block__section-list';
      section.appendChild(listEl);
      details.appendChild(section);
    }
    return section;
  }

  /** 在 details 中创建/复用小节容器（标题 + 内容行容器，textContent 构建防注入） */
  function sectionOf(
    details: HTMLElement,
    title: string,
  ): { titleEl: HTMLElement; listEl: HTMLElement } {
    // 全量重建：清空已有列表重排（简单确定性——事件量小），再更新标题计数
    const section = getOrCreateSection(details, title);
    const listEl = section.querySelector('.round-block__section-list') as HTMLElement;
    listEl
      .querySelectorAll('.round-block__row, .round-block__tool, .round-block__pre')
      .forEach((el) => el.remove());
    const titleEl = section.querySelector('.round-block__section-title') as HTMLElement;
    const count = listEl.children.length;
    titleEl.textContent = `${title}${count > 0 ? ` (${count})` : ''}`;
    return { titleEl, listEl };
  }

  /** 获取或创建任务项折叠块（summary 显示任务项名；存在则复用，不解体既有已插入的任务项内元素） */
  function getOrCreatePlanItemGroup(
    root: HTMLElement,
    bound: Extract<ProcessEvent, { type: 'plan_item_boundary' }>,
    bounds: Extract<ProcessEvent, { type: 'plan_item_boundary' }>[],
  ): HTMLElement {
    const existing = root.querySelector<HTMLElement>(
      `.round-block__plan-item[data-plan-item="${bound.payload.planItemId ?? ''}"]`,
    );
    if (existing && existing.isConnected) return existing;
    const grp = document.createElement('details');
    grp.className = 'round-block__plan-item';
    if (bound.payload.planItemId) grp.dataset.planItem = bound.payload.planItemId;
    // ts/seq = 边界事件自身的排序键：任务项组**参与** insertPlanItemInOrder 的统一 (ts, seq) 序
    // （组与行是同一坐标系里的两种条目）。不挂 → 行无处可比 → 根层无同层行时 appendChild
    // 把「组外内容」甩到所有组之下（组内工具已全部进组时必然发生）。
    grp.dataset.ts = bound.ts;
    // 任务项序号 = 该边界在所有边界中的排名 + 1（从 1 起）
    const order = bounds.indexOf(bound) + 1;
    const title = bound.payload.title?.trim() ?? '';
    const summary = document.createElement('summary');
    summary.className = 'round-block__plan-item-summary';
    summary.textContent = `任务项 ${order} · ${title.length > 36 ? `${title.slice(0, 36)}…` : title}`;
    grp.appendChild(summary);
    // 任务项内叙述/工具父容器：按序插入 details 顶层，容器内平铺该任务项过程事件
    insertPlanItemGroupInOrder(root, grp, bound.ts, bound.seq);
    return grp;
  }

  /**
   * 任务项内过程行按 seq 顺序插入 details 顶层（narrate 与 tool 共用，扁平化平铺）。
   * 进行中增量调用（每次事件到达），避免整体重排导致闪烁/展开态丢失；finalize 全量重建亦
   * 走此通道保持同一排序逻辑。相位行固定在最前，其余按 seq 升序。
   */

  /**
   * 定位条目应插入的任务项容器（ts 为该条目的时间键；processEvents 行与 interactiveInputs
   * 条目共用，形态甲统一时间序）。无边界回退 details（整轮一组）。
   *
   * 同 ts（含全空串的历史/测试数据）回落 seq 兜底：boundary 在条目之前（boundary.seq <= 条目 seq）
   * 才归该任务项；QA 条目无 seq（undefined）时同 ts 归最近 boundary，靠写入序稳定。
   */
  function planItemContainerFor(
    root: HTMLElement,
    events: ProcessEvent[],
    ts: string,
    seq?: number,
  ): {
    host: HTMLElement;
    bounds: Extract<ProcessEvent, { type: 'plan_item_boundary' }>[];
  } {
    const bounds = events
      .filter(isPlanItemBoundaryEvent)
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
    if (bounds.length === 0) return { host: root, bounds };
    // 找到 ts 前最近的边界（含本条边界自身）——本条边界之前（ts < 首边界）条目归 details 顶层；
    // 同 ts 时边界须已发生（boundary.seq <= 条目 seq），否则跨到后续 step
    const active = [...bounds]
      .reverse()
      .find((b) => b.ts < ts || (b.ts === ts && (seq === undefined || b.seq <= seq)));
    if (!active) return { host: root, bounds };
    return { host: getOrCreatePlanItemGroup(root, active, bounds), bounds };
  }

  /**
   * 过程叙述行（扁平化）：LLM 一段行动叙述 = 一行纯文本直显（对流式 process-flow__narrate 同构）。
   * 工具调用不嵌套进叙述行——narrate 与 tool 平级、按 seq 顺序平铺在 details 顶层
   * （Trae Work 式扁平 step 流）。返回行 el。
   */
  function createNarrateRow(ev: Extract<ProcessEvent, { type: 'narrate' }>): HTMLElement {
    const row = document.createElement('div');
    row.className = 'round-block__narrate';
    // seq 锚点：进行中增量追加去重 + 顶层按序插入（insertPlanItemInOrder）；ts 时间键：统一排序
    row.dataset.seq = String(ev.seq);
    row.dataset.ts = ev.ts;
    // 纯文本直显（对齐流式 process-flow__narrate 同构）：narrate 语义 = 一句话行动叙述，
    // 无折叠价值——旧 details 形态（summary 全文 + body 全文）对 ≤80 字叙述双份消费同一内容，
    // 且与流式纯文本形态分裂（轮结束瞬间直显突变折叠+双份，2026-10-05 真机实锤）。
    // 叙述冒号：结尾无标点时补「：」（流式同款定案「AI 说什么：」后接工具块）——文本防注入
    const text = ev.payload.content.trim();
    row.textContent = /[:：。!！?？；;]$/.test(text) ? text : `${text}：`;
    return row;
  }

  /**
   * 思考折叠块（聚合版）：把同一 step 的 thought 碎片聚合成**一个**折叠块，
   * 正文为各碎片累积拼接（碎片不逐条成块，防 LLM 流式 reasoning 切成几十个片段满屏小折叠）。
   * summary = 标题（label，缺省「思考」）+ 首行预览；textContent 构建防注入。
   * streaming 时默认展开（openByDefault=true 由调用方按运行期传），finalize 默认收起。
   */
  function createAggregatedThought(
    contents: readonly string[],
    openByDefault = false,
    ts?: string,
    seq?: number,
    label = '思考',
  ): HTMLDetailsElement {
    // 思考事件存的是**增量 delta 片段**（如 "Now let me also read" / "the" / "gap analysis."），
    // 按序**原样连续拼接**（无分隔符、不逐条 trim，保留片段的天然间隔）→ 还原真正的连续思考流，
    // 而非「每段一行」的碎片化（P3 之二：确保任务项间连贯）。仅外层做 trim 去首尾空白。
    const text = contents.join('').trim();
    const preview = text.slice(0, 80);
    const cnt = contents.filter((c) => c.trim() !== '').length;
    const row = document.createElement('details');
    row.className = 'round-block__thought';
    row.open = openByDefault;
    // ts 时间键（统一排序）：锚点事件 ts，供 insertPlanItemInOrder 时间序归位；
    // seq 兜底比较（同 ts/空串时回落 seq 序，与 narrate/tool 平铺同构）
    if (ts) row.dataset.ts = ts;
    if (seq !== undefined) row.dataset.seq = String(seq);
    const summary = document.createElement('summary');
    // 思考类型标（独立稳定节点）：thought icon 前置——后续 preview 拼接只写文本 span，icon 不丢
    const icon = document.createElement('span');
    icon.className = 'round-block__type-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = getIconSvg('thought', 12, 12); // 静态 SVG，无外部输入
    const labelSpan = document.createElement('span');
    labelSpan.textContent =
      cnt > 1
        ? `${label} · ${preview}${text.length > preview.length ? '…' : ''}`
        : preview
          ? `${label} · ${preview}`
          : label;
    summary.append(icon, labelSpan);
    const body = document.createElement('div');
    body.className = 'round-block__thought-body';
    body.textContent = text;
    row.append(summary, body);
    return row;
  }

  /**
   * 工具行升级：pending「准备中」行在 tool_start 到达时转执行态，不重建 DOM——
   * 与 renderToolRow 新建的执行态行同构（叙述/状态/进行中高亮），后续 tool_result 更新
   * （updateToolRowState 按 data-tool-call-id）天然复用，无需特判。
   * 排序键补挂（data-seq / data-ts）：升级后并入所在批（口径③）需要与正式行同构的
   * 时间序锚（insertPlanItemInOrder 归位 / 批内平铺排序）。
   */
  function upgradePendingToolRow(
    row: HTMLDetailsElement,
    start: Extract<ProcessEvent, { type: 'tool_start' }>,
  ): void {
    row.classList.remove('is-tool-pending');
    row.classList.add('is-tool-running');
    // 排序键补挂（与 renderToolRow 同构）：seq = tool_start seq（段 id 取材同源）、ts = 时间键
    row.dataset.seq = String(start.seq);
    row.dataset.ts = start.ts;
    const labelEl = row.querySelector<HTMLElement>('.round-block__tool-label');
    // 参数此刻已完整，按既有多参数叙述生成器复原（renderToolRow 同路）
    if (labelEl) labelEl.textContent = toolActionLabel(start.payload.name, start.payload.args);
    const statusEl = row.querySelector<HTMLElement>('.round-block__tool-status');
    if (statusEl) statusEl.textContent = ' (进行中)';
    // 参数补挂（与 renderToolRow 的 args pre 同构）：展开可看本次调用入参
    if (start.payload.args && !row.querySelector(':scope > .round-block__pre')) {
      const pre = document.createElement('pre');
      pre.className = 'round-block__pre';
      pre.textContent = start.payload.args;
      row.appendChild(pre);
    }
  }

  /**
   * 任务项状态单一写入点（SSOT，方案-过程块视觉辨识-20261001.md §四）：按组上已有的
   * data-plan-item 匹配切换状态图标/类——done = circle-check（完成绿）、active = target
   * （正在执行）、pending/blocked 无图标（收起态 summary 干净）。
   *
   * 消费点恰好三个（全部经本函数喂数据，禁第四处内联 DOM 更新）：plan_update 分支
   * （实时显式重建 livePlanStates）、renderProcessFlow 尾部（实时投影 livePlanStates，
   * 兜住组延迟创建）、renderRoundBlock 尾部（finalize/重放，planItemStatesFromEvents
   * 事件序推导）。🔴 禁从标题/时序/工具文本推断状态——只消费内核结构化信号
   * （plan_item_boundary / plan_snapshot / task_table_update）。
   * 幂等：同图标已就位不重复注入（plan_update 高频重推零成本）。
   */
  function applyPlanItemStates(root: HTMLElement, states: Map<string, string>): void {
    root.querySelectorAll<HTMLElement>('.round-block__plan-item[data-plan-item]').forEach((grp) => {
      const status = states.get(grp.dataset.planItem ?? '');
      const summary = grp.querySelector<HTMLElement>('.round-block__plan-item-summary');
      if (!summary) return;
      grp.classList.toggle('is-plan-done', status === 'done');
      grp.classList.toggle('is-plan-active', status === 'active');
      const existing = summary.querySelector<HTMLElement>('.round-block__plan-item-status');
      // 图标由状态唯一决定；无状态/未知状态 = 不显示（数据缺失的自然投影）
      const iconName = status === 'done' ? 'circle-check' : status === 'active' ? 'target' : null;
      if (!iconName) {
        existing?.remove();
        return;
      }
      if (existing?.dataset.statusIcon === iconName) return;
      const el = existing ?? document.createElement('span');
      el.className = 'round-block__plan-item-status';
      el.dataset.statusIcon = iconName;
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = getIconSvg(iconName, 12, 12); // 静态 SVG，无外部输入
      if (!existing) summary.prepend(el);
    });
  }

  /**
   * 刷新批块标题（工具叙述句 + 失败/被拒块级标红提示）
   *
   * 标题 = `toolSummaryText` 的输出（轮收尾摘要同款，同一处形成）——批不再按工具名另起一份计数，
   * 也不挂序号：批号与「思考 · 第 N 步」互不对齐，属屏上第二套编号（STEP-ID-1 防复发精神）。
   *
   * 口径②：失败/被拒工具留段内不拆块，仅在块级打红色提示——拆块会让视觉随错误率抖动。
   * 流式每次增量渲染与 finalize 全量重建都全量重算（结果后到时提示随之更新，幂等）。
   *
   * @param block 批块元素（.round-block__tool-batch）
   * @param batch 工具批（小计/失败统计的唯一数据源）
   */
  function refreshToolBatchSummary(block: HTMLDetailsElement, batch: ToolBatch): void {
    const summary = block.querySelector(':scope > .round-block__tool-batch-summary');
    if (!summary) return;
    // 标题 span 为稳定节点（get-or-create）+ 变化才写文本：summary 子节点重建会销毁点击目标，
    // 事件密集期点击被吞
    let icon = summary.querySelector<HTMLElement>(':scope > .round-block__type-icon');
    if (!icon) {
      // 工具类型标：tool icon 前置（行批共用；稳定节点模式与 title 同构，重刷不重建）
      icon = document.createElement('span');
      icon.className = 'round-block__type-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = getIconSvg('tool', 12, 12); // 静态 SVG，无外部输入
      summary.prepend(icon);
    }
    let title = summary.querySelector<HTMLElement>(':scope > .round-block__tool-batch-title');
    if (!title) {
      title = document.createElement('span');
      title.className = 'round-block__tool-batch-title';
      summary.appendChild(title);
    }
    const titleText = toolSummaryText(batch.entries.map((e) => e.start.payload.name));
    if (title.textContent !== titleText) title.textContent = titleText;
    // 失败/被拒统计（留段内，块级标红）：ok=false 且非 blocked = 失败；blocked = 被拒/拦截
    let failed = 0;
    let blocked = 0;
    for (const e of batch.entries) {
      const r = e.result;
      if (!r) continue;
      if (r.payload.blocked === true) blocked += 1;
      else if (!r.payload.ok) failed += 1;
    }
    block.classList.toggle('is-tool-batch-failed', failed + blocked > 0);
    const parts: string[] = [];
    if (failed > 0) parts.push(`含失败 ${failed}`);
    if (blocked > 0) parts.push(`含拦截 ${blocked}`);
    // 提示 span 同为稳定节点：无提示即移除（生命周期随统计结果，title 节点不受影响）
    let warn = summary.querySelector<HTMLElement>(':scope > .round-block__tool-batch-warn');
    if (parts.length === 0) {
      warn?.remove();
      return;
    }
    if (!warn) {
      warn = document.createElement('span');
      warn.className = 'round-block__tool-batch-warn';
      summary.appendChild(warn);
    }
    const warnText = `（${parts.join(' · ')}）`;
    if (warn.textContent !== warnText) warn.textContent = warnText;
  }

  /**
   * 创建批块容器（多工具批专用；单工具批不包裹 = 行即批，视觉等价现状零回归）
   *
   * DOM key 契约（口径③）：批容器键 = 段 id（`data-tool-batch`），不用 toolCallId；
   * 行自身的 `data-tool-call-id` 只作 tool_result 配对键（updateToolRowState 消费），二者不混用。
   *
   * @param batch 工具批
   * @param open  是否默认展开（流式过程实时可见 = true；finalize 收起 = false）
   */
  function createToolBatchBlock(batch: ToolBatch, open: boolean): HTMLDetailsElement {
    const block = document.createElement('details');
    block.className = 'round-block__tool-batch';
    // 段 id = 段内首个 tool_start 的 seq：批容器唯一 DOM key（data-tool-batch）+ seq 兜底排序键
    block.dataset.toolBatch = String(batch.segId);
    block.dataset.seq = String(batch.segId);
    block.dataset.ts = batch.anchorTs;
    block.open = open;
    const summary = document.createElement('summary');
    summary.className = 'round-block__tool-batch-summary';
    const body = document.createElement('div');
    body.className = 'round-block__tool-batch-body';
    block.append(summary, body);
    refreshToolBatchSummary(block, batch);
    return block;
  }

  /**
   * 渲染 web_search 裁决证据块（单次搜索的归因三件套）。
   *
   * 纯文本构建（textContent，防注入）：端点 / 条数 / 命中标题各占一行，标题行前导圆点。
   * 标题**不做可点链接**——内核证据面只留净化后的标题文本，无 URL 可锚。
   * 零结果（count=0）照渲染——「没搜到」与「搜到了但不对」同为归因现场。
   */
  function renderSearchEvidenceBlock(ev: WebSearchEvidence): HTMLElement {
    const box = document.createElement('div');
    box.className = 'round-block__search-evidence';
    const addLine = (text: string): void => {
      const d = document.createElement('div');
      d.textContent = text;
      box.appendChild(d);
    };
    if (ev.payload.endpoint) addLine(`搜索来源：${ev.payload.endpoint}`);
    addLine(`结果条数：${ev.payload.count}`);
    for (const title of ev.payload.titles) addLine(`· ${title}`);
    return box;
  }

  function renderToolRow(
    start: Extract<ProcessEvent, { type: 'tool_start' }>,
    events: ProcessEvent[],
    resolveSearchEvidence?: (
      start: Extract<ProcessEvent, { type: 'tool_start' }>,
    ) => WebSearchEvidence | undefined,
    resolveMemoryHits?: (toolCallId: string) => Map<string, MemoryHitEntry> | undefined,
  ): HTMLDetailsElement {
    const result = events.find(
      (e): e is Extract<ProcessEvent, { type: 'tool_result' }> =>
        e.type === 'tool_result' && e.payload.toolCallId === start.payload.toolCallId,
    );
    const { label: status, open, running } = toolRowStatus(result);
    const row = document.createElement('details');
    row.className = 'round-block__tool';
    // 增量追加去重锚点：toolCallId（唯一标识）+ seq（顶层按序平铺，insertPlanItemInOrder）；ts 时间键
    row.dataset.toolCallId = start.payload.toolCallId;
    row.dataset.seq = String(start.seq);
    row.dataset.ts = start.ts;
    row.open = open;
    // TS-11b：进行中态 class（未出结果时高亮；result 到达由 updateToolRowState 移除）
    row.classList.toggle('is-tool-running', running);
    const summary = document.createElement('summary');
    summary.className = 'round-block__tool-name';
    // 工具类型标（独立稳定节点）：tool icon 前置（行批共用；运行/待命态由 CSS 切环、隐藏 icon）
    const iconSpan = document.createElement('span');
    iconSpan.className = 'round-block__type-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = getIconSvg('tool', 12, 12); // 静态 SVG，无外部输入
    // TS-11 结构化管理：叙述与状态标签分孤儿 span——状态标签独占定位供 updateToolRowState 精确更新，
    // 与 TS-11c elapsed 等待标签（append 到 summary 尾部）共存不冲突（若仍用整体 textContent 替换，
    // 尾部 Ns 会使状态正则 `\)$` 失配，状态标签停更）
    const labelSpan = document.createElement('span');
    labelSpan.className = 'round-block__tool-label';
    labelSpan.textContent = toolActionLabel(start.payload.name, start.payload.args);
    const statusSpan = document.createElement('span');
    statusSpan.className = 'round-block__tool-status';
    statusSpan.textContent = ` (${status})`; // 前导空格：span 间空白不折叠，显式补「叙述 (状态)」间距
    summary.append(iconSpan, labelSpan, statusSpan);
    row.appendChild(summary);
    if (start.payload.args) {
      const pre = document.createElement('pre');
      pre.className = 'round-block__pre';
      pre.textContent = start.payload.args;
      row.appendChild(pre);
    }
    // 结构化命中明细（本行可用时先取，供下方摘要取舍复用同一份判据）
    const memHits = resolveMemoryHits?.(start.payload.toolCallId);
    // 结果摘要：`search_memories` 的 summary 是同一份内容的 **100 字硬截断副本**
    // （loop.ts `result.slice(0, 100)`，真机截图截到 `(a` 半句）——有结构化命中块时不再渲染，
    // 同源信息不双渲染（与 HOST-S3-2「同源信号不双渲染」同一纪律）。
    // 无命中块时保持原样（零命中 / 被拦 / 非记忆工具都靠它传达结果）。
    if (result?.payload.summary && !(memHits && memHits.size > 0)) {
      const sum = document.createElement('div');
      sum.className = 'round-block__tool-summary';
      sum.textContent = result.payload.summary;
      row.appendChild(sum);
    }
    // web_search 裁决证据块（仅重放路径解析器在场时追加）：展开行体补归因三件套
    if (resolveSearchEvidence) {
      const ev = resolveSearchEvidence(start);
      if (ev) row.appendChild(renderSearchEvidenceBlock(ev));
    }
    // 记忆命中明细（MEM-EVENT-2 / MEM-EVENT-3）：两条源在 renderRoundBlock 已裁决完毕
    // （实时模型 > 证据副本），这里只负责「DOM 全量重建后明细不丢」——收场重建与重放历史轮
    // 都走本函数，重放靠 evidence 的 memory_hits 变体供数（无则自然为空，不伪造）。
    if (memHits && memHits.size > 0) {
      const badge = document.createElement('span');
      badge.className = 'round-block__memory-badge';
      badge.textContent = `记忆 ${memHits.size}`;
      badge.title = `本次调用命中 ${memHits.size} 条记忆（展开查看明细）`;
      summary.appendChild(badge);
      row.appendChild(memoryHits.buildBlock(memHits));
    }
    // 返回行元素：由调用方按 seq 插入 details 顶层（扁平化，不再自挂容器）
    return row;
  }

  return {
    getOrCreateSection,
    sectionOf,
    getOrCreatePlanItemGroup,
    planItemContainerFor,
    createNarrateRow,
    createAggregatedThought,
    upgradePendingToolRow,
    applyPlanItemStates,
    refreshToolBatchSummary,
    createToolBatchBlock,
    renderSearchEvidenceBlock,
    renderToolRow,
  };
}
