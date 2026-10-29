/**
 * 工具行动作面（CHATVIEW-SLIM-3 第 2 刀·零状态批，自 chatView.ts 外置）
 *
 * 域职责：围绕过程流**工具行**（`.round-block__tool`）的三件事——按 toolCallId 定位、
 * 注销未升级的预告行、把记忆命中明细挂进对应行。
 *
 * **边界**：无定时器、无监听、无 DOM 自建；只消费外部注入的 DOM 入口与记忆命中模型：
 * - `messages` / `document`：宿主节点（禁在模块内读全局 document）；
 * - `memoryHitsByCall`：**只读消费**——所有权在 chatView（新轮/复位/重建处写入与清空），
 *   本模块只 `get`/`迭代`，不写不删（域外写、域内读 = 单向，故注入引用而非回调）；
 * - `memoryHits`：记忆命中明细块实例（与 `processFlowCells` 同一实例，单一定义两处消费）。
 *
 * 纯搬迁，零行为变化：函数体与注释自 `chatView.ts` 原样迁出（2026-10-29，
 * 方案见 `tasks/方案-CHATVIEW-SLIM-2-过程流单元格外置-20261029.md` §10）。
 *
 * @module toolRowView
 */
import type { MemoryHitEntry } from '../helpers/processFlowModel.js';
import type { MemoryHitsBlock } from './memoryHitsBlock.js';

/** 工具行动作面依赖 */
export interface ToolRowViewDeps {
  /** webview 文档对象（命中徽章构造；禁在模块内读全局 document） */
  document: Document;
  /** 消息区容器（工具行所在 DOM 根，供定位与扫描） */
  messages: HTMLElement;
  /** 记忆命中明细块实例（单一定义、两处消费） */
  memoryHits: MemoryHitsBlock;
  /** 本轮记忆命中·按调用分组（**只读**：所有权在 chatView） */
  memoryHitsByCall: Map<string, Map<string, MemoryHitEntry>>;
}

/** 工具行动作面窄接口（内部构造函数零暴露） */
export interface ToolRowView {
  /** 按 toolCallId 定位工具行（属性扫描，不拼选择器） */
  findToolRow(toolCallId: string): HTMLDetailsElement | null;
  /** 注销未升级的预告行（截断批/重试孤儿的 tool_start 永不到达） */
  dropStalePendingToolRows(): void;
  /** 把某次调用的命中明细挂进对应工具折叠块（幂等重建）；返回目标工具行是否存在 */
  attachMemoryHits(toolCallId: string): boolean;
}

/**
 * 创建工具行动作面。
 *
 * @param deps 依赖（DOM 入口 + 只读记忆命中模型）
 */
export function createToolRowView(deps: ToolRowViewDeps): ToolRowView {
  const { document, messages } = deps;
  // 以下两个别名保持状态原名：函数体逐字零改写（所有权仍在 chatView，本模块只读消费）
  const currentMemoryHitsByCall = deps.memoryHitsByCall;
  const memoryHitsBlock = deps.memoryHits;

  /**
   * 按 toolCallId 定位工具行（属性扫描，不拼选择器）。
   *
   * 不用 `[data-tool-call-id="${id}"]`：toolCallId 源自 LLM 供应商，理论可含引号/反斜杠，
   * 拼进选择器会抛 SyntaxError 或被误解析。扫描成本 O(工具行数)，一次成轮几十行的量级可忽略，
   * 换掉一整类逃逸风险。（既有 updateToolRowState 的拼接式选择器不在本次改动范围，未联动。）
   */
  function findToolRow(toolCallId: string): HTMLDetailsElement | null {
    for (const row of messages.querySelectorAll<HTMLDetailsElement>('.round-block__tool')) {
      if (row.dataset.toolCallId === toolCallId) return row;
    }
    return null;
  }

  /**
   * 把某次 search_memories 调用的命中明细挂进对应工具折叠块（幂等重建）。
   *
   * 幂等策略 = 「先摘后建」而非增量对账：同一 toolCallId 可能多次更新（一轮多次检索同一调用
   * 的追加、memory_deleted 后的重算），每次都从 currentMemoryHitsByCall 重建，
   * 保证「模型是什么样，DOM 就是什么样」，不会留下孤儿节点或错位计数。
   *
   * @returns 目标工具行是否存在（false ⇒ 调用方须把数据转入兜底聚合——行未就绪或老内核无
   *   配对键时，宁可退回旧落位也不丢信息）
   */
  function attachMemoryHits(toolCallId: string): boolean {
    const row = findToolRow(toolCallId);
    if (!row) return false;
    row.querySelector('.round-block__memory-badge')?.remove();
    row.querySelector('.round-block__memory-hits')?.remove();
    const hits = currentMemoryHitsByCall.get(toolCallId);
    if (!hits || hits.size === 0) return true;
    // 命中块出现 ⇒ 撤掉 100 字截断摘要（同源不双渲染；先到摘要、后到命中的时序在此收口）
    row.querySelector('.round-block__tool-summary')?.remove();
    const summary = row.querySelector('.round-block__tool-name');
    if (summary) {
      const badge = document.createElement('span');
      badge.className = 'round-block__memory-badge';
      badge.textContent = `记忆 ${hits.size}`;
      badge.title = `本次调用命中 ${hits.size} 条记忆（展开查看明细）`;
      summary.appendChild(badge);
    }
    row.appendChild(memoryHitsBlock.buildBlock(hits));
    return true;
  }

  /**
   * 「（准备中）」预告行注销（生命周期契约：每条预告行**要么升级、要么注销**，不许常驻）。
   *
   * 预告行（tool_pending，瞬态轨）的宿命只有两个出口：① tool_start 到达 → 升级执行态
   * （upgradePendingToolRow）；② 所属批的 tool_start **永不到达** → 此处注销。触发集 =
   * 批宿命已定的全部落点：`step_boundary`（截断批/重试孤儿在此注销——continue 型迭代落盘点）；
   * 提问定型（ask 挂起批不发 step_boundary，其宿命在提问 UI 渲染时已定）；用户输入
   * （插话/新轮打断在途批，[TOOL_ABORTED] 同源）。轮收尾/中断由整树重建天然注销（finalizeRound
   * 拆过程容器），不重复挂钩。不注销的后果 = 运行时残留无内容的幽灵折叠块、散在任务项折叠块外。
   */
  function dropStalePendingToolRows(): void {
    messages.querySelectorAll('.round-block__tool.is-tool-pending').forEach((row) => row.remove());
  }

  return { findToolRow, dropStalePendingToolRows, attachMemoryHits };
}
