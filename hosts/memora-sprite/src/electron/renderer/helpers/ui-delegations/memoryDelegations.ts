/**
 * Memory 面板委托群
 *
 * 从 ui.ts 提取的薄委托方法群，通过 mixin 模式注入 UIManager.prototype。
 * 所有方法均为纯透传到 MemoryPanelManager，不夹带业务逻辑（ADR-SP-015 §4）。
 *
 * 设计原则：
 * - 每个方法的 this 类型声明为 UIManager，以访问组合持有的 memoryPanel 实例
 * - 方法签名与 ui.ts 原始声明完全一致，保持外部契约不变
 */

// STEP9-IMPORTS-01 反向 type-only 引用：编译期擦除，禁止改为 value import（否则与 ui 形成运行时循环依赖）
import type { UIManager } from '../../ui.js';
import type {
  MemoryListItem,
  MemoryDetail,
  RelationPath,
  RelationNeighbor,
} from '../../types.js';
import type { RelationGraphData } from '../../components/relationGraph.js';

/** Memory 委托群方法签名（供 UIManager interface extends 类型合并） */
export interface MemoryDelegations {
  dismissMemoryAnalysisPanels(): void;
  /** 进入记忆面板时确保当前激活区块视图可见 */
  activateMemoryPanelView(): void;
  renderMemoryList(memories: MemoryListItem[], searchQuery?: string): void;
  /**
   * 半乐观局部移除记忆项（避免全量 loadMemoryList 触发闪烁）
   *
   * @returns true 表示已局部移除；false 表示当前视图不支持局部移除，调用方需自行全量刷新
   */
  removeMemoryFromCache(id: string): boolean;
  /**
   * 重建来源筛选 dropdown 选项（保留当前选中值）
   *
   * @param sources 排序后的 distinct source 字符串数组
   * @param currentValue 当前选中值（空字符串表示"全部来源"）
   */
  renderMemorySourceFilter(sources: string[], currentValue: string): void;
  showMemoryDetail(memory: MemoryDetail): void;
  showMemoryLineage(path: RelationPath[]): void;
  showMemoryLineageError(onRetry: () => void): void;
  showMemoryNeighbors(neighbors: RelationNeighbor[]): void;
  showMemoryNeighborsError(onRetry: () => void): void;
  clearAddMemoryForm(): void;
  getAddMemoryFormData(): { source: string; name: string; content: string } | null;
  getCurrentMemoryId(): string | null;
  onMemorySearch(cb: (query: string) => void): void;
  onMemoryFilter(cb: (source: string) => void): void;
  onMemoryClick(cb: (id: string) => void): void;
  onMemoryDelete(cb: () => void): void;
  onMemoryAdd(cb: (data: { source: string; name: string; content: string }) => void): void;
  onMemoryEdit(cb: (id: string, content: string) => void): void;
  onMemoryDiscuss(cb: (memoryName: string) => void): void;
  loadGraphData(data: RelationGraphData): void;
  switchMemoryView(mode: 'list' | 'timeline' | 'graph'): void;
  hasGraphData(): boolean;
  /** 使图谱数据缓存失效（记忆/关系变更后调用，防止图谱显示陈旧数据） */
  invalidateGraphCache(): void;
  /** 获取当前记忆面板视图模式（list/timeline/graph） */
  getViewMode(): 'list' | 'timeline' | 'graph';
  highlightGraphNodes(nodeIds: string[] | null): void;
  selectGraphNode(nodeId: string | null): void;
  clearGraphHighlights(): void;
  onMoreMenuAction(cb: (action: string) => void): void;
  onRecycleBinAction(cb: (action: 'restore' | 'purge', id: string) => Promise<void>): void;
  onRecycleBinBatchAction(cb: (action: 'restore-all' | 'purge-all') => Promise<void>): void;
  renderRecycleBinList(memories: Array<{ id: string; name: string; source: string; contentPreview: string; deletedAt: string }>): void;
  onSortChange(cb: () => void): void;
  onTimeRangeChange(cb: () => void): void;
  onCleanupRequest(cb: (type: 'duplicates' | 'stale' | 'all') => string[]): void;
  onCleanupConfirm(cb: (ids: string[]) => Promise<void>): void;
  /** LLM 治理回调（dedup/timeliness/conflicts） */
  onLlmGovernance(cb: (action: 'dedup' | 'timeliness' | 'conflicts') => Promise<void>): void;
  onViewSwitch(cb: (mode: 'list' | 'timeline' | 'graph') => void): void;
  onGraphContextMenuAction(cb: (action: string, nodeId: string) => void): void;
  onRelationEdit(cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void;
  onRelationDelete(cb: (sourceId: string, targetId: string, type: string) => void): void;
  onRelationCreate(cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void;
}

/** Memory 委托群实现——纯透传到 memoryPanel */
export const memoryDelegations: MemoryDelegations = {
  dismissMemoryAnalysisPanels(this: UIManager): void {
    this.memoryCoordinator.memoryPanel.dismissAnalysisPanels();
  },
  activateMemoryPanelView(this: UIManager): void {
    this.memoryCoordinator.memoryPanel.ensureActiveSectionVisible();
  },
  renderMemoryList(this: UIManager, memories: MemoryListItem[], searchQuery?: string): void {
    this.memoryCoordinator.memoryPanel.renderMemoryList(memories, searchQuery);
  },
  removeMemoryFromCache(this: UIManager, id: string): boolean {
    return this.memoryCoordinator.memoryPanel.removeMemoryFromCache(id);
  },
  renderMemorySourceFilter(this: UIManager, sources: string[], currentValue: string): void {
    this.memoryCoordinator.memoryPanel.renderSourceFilter(sources, currentValue);
  },
  showMemoryDetail(this: UIManager, memory: MemoryDetail): void {
    this.memoryCoordinator.memoryPanel.showMemoryDetail(memory);
  },
  showMemoryLineage(this: UIManager, path: RelationPath[]): void {
    this.memoryCoordinator.memoryPanel.showMemoryLineage(path);
  },
  showMemoryLineageError(this: UIManager, onRetry: () => void): void {
    this.memoryCoordinator.memoryPanel.showLineageError(onRetry);
  },
  showMemoryNeighbors(this: UIManager, neighbors: RelationNeighbor[]): void {
    this.memoryCoordinator.memoryPanel.showMemoryNeighbors(neighbors);
  },
  showMemoryNeighborsError(this: UIManager, onRetry: () => void): void {
    this.memoryCoordinator.memoryPanel.showNeighborsError(onRetry);
  },
  clearAddMemoryForm(this: UIManager): void {
    this.memoryCoordinator.memoryPanel.clearAddMemoryForm();
  },
  getAddMemoryFormData(this: UIManager): { source: string; name: string; content: string } | null {
    return this.memoryCoordinator.memoryPanel.getAddMemoryFormData();
  },
  getCurrentMemoryId(this: UIManager): string | null {
    return this.memoryCoordinator.memoryPanel.getCurrentMemoryId();
  },
  onMemorySearch(this: UIManager, cb: (query: string) => void): void {
    this.memoryCoordinator.memoryPanel.onMemorySearch(cb);
  },
  onMemoryFilter(this: UIManager, cb: (source: string) => void): void {
    this.memoryCoordinator.memoryPanel.onMemoryFilter(cb);
  },
  onMemoryClick(this: UIManager, cb: (id: string) => void): void {
    this.memoryCoordinator.memoryPanel.onMemoryClick(cb);
    // 感知面板（精灵状态/模式洞察）的"关联记忆"按钮复用同一跳转回调
    this.perceptionCoordinator.perceptionPanel.onMemoryClick(cb);
  },
  onMemoryDelete(this: UIManager, cb: () => void): void {
    this.memoryCoordinator.memoryPanel.onMemoryDelete(cb);
  },
  onMemoryAdd(this: UIManager, cb: (data: { source: string; name: string; content: string }) => void): void {
    this.memoryCoordinator.memoryPanel.onMemoryAdd(cb);
  },
  onMemoryEdit(this: UIManager, cb: (id: string, content: string) => void): void {
    this.memoryCoordinator.memoryPanel.onMemoryEdit(cb);
  },
  onMemoryDiscuss(this: UIManager, cb: (memoryName: string) => void): void {
    this.memoryCoordinator.memoryPanel.onMemoryDiscuss(cb);
  },
  loadGraphData(this: UIManager, data: RelationGraphData): void {
    this.memoryCoordinator.memoryPanel.loadGraphData(data);
  },
  switchMemoryView(this: UIManager, mode: 'list' | 'timeline' | 'graph'): void {
    this.memoryCoordinator.memoryPanel.switchView(mode);
  },
  hasGraphData(this: UIManager): boolean {
    return this.memoryCoordinator.memoryPanel.hasGraphData();
  },
  invalidateGraphCache(this: UIManager): void {
    this.memoryCoordinator.memoryPanel.invalidateGraphCache();
  },
  getViewMode(this: UIManager): 'list' | 'timeline' | 'graph' {
    return this.memoryCoordinator.memoryPanel.getViewMode();
  },
  highlightGraphNodes(this: UIManager, nodeIds: string[] | null): void {
    this.memoryCoordinator.memoryPanel.highlightGraphNodes(nodeIds);
  },
  selectGraphNode(this: UIManager, nodeId: string | null): void {
    this.memoryCoordinator.memoryPanel.selectGraphNode(nodeId);
  },
  clearGraphHighlights(this: UIManager): void {
    this.memoryCoordinator.memoryPanel.clearGraphHighlights();
  },
  onMoreMenuAction(this: UIManager, cb: (action: string) => void): void {
    this.memoryCoordinator.memoryPanel.onMoreMenuAction(cb);
  },
  onRecycleBinAction(this: UIManager, cb: (action: 'restore' | 'purge', id: string) => Promise<void>): void {
    this.memoryCoordinator.memoryPanel.onRecycleBinAction(cb);
  },
  onRecycleBinBatchAction(this: UIManager, cb: (action: 'restore-all' | 'purge-all') => Promise<void>): void {
    this.memoryCoordinator.memoryPanel.onRecycleBinBatchAction(cb);
  },
  renderRecycleBinList(this: UIManager, memories: Array<{ id: string; name: string; source: string; contentPreview: string; deletedAt: string }>): void {
    this.memoryCoordinator.memoryPanel.renderRecycleBinList(memories);
  },
  onSortChange(this: UIManager, cb: () => void): void {
    this.memoryCoordinator.memoryPanel.onSortChange(cb);
  },
  onTimeRangeChange(this: UIManager, cb: () => void): void {
    this.memoryCoordinator.memoryPanel.onTimeRangeChange(cb);
  },
  onCleanupRequest(this: UIManager, cb: (type: 'duplicates' | 'stale' | 'all') => string[]): void {
    this.memoryCoordinator.memoryPanel.onCleanupRequest(cb);
  },
  onCleanupConfirm(this: UIManager, cb: (ids: string[]) => Promise<void>): void {
    this.memoryCoordinator.memoryPanel.onCleanupConfirm(cb);
  },
  onLlmGovernance(this: UIManager, cb: (action: 'dedup' | 'timeliness' | 'conflicts') => Promise<void>): void {
    this.memoryCoordinator.memoryPanel.onLlmGovernance(cb);
  },
  onViewSwitch(this: UIManager, cb: (mode: 'list' | 'timeline' | 'graph') => void): void {
    this.memoryCoordinator.memoryPanel.onViewSwitch(cb);
  },
  onGraphContextMenuAction(this: UIManager, cb: (action: string, nodeId: string) => void): void {
    this.memoryCoordinator.memoryPanel.onGraphContextMenuAction(cb);
  },
  onRelationEdit(this: UIManager, cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void {
    this.memoryCoordinator.memoryPanel.onRelationEdit(cb);
  },
  onRelationDelete(this: UIManager, cb: (sourceId: string, targetId: string, type: string) => void): void {
    this.memoryCoordinator.memoryPanel.onRelationDelete(cb);
  },
  onRelationCreate(this: UIManager, cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void {
    this.memoryCoordinator.memoryPanel.onRelationCreate(cb);
  },
};
