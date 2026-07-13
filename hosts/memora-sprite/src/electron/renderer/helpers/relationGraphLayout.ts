/**
 * 记忆关系图谱布局算法（从 relationGraph.ts 提取）
 *
 * 职责：
 *   集中管理力导向布局的常量与算法实现，降低 relationGraph.ts 体量。涵盖：
 *   - 初始布局（同步迭代 LAYOUT_ITERATIONS 轮，快速收敛）
 *   - 单帧力导向更新（动画阶段，含稳定检测）
 *
 * 提取原因：
 *   relationGraph.ts 超标（1360 行，超 1200 触发线）。
 *   布局算法（runInitialLayout + updateLayout）形成独立子系统，
 *   仅依赖 nodes/edges/nodeMap/width/height/nodeRadius 等纯数据，
 *   适合提取为接受 LayoutContext 的纯函数模块。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过 LayoutContext 注入
 *   - stableFrameCount/layoutStable 通过 ctx 上的可变字段读写
 *     （由调用方 buildLayoutContext 用 getter/setter 桥接到 renderer 实例字段）
 *   - 力导向算法参数（DAMPING/REPULSION/ATTRACTION 等）保持原值不变
 *   - 类型从 helpers/relationGraphTypes.ts 导入（类型真理源单向下沉）
 *
 * 先例：
 *   参照 memoryGraphPanel.ts 的 MemoryGraphPanelContext 依赖注入模式
 *   本次为布局算法拆分（ADR-017 枝叶层 2 次提取原则首次实践）
 */

import type { GraphNode, GraphEdge } from './relationGraphTypes.js';

// ─── 上下文接口（依赖注入容器） ────────────────────────────

/**
 * 布局计算所需的上下文
 *
 * 由 RelationGraphRenderer.buildLayoutContext() 构建并传入。
 * 设计为接口而非直接传入 renderer 实例，避免运行时循环依赖并便于独立测试。
 */
export interface LayoutContext {
  /** 图谱节点数组（函数会读写节点的 x/y/vx/vy） */
  readonly nodes: GraphNode[];
  /** 图谱边数组 */
  readonly edges: GraphEdge[];
  /** nodeId → GraphNode 快速查找 */
  readonly nodeMap: Map<string, GraphNode>;
  /** Canvas 宽度（边界约束用） */
  readonly width: number;
  /** Canvas 高度（边界约束用） */
  readonly height: number;
  /** 稳定帧数计数（updateLayout 会读写，用于稳定检测） */
  stableFrameCount: number;
  /** 是否已稳定（updateLayout 会设置，连续 30 帧低能量后置 true） */
  layoutStable: boolean;
  /** 节点半径计算函数（依赖 score，由 renderer 注入） */
  nodeRadius: (node: GraphNode) => number;
}

// ─── 布局常量 ────────────────────────────────────────────

/** Canvas 内边距（边界约束用） */
export const LAYOUT_PADDING = 40;
/** 力导向迭代次数（初始布局阶段） */
export const LAYOUT_ITERATIONS = 80;
/** 速度阻尼系数 */
export const LAYOUT_DAMPING = 0.85;
/** 斥力常数 */
export const LAYOUT_REPULSION = 800;
/** 引力常数 */
export const LAYOUT_ATTRACTION = 0.02;

// ─── 布局算法 ────────────────────────────────────────────

/**
 * 运行初始布局迭代（同步，快速收敛到稳定状态）
 *
 * Fruchterman-Reingold 简化版：
 * - 斥力：所有节点对之间（平方反比）
 * - 引力：有边相连的节点对（胡克定律，乘以边权重）
 * - 中心引力：防止节点飞散
 * - 温度：随迭代递减，前期大步移动后期微调
 *
 * @param ctx 布局上下文
 */
