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
  renderMemoryList(memories: MemoryListItem[], searchQuery?: string): void;
  showMemoryDetail(memory: MemoryDetail): void;
  showMemoryLineage(path: RelationPath[]): void;
  showMemoryNeighbors(neighbors: RelationNeighbor[]): void;
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
  highlightGraphNodes(nodeIds: string[] | null): void;
  selectGraphNode(nodeId: string | null): void;
  clearGraphHighlights(): void;
  onMoreMenuAction(cb: (action: string) => void): void;
  onRecycleBinAction(cb: (action: 'restore' | 'purge', id: string) => void): void;
  onRecycleBinBatchAction(cb: (action: 'restore-all' | 'purge-all') => void): void;
  renderRecycleBinList(memories: Array<{ id: string; name: string; source: string; contentPreview: string; deletedAt: string }>): void;
  onSortChange(cb: () => void): void;
  onTimeRangeChange(cb: () => void): void;
  onCleanupRequest(cb: (type: 'duplicates' | 'stale' | 'all') => string[]): void;
  onCleanupConfirm(cb: (ids: string[]) => Promise<void>): void;
  onViewSwitch(cb: (mode: 'list' | 'timeline' | 'graph') => void): void;
  onGraphContextMenuAction(cb: (action: string, nodeId: string) => void): void;
  onRelationEdit(cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void;
  onRelationDelete(cb: (sourceId: string, targetId: string, type: string) => void): void;
  onRelationCreate(cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void;
}

/** Memory 委托群实现——纯透传到 memoryPanel */
export const memoryDelegations: MemoryDelegations = {
  dismissMemoryAnalysisPanels(this: UIManager): void {
    this.memoryPanel.dismissAnalysisPanels();
  },
  renderMemoryList(this: UIManager, memories: MemoryListItem[], searchQuery?: string): void {
    this.memoryPanel.renderMemoryList(memories, searchQuery);
  },
  showMemoryDetail(this: UIManager, memory: MemoryDetail): void {
    this.memoryPanel.showMemoryDetail(memory);
  },
  showMemoryLineage(this: UIManager, path: RelationPath[]): void {
    this.memoryPanel.showMemoryLineage(path);
  },
  showMemoryNeighbors(this: UIManager, neighbors: RelationNeighbor[]): void {
    this.memoryPanel.showMemoryNeighbors(neighbors);
  },
  clearAddMemoryForm(this: UIManager): void {
    this.memoryPanel.clearAddMemoryForm();
  },
  getAddMemoryFormData(this: UIManager): { source: string; name: string; content: string } | null {
    return this.memoryPanel.getAddMemoryFormData();
  },
  getCurrentMemoryId(this: UIManager): string | null {
    return this.memoryPanel.getCurrentMemoryId();
  },
  onMemorySearch(this: UIManager, cb: (query: string) => void): void {
    this.memoryPanel.onMemorySearch(cb);
  },
  onMemoryFilter(this: UIManager, cb: (source: string) => void): void {
    this.memoryPanel.onMemoryFilter(cb);
  },
  onMemoryClick(this: UIManager, cb: (id: string) => void): void {
    this.memoryPanel.onMemoryClick(cb);
  },
  onMemoryDelete(this: UIManager, cb: () => void): void {
    this.memoryPanel.onMemoryDelete(cb);
  },
  onMemoryAdd(this: UIManager, cb: (data: { source: string; name: string; content: string }) => void): void {
    this.memoryPanel.onMemoryAdd(cb);
  },
  onMemoryEdit(this: UIManager, cb: (id: string, content: string) => void): void {
    this.memoryPanel.onMemoryEdit(cb);
  },
  onMemoryDiscuss(this: UIManager, cb: (memoryName: string) => void): void {
    this.memoryPanel.onMemoryDiscuss(cb);
  },
  loadGraphData(this: UIManager, data: RelationGraphData): void {
    this.memoryPanel.loadGraphData(data);
  },
  switchMemoryView(this: UIManager, mode: 'list' | 'timeline' | 'graph'): void {
    this.memoryPanel.switchView(mode);
  },
  hasGraphData(this: UIManager): boolean {
    return this.memoryPanel.hasGraphData();
  },
  highlightGraphNodes(this: UIManager, nodeIds: string[] | null): void {
    this.memoryPanel.highlightGraphNodes(nodeIds);
  },
  selectGraphNode(this: UIManager, nodeId: string | null): void {
    this.memoryPanel.selectGraphNode(nodeId);
  },
  clearGraphHighlights(this: UIManager): void {
    this.memoryPanel.clearGraphHighlights();
  },
  onMoreMenuAction(this: UIManager, cb: (action: string) => void): void {
    this.memoryPanel.onMoreMenuAction(cb);
  },
  onRecycleBinAction(this: UIManager, cb: (action: 'restore' | 'purge', id: string) => void): void {
    this.memoryPanel.onRecycleBinAction(cb);
  },
  onRecycleBinBatchAction(this: UIManager, cb: (action: 'restore-all' | 'purge-all') => void): void {
    this.memoryPanel.onRecycleBinBatchAction(cb);
  },
  renderRecycleBinList(this: UIManager, memories: Array<{ id: string; name: string; source: string; contentPreview: string; deletedAt: string }>): void {
    this.memoryPanel.renderRecycleBinList(memories);
  },
  onSortChange(this: UIManager, cb: () => void): void {
    this.memoryPanel.onSortChange(cb);
  },
  onTimeRangeChange(this: UIManager, cb: () => void): void {
    this.memoryPanel.onTimeRangeChange(cb);
  },
  onCleanupRequest(this: UIManager, cb: (type: 'duplicates' | 'stale' | 'all') => string[]): void {
    this.memoryPanel.onCleanupRequest(cb);
  },
  onCleanupConfirm(this: UIManager, cb: (ids: string[]) => Promise<void>): void {
    this.memoryPanel.onCleanupConfirm(cb);
  },
  onViewSwitch(this: UIManager, cb: (mode: 'list' | 'timeline' | 'graph') => void): void {
    this.memoryPanel.onViewSwitch(cb);
  },
  onGraphContextMenuAction(this: UIManager, cb: (action: string, nodeId: string) => void): void {
    this.memoryPanel.onGraphContextMenuAction(cb);
  },
  onRelationEdit(this: UIManager, cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void {
    this.memoryPanel.onRelationEdit(cb);
  },
  onRelationDelete(this: UIManager, cb: (sourceId: string, targetId: string, type: string) => void): void {
    this.memoryPanel.onRelationDelete(cb);
  },
  onRelationCreate(this: UIManager, cb: (sourceId: string, targetId: string, type: string, weight: number) => void): void {
    this.memoryPanel.onRelationCreate(cb);
  },
};
