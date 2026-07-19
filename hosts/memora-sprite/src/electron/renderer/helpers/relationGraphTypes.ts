/**
 * 记忆关系图谱类型定义与常量（从 relationGraph.ts 提取）
 *
 * 职责：
 *   集中管理关系图谱的类型定义与渲染常量，作为类型真理源单向下沉，
 *   依赖方向：helpers → helpers（类型真理源），components → helpers。
 *
 * 架构价值（ADR-017 §架构层先行）：
 *   类型集中导出避免 helpers 与 components 之间的 type-only 循环依赖，
 *   所有关系图谱相关模块（components/relationGraph.ts、helpers/relationGraphLayout.ts、
 *   helpers/relationGraphColor.ts、helpers/relationGraphGeometry.ts）统一从此处导入类型。
 *
 * 设计：
 *   - 纯类型 + 常量导出，无运行时逻辑
 *
 * 先例：
 *   参照 memoryPanelManager 拆分模式，本次为 relationGraph 的第 3 次提取
 *   （layout + color + types），属架构层改进
 */

// ─── 类型定义 ────────────────────────────────────────────────

/** 图谱节点（来自 MemoryListItem，含布局计算所需的坐标与速度） */
export interface GraphNode {
  id: string;
  name: string;
  source: string;
  score: number;
  contentPreview: string;
  /** 当前 x 坐标（布局计算） */
  x: number;
  /** 当前 y 坐标（布局计算） */
  y: number;
  /** x 方向速度 */
  vx: number;
  /** y 方向速度 */
  vy: number;
}

/** 图谱边（来自 MemoryRelation） */
export interface GraphEdge {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
  createdAt: string;
}

/** 图谱原始数据（loadData 入参） */
export interface RelationGraphData {
  nodes: Array<{
    id: string;
    name: string;
    source: string;
    score: number;
    contentPreview: string;
  }>;
  edges: GraphEdge[];
}

/** 节点点击回调 */
export type NodeClickCallback = (nodeId: string) => void;

/** 节点右键菜单回调 */
export type NodeContextMenuCallback = (nodeId: string, screenX: number, screenY: number) => void;

/** 边点击回调（编辑关系） */
export type EdgeClickCallback = (sourceId: string, targetId: string, type: string, weight: number) => void;

/** 手动连线创建关系回调 */
export type ConnectionCreateCallback = (sourceId: string, targetId: string) => void;

// ─── 渲染常量 ────────────────────────────────────────────────

/** 节点最小半径 */
export const MIN_NODE_RADIUS = 6;
/** 节点最大半径 */
export const MAX_NODE_RADIUS = 18;
/** 边线最小宽度 */
export const MIN_EDGE_WIDTH = 0.5;
/** 边线最大宽度 */
export const MAX_EDGE_WIDTH = 3;
/** 动画帧率（ms） */
export const FRAME_INTERVAL = 16;
/** 最小缩放级别 */
export const MIN_ZOOM = 0.3;
/** 最大缩放级别 */
export const MAX_ZOOM = 3;
/** 滚轮缩放灵敏度（每步缩放因子） */
export const ZOOM_SENSITIVITY = 0.001;
/** 双击缩放重置动画时长（ms） */
export const RESET_ANIM_DURATION = 400;
/** 边点击检测热区半径（像素） */
export const EDGE_HIT_RADIUS = 8;
/** 连线模式提示线虚线间隔 */
export const CONNECTION_LINE_DASH = [6, 4];
/** 冲突脉冲周期（ms） */
export const CONFLICT_PULSE_PERIOD = 1200;
/** 冲突脉冲最小 alpha */
export const CONFLICT_PULSE_MIN_ALPHA = 0.3;
/** 冲突脉冲最大 alpha */
export const CONFLICT_PULSE_MAX_ALPHA = 0.9;