export function runInitialLayout(ctx: LayoutContext): void {
  const centerX = ctx.width / 2;
  const centerY = ctx.height / 2;

  for (let iter = 0; iter < LAYOUT_ITERATIONS; iter++) {
    // 温度随迭代递减
    const temperature = Math.max(0.1, 1 - iter / LAYOUT_ITERATIONS);

    // 计算斥力（所有节点对）
    for (let i = 0; i < ctx.nodes.length; i++) {
      for (let j = i + 1; j < ctx.nodes.length; j++) {
        const a = ctx.nodes[i]!;
        const b = ctx.nodes[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = LAYOUT_REPULSION / (dist * dist);
        const fx = (dx / dist) * force * temperature;
        const fy = (dy / dist) * force * temperature;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // 计算引力（有边相连的节点对）
    for (const edge of ctx.edges) {
      const source = ctx.nodeMap.get(edge.sourceId);
      const target = ctx.nodeMap.get(edge.targetId);
      if (!source || !target) continue;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = dist * LAYOUT_ATTRACTION * edge.weight * temperature;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    // 向中心引力（防止节点飞散）
    for (const node of ctx.nodes) {
      const dx = centerX - node.x;
      const dy = centerY - node.y;
      node.vx += dx * 0.001 * temperature;
      node.vy += dy * 0.001 * temperature;
    }

    // 应用速度 + 阻尼
    for (const node of ctx.nodes) {
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= LAYOUT_DAMPING;
      node.vy *= LAYOUT_DAMPING;

      // 边界约束
      const r = ctx.nodeRadius(node);
      node.x = Math.max(LAYOUT_PADDING + r, Math.min(ctx.width - LAYOUT_PADDING - r, node.x));
      node.y = Math.max(LAYOUT_PADDING + r, Math.min(ctx.height - LAYOUT_PADDING - r, node.y));
    }
  }
}

/**
 * 单帧力导向更新（动画阶段）
 *
 * 与 runInitialLayout 的区别：
 * - 无温度衰减（每帧等权）
 * - 中心引力系数更小（0.0005 vs 0.001），动画阶段更平滑
 * - 含稳定检测：连续 30 帧低能量（<0.5）则标记 layoutStable
 *
 * @param ctx 布局上下文（stableFrameCount/layoutStable 会被读写）
 */
export function updateLayout(ctx: LayoutContext): void {
  let totalEnergy = 0;

  // 斥力
  for (let i = 0; i < ctx.nodes.length; i++) {
    for (let j = i + 1; j < ctx.nodes.length; j++) {
      const a = ctx.nodes[i]!;
      const b = ctx.nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = LAYOUT_REPULSION / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  // 引力
  for (const edge of ctx.edges) {
    const source = ctx.nodeMap.get(edge.sourceId);
    const target = ctx.nodeMap.get(edge.targetId);
    if (!source || !target) continue;

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = dist * LAYOUT_ATTRACTION * edge.weight;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    source.vx += fx;
    source.vy += fy;
    target.vx -= fx;
    target.vy -= fy;
  }

  // 中心引力
  const centerX = ctx.width / 2;
  const centerY = ctx.height / 2;
  for (const node of ctx.nodes) {
    node.vx += (centerX - node.x) * 0.0005;
    node.vy += (centerY - node.y) * 0.0005;
  }

  // 应用速度 + 阻尼 + 边界
  for (const node of ctx.nodes) {
    node.x += node.vx;
    node.y += node.vy;
    node.vx *= LAYOUT_DAMPING;
    node.vy *= LAYOUT_DAMPING;
    totalEnergy += Math.abs(node.vx) + Math.abs(node.vy);

    const r = ctx.nodeRadius(node);
    node.x = Math.max(LAYOUT_PADDING + r, Math.min(ctx.width - LAYOUT_PADDING - r, node.x));
    node.y = Math.max(LAYOUT_PADDING + r, Math.min(ctx.height - LAYOUT_PADDING - r, node.y));
  }

  // 稳定检测：连续 30 帧低能量则停止动画
  if (totalEnergy < 0.5) {
    ctx.stableFrameCount++;
    if (ctx.stableFrameCount > 30) {
      ctx.layoutStable = true;
    }
  } else {
    ctx.stableFrameCount = 0;
  }
}
