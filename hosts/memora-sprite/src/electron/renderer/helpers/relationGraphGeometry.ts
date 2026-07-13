/**
 * 记忆关系图谱几何计算（从 relationGraph.ts 提取）
 *
 * 职责：
 *   集中管理图谱渲染所需的几何计算纯函数，降低 relationGraph.ts 体量。涵盖：
 *   - 节点半径计算（根据 score 线性映射）
 *   - 屏幕坐标 ↔ 世界坐标转换（考虑相机偏移 + 缩放）
 *   - 节点命中检测（圆形碰撞，含热区扩展）
 *   - 边命中检测（点到线段最短距离）
 *   - 点到线段距离计算（向量投影法）
 *
 * 提取原因（枝叶层，ADR-017 §枝叶层 2 次提取原则）：
 *   relationGraph.ts 超标（1206 行，超 1200 触发线）。
 *   几何计算（nodeRadius/screenToWorld/findNodeAt/findEdgeAt/pointToSegmentDist）
 *   是纯数学函数，无状态依赖，独立可测试。这是 relationGraph 的第 3 次提取
 *   （layout + color + geometry），已满足枝叶层 2 次提取原则。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过参数注入
 *   - 不依赖 this 上下文，便于独立单元测试
 *   - nodeRadius 因依赖 MIN_NODE_RADIUS/MAX_NODE_RADIUS 常量，封装为本模块内部使用
 *
 * 先例：
 *   参照 relationGraphLayout.ts 的 LayoutContext 依赖注入模式
 *   参照 relationGraphColor.ts 的纯函数 + 常量导出模式
 */

import type { GraphNode, GraphEdge } from './relationGraphTypes.js';
import {
  MIN_NODE_RADIUS,
  MAX_NODE_RADIUS,
  EDGE_HIT_RADIUS,
} from './relationGraphTypes.js';

// ─── 节点半径 ────────────────────────────────────────────────

/**
 * 根据 score 计算节点半径（线性映射）
 *
 * score 在 [0, 1] 范围内线性映射到 [MIN_NODE_RADIUS, MAX_NODE_RADIUS]，
 * 超过 1 的 score 会被截断到 MAX_NODE_RADIUS。
 *
 * @param node 图谱节点（读取 score 字段）
 * @returns 节点半径（像素）
 */
export function nodeRadius(node: GraphNode): number {
  return MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * Math.min(1, node.score);
}

// ─── 坐标转换 ────────────────────────────────────────────────

/**
 * 将屏幕坐标转换为世界坐标（考虑相机偏移 + 缩放）
 *
 * Canvas 渲染时通过 ctx.translate(cameraX, cameraY) + ctx.scale(zoom, zoom)
 * 应用变换，因此世界坐标 = (屏幕坐标 - 相机偏移) / 缩放。
 *
 * @param screenX 相对于 Canvas 左上角的屏幕 X
 * @param screenY 相对于 Canvas 左上角的屏幕 Y
 * @param cameraX 相机 X 偏移（视口平移量）
 * @param cameraY 相机 Y 偏移（视口平移量）
 * @param zoom 当前缩放级别（1 = 原始大小）
 * @returns 世界坐标 { x, y }
 */
export function screenToWorld(
  screenX: number, screenY: number,
  cameraX: number, cameraY: number, zoom: number,
): { x: number; y: number } {
  return {
    x: (screenX - cameraX) / zoom,
    y: (screenY - cameraY) / zoom,
  };
}

// ─── 命中检测 ────────────────────────────────────────────────

/**
 * 根据屏幕坐标查找节点（圆形碰撞检测 + 热区扩展）
 *
 * 遍历所有节点，返回第一个被点击到的节点。检测时在节点半径基础上
 * 额外扩展 4px 热区，提升小节点的可点击性。
 *
 * @param nodes 节点数组
 * @param screenX 屏幕 X 坐标
 * @param screenY 屏幕 Y 坐标
 * @param cameraX 相机 X 偏移
 * @param cameraY 相机 Y 偏移
 * @param zoom 当前缩放级别
 * @returns 命中的节点，未命中返回 null
 */
export function findNodeAt(
  nodes: GraphNode[],
  screenX: number, screenY: number,
  cameraX: number, cameraY: number, zoom: number,
): GraphNode | null {
  const { x, y } = screenToWorld(screenX, screenY, cameraX, cameraY, zoom);
  for (const node of nodes) {
    const r = nodeRadius(node) + 4; // 增加 4px 的热区
    const dx = node.x - x;
    const dy = node.y - y;
    if (dx * dx + dy * dy <= r * r) {
      return node;
    }
  }
  return null;
}

/**
 * 根据屏幕坐标查找边（点到线段距离检测）
 *
 * 返回距离鼠标最近的边，用于点击边触发关系编辑弹窗。
 * 仅检测距离在 EDGE_HIT_RADIUS 范围内的边。
 *
 * @param edges 边数组
 * @param nodeMap nodeId → GraphNode 快速查找表
 * @param screenX 屏幕 X 坐标
 * @param screenY 屏幕 Y 坐标
 * @param cameraX 相机 X 偏移
 * @param cameraY 相机 Y 偏移
 * @param zoom 当前缩放级别
 * @returns 最近的边，未命中返回 null
 */
export function findEdgeAt(
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
  screenX: number, screenY: number,
  cameraX: number, cameraY: number, zoom: number,
): GraphEdge | null {
  const { x, y } = screenToWorld(screenX, screenY, cameraX, cameraY, zoom);
  let closestEdge: GraphEdge | null = null;
  let closestDist = EDGE_HIT_RADIUS;

  for (const edge of edges) {
    const source = nodeMap.get(edge.sourceId);
    const target = nodeMap.get(edge.targetId);
    if (!source || !target) continue;

    // 点到线段距离（数学公式，不依赖 DOM）
    const dist = pointToSegmentDist(x, y, source.x, source.y, target.x, target.y);
    if (dist < closestDist) {
      closestDist = dist;
      closestEdge = edge;
    }
  }
  return closestEdge;
}

// ─── 纯数学函数 ──────────────────────────────────────────────

/**
 * 计算点到线段的最短距离
 *
 * 使用向量投影法，投影参数 t 在 [0,1] 之间时为垂足在线段上，
 * 否则取到端点的距离。
 *
 * @param px 点 X 坐标
 * @param py 点 Y 坐标
 * @param ax 线段起点 X
 * @param ay 线段起点 Y
 * @param bx 线段终点 X
 * @param by 线段终点 Y
 * @returns 点到线段的最短距离
 */
export function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // 线段退化为点
    const ex = px - ax;
    const ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // 投影参数 t（点在线段上的投影位置）
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  // 投影点坐标
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  // 点到投影点的距离
  const ex = px - projX;
  const ey = py - projY;
  return Math.sqrt(ex * ex + ey * ey);
}
