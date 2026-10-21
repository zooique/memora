/**
 * 上下文占用域容器（HOST-SPLIT-1 P2 chatView 第 3 刀，域外置工厂范式第 3 次复制）
 *
 * 域职责：输入框内圆环占用条的全量渲染——空态（chat_providers 到达，按选中 LLM
 * 上限渲染 0% 空环）、真实态（context_occupancy 到达，圆环充能 + hover 明细 +
 * 构成条六段）。状态 1 个（`contextLimitShown` 防误清零）+ 常量 2 个 + 函数 5 个
 * 均封装于工厂闭包，chatView 仅持窄接口 2 面（`updateOccupancy` / `renderLimit`）。
 *
 * **边界声明（守内核/宿主边界）**：UI 只渲染宿主透传的数字与条数，不重算。
 * **类型同源**：`occupancy` 形状经 `Extract<ExtensionToWebviewMessage, …>['occupancy']`
 * 从 shared/protocol 取型，不复制字段形状（protocol 改字段时此处编译期即红）。
 * **无监听器**：纯数据驱动渲染（消息到达 → 渲染），无事件注册面；DOM 全即时查询。
 */
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { fmtTokens } from '../helpers/fmtTokens.js';

/** context_occupancy 消息的 occupancy 载荷（协议同源取型，禁在容器内手抄字段形状） */
type ContextOccupancySnapshot = Extract<
  ExtensionToWebviewMessage,
  { type: 'context_occupancy' }
>['occupancy'];

/** 占用域容器依赖：仅需 document（DOM 即时查询，无其他宿主能力依赖） */
export interface ContextOccupancyViewDeps {
  document: Document;
}

/** 占用域窄接口：chatView 仅经此两面驱动，域内状态/常量/内部函数零暴露 */
export interface ContextOccupancyView {
  /** context_occupancy 到达：真实占用渲染（圆环充能 + 明细 + 构成条） */
  updateOccupancy(occ: ContextOccupancySnapshot): void;
  /** chat_providers 到达：按选中 LLM 上限渲染空态（上限未变跳过，防误清零） */
  renderLimit(
    providers: { name: string; limitTokens: number }[],
    activeName: string | undefined,
  ): void;
}

/**
 * 创建上下文占用域容器。
 *
 * @param deps 仅 document（全部 DOM 走即时查询：contextOccupancy / occFill /
 *   occPercent / occTipText / occSegments 五个 id）
 */
export function createContextOccupancyView(deps: ContextOccupancyViewDeps): ContextOccupancyView {
  const { document } = deps;

  // 当前占用条已展示的容量上限（token）——Provider 列表推送（含上限）时据此判断
  // 「上限未变则保留已展示的真实占用」，避免面板数据刷新把已用数字误清零
  let contextLimitShown: number | undefined;

  // 圆环充能几何：SVG r=16 → 周长 2π×16 ≈ 100.53（stroke-dasharray/dashoffset 单位统一）
  const RING_CIRCUMFERENCE = 2 * Math.PI * 16;

  /**
   * 圆环充能填充：按占用比例（0-100）设置 stroke-dashoffset，比例越高弧越满。
   *
   * @param el      圆环 SVG 容器（找 #occFill 圆）
   * @param usedPct 占用百分比（0-100）
   */
  function setRingFill(el: HTMLElement, usedPct: number): void {
    const fill = el.querySelector<SVGCircleElement>('#occFill');
    if (!fill) return;
    const pct = Math.max(0, Math.min(100, usedPct));
    // dasharray = 周长（满环）；dashoffset = 周长 × (1 − 占比) → 占比越高可见弧越长
    fill.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct / 100));
  }

  /** 占用分段标签单点（HOST-S3-2）：hover 明细行与构成条段 title 共用，防两处文案漂移 */
  const SEGMENT_LABELS = {
    rolePack: '角色包/系统设定',
    dynamicSystem: '动态注入',
    dialogue: '完整对话',
    inputAnchor: '当前输入锚点',
    outputReserve: '输出预留',
    free: '剩余可用',
  } as const;

  /**
   * 组装占用明细弹窗文字（纯文字，多行；供 hover/聚焦浮层展示）。
   *
   * 每行「标签：数量 · token（占比）」；rolePack 额外给「占窗口比例」；
   * UI 只渲染宿主透传的数字与条数，不重算（守内核/宿主边界）。
   * 标签取自 SEGMENT_LABELS（与构成条段 title 单点共用）。
   */
  function buildOccupancyTipText(occ: ContextOccupancySnapshot): string {
    const total = Math.max(1, occ.totalTokens);
    const pctOf = (val: number): string => ((val / total) * 100).toFixed(1) + '%';
    const lines: string[] = [`上下文占用（总容量 ${fmtTokens(occ.totalTokens)}）`];
    lines.push(
      `${SEGMENT_LABELS.rolePack}：${fmtTokens(occ.rolePackBaseTokens)}（占窗口 ${pctOf(occ.rolePackBaseTokens)}）`,
    );
    lines.push(
      `${SEGMENT_LABELS.dynamicSystem}：${fmtTokens(occ.dynamicSystemTokens)}（${pctOf(occ.dynamicSystemTokens)}）`,
    );
    lines.push(
      `${SEGMENT_LABELS.dialogue}：${occ.dialogueCount} 条 · ${fmtTokens(occ.dialogueTokens)}（${pctOf(occ.dialogueTokens)}）`,
    );
    lines.push(
      `${SEGMENT_LABELS.inputAnchor}：${fmtTokens(occ.inputAnchorTokens)}（${pctOf(occ.inputAnchorTokens)}）`,
    );
    lines.push(
      `${SEGMENT_LABELS.outputReserve}：${fmtTokens(occ.outputReserveTokens)}（${pctOf(occ.outputReserveTokens)}）`,
    );
    lines.push(`${SEGMENT_LABELS.free}：${fmtTokens(occ.freeTokens)}（${pctOf(occ.freeTokens)}）`);
    return lines.join('\n');
  }

  /**
   * 构成条渲染（HOST-S3-2）：五段实际占用 + 剩余按 token 数比例拼满**圆环 hover 卡片底部**的分段条。
   *
   * 每段 flex-grow = 该段 token 数（flex-basis 0 ⇒ 宽度精确按比例），原生 title 出
   * 单段明细（与 buildOccupancyTipText 共用 SEGMENT_LABELS 及同一格式化口径，两处零漂移）；
   * UI 只渲染宿主透传的数字，不重算（守内核/宿主边界）。每次全量重建（6 个 div，无需 diff）。
   * 2026-10-18 由状态行常驻移入卡片（输入条同源双渲染去重，见 chatPanel.ts 结构注释）。
   */
  function renderOccupancySegments(occ: ContextOccupancySnapshot): void {
    const bar = document.getElementById('occSegments');
    if (!bar) return;
    const total = Math.max(1, occ.totalTokens);
    const pctOf = (val: number): string => ((val / total) * 100).toFixed(1) + '%';
    // 段序 = 台账口径五段（角色包/动态注入/对话/输入锚点/输出预留）+ 剩余；title 与 hover 明细行同格式
    const segments: { cls: string; tokens: number; title: string }[] = [
      {
        cls: 'rolepack',
        tokens: occ.rolePackBaseTokens,
        title: `${SEGMENT_LABELS.rolePack}：${fmtTokens(occ.rolePackBaseTokens)}（占窗口 ${pctOf(occ.rolePackBaseTokens)}）`,
      },
      {
        cls: 'dynamic',
        tokens: occ.dynamicSystemTokens,
        title: `${SEGMENT_LABELS.dynamicSystem}：${fmtTokens(occ.dynamicSystemTokens)}（${pctOf(occ.dynamicSystemTokens)}）`,
      },
      {
        cls: 'dialogue',
        tokens: occ.dialogueTokens,
        title: `${SEGMENT_LABELS.dialogue}：${occ.dialogueCount} 条 · ${fmtTokens(occ.dialogueTokens)}（${pctOf(occ.dialogueTokens)}）`,
      },
      {
        cls: 'input',
        tokens: occ.inputAnchorTokens,
        title: `${SEGMENT_LABELS.inputAnchor}：${fmtTokens(occ.inputAnchorTokens)}（${pctOf(occ.inputAnchorTokens)}）`,
      },
      {
        cls: 'output',
        tokens: occ.outputReserveTokens,
        title: `${SEGMENT_LABELS.outputReserve}：${fmtTokens(occ.outputReserveTokens)}（${pctOf(occ.outputReserveTokens)}）`,
      },
      {
        cls: 'free',
        tokens: occ.freeTokens,
        title: `${SEGMENT_LABELS.free}：${fmtTokens(occ.freeTokens)}（${pctOf(occ.freeTokens)}）`,
      },
    ];
    bar.replaceChildren(
      ...segments.map((seg) => {
        // 段 div：flex-grow = token 数（比例真源），flex-basis 0 ⇒ 宽度按比例精确拼满
        const el = document.createElement('div');
        el.className = `context-segments__seg context-segments__seg--${seg.cls}`;
        el.style.flexGrow = String(Math.max(0, seg.tokens));
        el.style.flexBasis = '0';
        el.title = seg.title;
        return el;
      }),
    );
    bar.hidden = false;
  }

  /**
   * ④ 预算可视化：首轮对话前，按当前选中 LLM 的上下文上限渲染圆环空态。
   *
   * chat_providers 到达时调用：真实占用（context_occupancy）要等首轮流式结束才有，
   * 在此之前圆环展示「0% 空环 + 总容量」，让用户即时感知所选模型的窗口容量。
   * 无选中 Provider 时不展示（无「当前模型」可依赖，避免展示误导性的缺省值）。
   * 上限与已展示值相同 → 跳过（保留真实占用，不重复清零）。
   */
  function renderOccupancyLimit(
    providers: { name: string; limitTokens: number }[],
    activeName: string | undefined,
  ): void {
    const el = document.getElementById('contextOccupancy');
    if (!el) return;
    if (!activeName) return;
    const active = providers.find((p) => p.name === activeName);
    if (!active || typeof active.limitTokens !== 'number') return;
    // 上限未变化 → 保留已展示的真实占用（同一模型，无重置必要）
    if (contextLimitShown === active.limitTokens) return;
    // 展示容量上限 + 空环（真实占用待 context_occupancy 覆盖）
    el.hidden = false;
    setRingFill(el, 0);
    const percentEl = document.getElementById('occPercent');
    if (percentEl) percentEl.textContent = '0%';
    // 空态明细复用 buildOccupancyTipText（同一份明细拼装，不手写第二份）：
    // 全 0 占用 + free=total（100% 剩余），与真实态共用同一行结构与格式
    const emptyOcc = {
      totalTokens: active.limitTokens,
      rolePackBaseTokens: 0,
      dynamicSystemTokens: 0,
      dialogueTokens: 0,
      dialogueCount: 0,
      inputAnchorTokens: 0,
      outputReserveTokens: 0,
      freeTokens: active.limitTokens,
    };
    const tipTextEl = document.getElementById('occTipText');
    if (tipTextEl) {
      tipTextEl.textContent = buildOccupancyTipText(emptyOcc);
    }
    // 空态构成条同步渲染（全 free 段，真实占用待 context_occupancy 覆盖）
    renderOccupancySegments(emptyOcc);
  }

  /**
   * ④ 预算可视化：更新输入框内圆环充能图标。
   *
   * 各段为 prepare 期**真实用量**（token）+ 条数，圆环按占用比例充能；
   * hover/聚焦弹窗出完整分层明细（含条数、token、占比、角色包比例）。
   * UI 只渲染宿主透传的数字，不重算（守内核/宿主边界）。
   */
  function updateContextOccupancy(occ: ContextOccupancySnapshot): void {
    const el = document.getElementById('contextOccupancy');
    if (!el) return;
    el.hidden = false;
    // 记录内核真实总容量：后续同款 chat_providers 推送不再重置已用数字
    contextLimitShown = occ.totalTokens;
    const total = Math.max(1, occ.totalTokens);
    // 圆环充能比例 = 已用占比（total − free）/ total
    const usedPct = Math.max(0, Math.min(100, ((total - occ.freeTokens) / total) * 100));
    setRingFill(el, usedPct);
    const percentEl = document.getElementById('occPercent');
    if (percentEl) percentEl.textContent = usedPct.toFixed(0) + '%';
    // 明细文字写入 tip 的文本子节点（勿写 tip 本身——构成条是 tip 的子节点，textContent 会连它一起清掉）
    const tipTextEl = document.getElementById('occTipText');
    if (tipTextEl) tipTextEl.textContent = buildOccupancyTipText(occ);
    // 构成条（HOST-S3-2）同步更新：五段真实占用 + 剩余常驻一瞥
    renderOccupancySegments(occ);
  }

  // ── 窄接口 ──

  return {
    updateOccupancy: updateContextOccupancy,
    renderLimit: renderOccupancyLimit,
  };
}
