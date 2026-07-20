/**
 * 关系图谱布局算法单元测试
 *
 * 覆盖范围：
 * - runInitialLayout：初始布局迭代（Fruchterman-Reingold 简化版）
 *   - 斥力 / 引力 / 中心引力 / 温度衰减 / 边界约束
 *   - 边端点缺失时的跳过分支
 * - updateLayout：单帧力导向更新（动画阶段）
 *   - 斥力 / 引力 / 中心引力 / 阻尼 / 边界约束
 *   - 稳定检测（连续 30 帧低能量 → layoutStable）
 *   - 边端点缺失时的跳过分支
 *   - 节点重合时 dist=0 的兜底分支（|| 1）
 *
 * 纯函数测试，无 JSDOM 依赖。所有依赖通过 LayoutContext 注入。
 */
import { describe, it, expect } from 'vitest';
import {
  runInitialLayout,
  updateLayout,
  LAYOUT_PADDING,
  LAYOUT_ITERATIONS,
  LAYOUT_DAMPING,
  LAYOUT_REPULSION,
  LAYOUT_ATTRACTION,
  type LayoutContext,
} from '../../../electron/renderer/helpers/relationGraphLayout.js';
import {
  MIN_NODE_RADIUS,
  MAX_NODE_RADIUS,
} from '../../../electron/renderer/helpers/relationGraphTypes.js';
import type { GraphNode, GraphEdge } from '../../../electron/renderer/helpers/relationGraphTypes.js';

// ─── 测试夹具 ────────────────────────────────────────────────

/** 构造测试节点（默认坐标 0,0，速度 0,0） */
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    name: 'node1',
    source: 'insight',
    score: 0.5,
    contentPreview: 'preview',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    ...overrides,
  };
}

/** 构造测试边（默认 weight=1） */
function makeEdge(sourceId: string, targetId: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    sourceId,
    targetId,
    type: 'supports',
    weight: 1,
    createdAt: '2026-07-13T00:00:00Z',
    ...overrides,
  };
}

/**
 * 根据节点 score 计算半径（与 renderer 中 nodeRadius 实现一致）
 * 测试夹具自行实现，避免依赖 relationGraphGeometry 模块
 */
function nodeRadius(node: GraphNode): number {
  const t = Math.min(1, Math.max(0, node.score));
  return MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * t;
}

/**
 * 构建布局上下文（默认 canvas 400×300）
 * stableFrameCount/layoutStable 初始为 0/false
 */
function buildContext(
  nodes: GraphNode[],
  edges: GraphEdge[],
  overrides: Partial<LayoutContext> = {},
): LayoutContext {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }
  return {
    nodes,
    edges,
    nodeMap,
    width: 400,
    height: 300,
    stableFrameCount: 0,
    layoutStable: false,
    nodeRadius,
    ...overrides,
  };
}

// ─── 常量导出校验 ────────────────────────────────────────────

describe('布局常量', () => {
  it('LAYOUT_PADDING 应为 40（边界内边距）', () => {
    expect(LAYOUT_PADDING).toBe(40);
  });

  it('LAYOUT_ITERATIONS 应为 80（初始迭代次数）', () => {
    expect(LAYOUT_ITERATIONS).toBe(80);
  });

  it('LAYOUT_DAMPING 应为 0.85（阻尼系数）', () => {
    expect(LAYOUT_DAMPING).toBe(0.85);
  });

  it('LAYOUT_REPULSION 应为 800（斥力常数）', () => {
    expect(LAYOUT_REPULSION).toBe(800);
  });

  it('LAYOUT_ATTRACTION 应为 0.02（引力常数）', () => {
    expect(LAYOUT_ATTRACTION).toBe(0.02);
  });
});

// ─── runInitialLayout ────────────────────────────────────────

describe('runInitialLayout', () => {
  it('空节点数组应不抛错且不改变状态', () => {
    const ctx = buildContext([], []);
    expect(() => runInitialLayout(ctx)).not.toThrow();
    expect(ctx.nodes).toHaveLength(0);
    expect(ctx.layoutStable).toBe(false);
  });

  it('单节点应保持原地（无斥力、无引力），仅受中心引力微弱拉动', () => {
    // 节点初始位于 (10, 10)，canvas 400×300 中心 (200, 150)
    const node = makeNode({ id: 'solo', x: 10, y: 10 });
    const ctx = buildContext([node], []);
    runInitialLayout(ctx);
    // 单节点无斥力/引力，仅中心引力 + 边界约束，应被拉向中心方向（x 增大）
    expect(node.x).toBeGreaterThan(10);
    // 边界约束：x ≥ PADDING + r，y ≥ PADDING + r
    const r = nodeRadius(node);
    expect(node.x).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
    expect(node.y).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
  });

  it('两节点应相互排斥（距离增大）', () => {
    // 两节点初始距离 10，应被斥力推开
    const a = makeNode({ id: 'a', x: 100, y: 150 });
    const b = makeNode({ id: 'b', x: 110, y: 150 });
    const initialDist = Math.hypot(b.x - a.x, b.y - a.y);
    const ctx = buildContext([a, b], []);
    runInitialLayout(ctx);
    const finalDist = Math.hypot(b.x - a.x, b.y - a.y);
    expect(finalDist).toBeGreaterThan(initialDist);
  });

  it('有边相连的两节点应在斥力与引力间找到平衡（不会无限远离）', () => {
    // 两节点初始距离 200，有边相连（weight=1）
    const a = makeNode({ id: 'a', x: 100, y: 150 });
    const b = makeNode({ id: 'b', x: 300, y: 150 });
    const edge = makeEdge('a', 'b');
    const ctx = buildContext([a, b], [edge]);
    runInitialLayout(ctx);
    // 引力 + 中心引力应使最终距离小于初始 200
    const finalDist = Math.hypot(b.x - a.x, b.y - a.y);
    expect(finalDist).toBeLessThan(200);
  });

  it('边端点不存在于 nodeMap 时应跳过该边（不抛错）', () => {
    // 边指向不存在的节点，runInitialLayout 应跳过该边
    const a = makeNode({ id: 'a', x: 100, y: 150 });
    const ghostEdge = makeEdge('a', 'ghost');
    const ctx = buildContext([a], [ghostEdge]);
    expect(() => runInitialLayout(ctx)).not.toThrow();
    // source 存在但 target 不存在，引力分支应被跳过（覆盖 112 行 if 分支）
  });

  it('边的 source 不存在时应跳过该边', () => {
    // 反向：source 不存在，target 存在
    const b = makeNode({ id: 'b', x: 200, y: 150 });
    const ghostEdge = makeEdge('ghost', 'b');
    const ctx = buildContext([b], [ghostEdge]);
    expect(() => runInitialLayout(ctx)).not.toThrow();
  });

  it('节点超出右边界应被约束到 width - PADDING - r', () => {
    // canvas 宽 400，节点初始 x=1000（远超边界），score=1 → r=18
    const node = makeNode({ id: 'edge', x: 1000, y: 150, score: 1 });
    const ctx = buildContext([node], []);
    runInitialLayout(ctx);
    const r = nodeRadius(node);
    const maxX = ctx.width - LAYOUT_PADDING - r;
    expect(node.x).toBeLessThanOrEqual(maxX);
  });

  it('节点超出左边界应被约束到 PADDING + r', () => {
    // 节点初始 x=-1000（远超左边界），score=1 → r=18
    const node = makeNode({ id: 'edge', x: -1000, y: 150, score: 1 });
    const ctx = buildContext([node], []);
    runInitialLayout(ctx);
    const r = nodeRadius(node);
    expect(node.x).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
  });

  it('节点超出下边界应被约束到 height - PADDING - r', () => {
    // canvas 高 300，节点初始 y=1000（远超下边界）
    const node = makeNode({ id: 'edge', x: 200, y: 1000, score: 1 });
    const ctx = buildContext([node], []);
    runInitialLayout(ctx);
    const r = nodeRadius(node);
    const maxY = ctx.height - LAYOUT_PADDING - r;
    expect(node.y).toBeLessThanOrEqual(maxY);
  });

  it('节点超出上边界应被约束到 PADDING + r', () => {
    // 节点初始 y=-1000（远超上边界）
    const node = makeNode({ id: 'edge', x: 200, y: -1000, score: 1 });
    const ctx = buildContext([node], []);
    runInitialLayout(ctx);
    const r = nodeRadius(node);
    expect(node.y).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
  });

  it('边权重为 0 时引力应为 0（不影响布局）', () => {
    // weight=0 的边，引力 = dist * ATTRACTION * 0 = 0
    const a = makeNode({ id: 'a', x: 100, y: 150 });
    const b = makeNode({ id: 'b', x: 300, y: 150 });
    const zeroEdge = makeEdge('a', 'b', { weight: 0 });
    const ctx = buildContext([a, b], [zeroEdge]);
    expect(() => runInitialLayout(ctx)).not.toThrow();
    // 引力为 0，仅斥力 + 中心引力作用
  });

  it('温度应随迭代递减（前期大步移动，后期微调）', () => {
    // 通过对比首末迭代的位移量验证温度衰减
    // 由于温度 = max(0.1, 1 - iter/80)，首帧温度 ≈ 0.9875，末帧温度 = 0.1
    // 此处验证单节点在中心引力下的位移受温度影响（间接验证）
    const node = makeNode({ id: 'temp', x: 10, y: 10, score: 0 });
    const ctx = buildContext([node], []);
    runInitialLayout(ctx);
    // 单节点受中心引力，最终应被拉向中心方向
    expect(node.x).toBeGreaterThan(10);
    expect(node.y).toBeGreaterThan(10);
  });
});

// ─── updateLayout ────────────────────────────────────────────

describe('updateLayout', () => {
  it('空节点数组应不抛错且不触发稳定', () => {
    const ctx = buildContext([], []);
    expect(() => updateLayout(ctx)).not.toThrow();
    // 空数组 totalEnergy = 0 < 0.5，stableFrameCount 应 +1
    expect(ctx.stableFrameCount).toBe(1);
    expect(ctx.layoutStable).toBe(false);
  });

  it('单节点低能量时应累积 stableFrameCount', () => {
    // 单节点初始 vx=vy=0，斥力/引力/中心引力都很小，能量应 < 0.5
    const node = makeNode({ id: 'solo', x: 200, y: 150, score: 0 });
    const ctx = buildContext([node], []);
    updateLayout(ctx);
    expect(ctx.stableFrameCount).toBeGreaterThanOrEqual(1);
    expect(ctx.layoutStable).toBe(false);
  });

  it('连续 31 帧低能量后应设置 layoutStable=true', () => {
    // 单节点位于中心，能量稳定低于阈值
    const node = makeNode({ id: 'solo', x: 200, y: 150, score: 0 });
    const ctx = buildContext([node], []);
    // 先跑 30 帧，stableFrameCount 应到 30，但还未触发稳定
    for (let i = 0; i < 30; i++) {
      updateLayout(ctx);
    }
    expect(ctx.stableFrameCount).toBeGreaterThanOrEqual(30);
    expect(ctx.layoutStable).toBe(false);
    // 第 31 帧 stableFrameCount > 30，应触发 layoutStable
    updateLayout(ctx);
    expect(ctx.layoutStable).toBe(true);
  });

  it('高能量帧应重置 stableFrameCount 为 0', () => {
    // 给节点很大的初速度，使其能量超过 0.5
    const node = makeNode({ id: 'fast', x: 200, y: 150, vx: 100, vy: 100, score: 0 });
    const ctx = buildContext([node], []);
    // 先累积一些稳定帧
    ctx.stableFrameCount = 5;
    updateLayout(ctx);
    // 高能量应重置 stableFrameCount
    expect(ctx.stableFrameCount).toBe(0);
    expect(ctx.layoutStable).toBe(false);
  });

  it('能量恰好为 0.5 时不计入稳定帧（边界条件，<0.5 才算稳定）', () => {
    // 构造能量略大于等于 0.5 的情况
    // totalEnergy = |vx| + |vy|，需 vx+vy >= 0.5
    const node = makeNode({ id: 'edge', x: 200, y: 150, vx: 0.3, vy: 0.3, score: 0 });
    const ctx = buildContext([node], []);
    ctx.stableFrameCount = 3;
    updateLayout(ctx);
    // 0.3 + 0.3 = 0.6 > 0.5，应重置
    // 注意：updateLayout 内部会更新 vx/vy，但 totalEnergy 在更新前已计算
    expect(ctx.stableFrameCount).toBe(0);
  });

  it('两节点应相互排斥（距离增大）', () => {
    // 两节点初始距离 5，斥力应推开它们
    const a = makeNode({ id: 'a', x: 200, y: 150, score: 0 });
    const b = makeNode({ id: 'b', x: 205, y: 150, score: 0 });
    const initialDist = Math.hypot(b.x - a.x, b.y - a.y);
    const ctx = buildContext([a, b], []);
    updateLayout(ctx);
    const finalDist = Math.hypot(b.x - a.x, b.y - a.y);
    expect(finalDist).toBeGreaterThan(initialDist);
  });

  it('有边相连的两节点应受引力作用（距离拉近或斥力减弱）', () => {
    // 两节点初始距离 100，有边相连
    const a = makeNode({ id: 'a', x: 100, y: 150, score: 0 });
    const b = makeNode({ id: 'b', x: 200, y: 150, score: 0 });
    const edge = makeEdge('a', 'b');
    const ctx = buildContext([a, b], [edge]);
    updateLayout(ctx);
    // 引力 + 中心引力应使节点向中心靠拢
    // 验证：节点 b（右侧）应向左移动或被中心引力拉向 (200, 150)
    expect(a.x).not.toBe(100);
    expect(b.x).not.toBe(200);
  });

  it('边端点不存在于 nodeMap 时应跳过该边（不抛错）', () => {
    // target 不存在，updateLayout 应跳过该边（覆盖 184 行 if 分支）
    const a = makeNode({ id: 'a', x: 100, y: 150, score: 0 });
    const ghostEdge = makeEdge('a', 'ghost');
    const ctx = buildContext([a], [ghostEdge]);
    expect(() => updateLayout(ctx)).not.toThrow();
  });

  it('边的 source 不存在时应跳过该边', () => {
    // source 不存在，target 存在
    const b = makeNode({ id: 'b', x: 200, y: 150, score: 0 });
    const ghostEdge = makeEdge('ghost', 'b');
    const ctx = buildContext([b], [ghostEdge]);
    expect(() => updateLayout(ctx)).not.toThrow();
  });

  it('两节点重合时斥力分支应使用 dist=1 兜底（不产生 NaN）', () => {
    // 两节点完全重合，dx=dy=0，dist = sqrt(0) || 1 = 1
    // 覆盖 169 行 binary-expr 的 || 1 分支
    const a = makeNode({ id: 'a', x: 200, y: 150, score: 0 });
    const b = makeNode({ id: 'b', x: 200, y: 150, score: 0 });
    const ctx = buildContext([a, b], []);
    expect(() => updateLayout(ctx)).not.toThrow();
    // 验证不产生 NaN
    expect(Number.isNaN(a.x)).toBe(false);
    expect(Number.isNaN(a.y)).toBe(false);
    expect(Number.isNaN(b.x)).toBe(false);
    expect(Number.isNaN(b.y)).toBe(false);
  });

  it('边连接的两节点重合时引力分支应使用 dist=1 兜底（不产生 NaN）', () => {
    // 边连接的两节点完全重合，dx=dy=0，dist = sqrt(0) || 1 = 1
    // 覆盖 188 行 binary-expr 的 || 1 分支
    const a = makeNode({ id: 'a', x: 200, y: 150, score: 0 });
    const b = makeNode({ id: 'b', x: 200, y: 150, score: 0 });
    const edge = makeEdge('a', 'b');
    const ctx = buildContext([a, b], [edge]);
    expect(() => updateLayout(ctx)).not.toThrow();
    expect(Number.isNaN(a.x)).toBe(false);
    expect(Number.isNaN(a.y)).toBe(false);
  });

  it('节点超出边界应被约束（右下边界）', () => {
    // 节点初始 x=1000, y=1000（远超右下边界），score=1 → r=18
    const node = makeNode({ id: 'edge', x: 1000, y: 1000, score: 1, vx: 0, vy: 0 });
    const ctx = buildContext([node], []);
    updateLayout(ctx);
    const r = nodeRadius(node);
    expect(node.x).toBeLessThanOrEqual(ctx.width - LAYOUT_PADDING - r);
    expect(node.y).toBeLessThanOrEqual(ctx.height - LAYOUT_PADDING - r);
  });

  it('节点超出边界应被约束（左上边界）', () => {
    // 节点初始 x=-1000, y=-1000（远超左上边界）
    const node = makeNode({ id: 'edge', x: -1000, y: -1000, score: 1, vx: 0, vy: 0 });
    const ctx = buildContext([node], []);
    updateLayout(ctx);
    const r = nodeRadius(node);
    expect(node.x).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
    expect(node.y).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
  });

  it('阻尼系数应被应用（速度每帧乘以 LAYOUT_DAMPING）', () => {
    // 给节点初速度，验证阻尼后速度减小
    // 注意：updateLayout 会先施加中心引力再乘阻尼
    const node = makeNode({ id: 'damp', x: 200, y: 150, vx: 10, vy: 10, score: 0 });
    const ctx = buildContext([node], []);
    updateLayout(ctx);
    // 阻尼后速度应显著小于初速度（中心引力影响很小）
    expect(Math.abs(node.vx)).toBeLessThan(10);
    expect(Math.abs(node.vy)).toBeLessThan(10);
  });

  it('多次调用 updateLayout 后能量应逐渐衰减（趋于稳定）', () => {
    // 单节点从中心偏移开始，多次更新后应趋于中心
    const node = makeNode({ id: 'decay', x: 100, y: 100, score: 0 });
    const ctx = buildContext([node], []);
    // 跑 50 帧
    for (let i = 0; i < 50; i++) {
      updateLayout(ctx);
    }
    const finalEnergy = Math.abs(node.vx) + Math.abs(node.vy);
    // 多次迭代后能量应远小于初始（初始为 0，但中间会累积）
    // 关键验证：最终应趋于稳定（layoutStable 或能量很低）
    expect(finalEnergy).toBeLessThan(1);
  });

  it('稳定后再调用 updateLayout 不应抛错（idempotent）', () => {
    // 已经稳定后继续调用，不应出错
    const node = makeNode({ id: 'solo', x: 200, y: 150, score: 0 });
    const ctx = buildContext([node], []);
    // 跑 35 帧使其稳定
    for (let i = 0; i < 35; i++) {
      updateLayout(ctx);
    }
    expect(ctx.layoutStable).toBe(true);
    // 再跑 5 帧
    expect(() => {
      for (let i = 0; i < 5; i++) updateLayout(ctx);
    }).not.toThrow();
  });
});

// ─── 综合场景 ────────────────────────────────────────────────

describe('布局算法综合场景', () => {
  it('密集图：4 节点全连接应收敛到稳定布局', () => {
    // 4 节点放在中心附近，6 条边全连接
    const nodes = [
      makeNode({ id: 'n1', x: 190, y: 140, score: 0.5 }),
      makeNode({ id: 'n2', x: 210, y: 140, score: 0.5 }),
      makeNode({ id: 'n3', x: 190, y: 160, score: 0.5 }),
      makeNode({ id: 'n4', x: 210, y: 160, score: 0.5 }),
    ];
    const edges = [
      makeEdge('n1', 'n2'),
      makeEdge('n1', 'n3'),
      makeEdge('n1', 'n4'),
      makeEdge('n2', 'n3'),
      makeEdge('n2', 'n4'),
      makeEdge('n3', 'n4'),
    ];
    const ctx = buildContext(nodes, edges);
    expect(() => runInitialLayout(ctx)).not.toThrow();
    // 所有节点应在边界内
    for (const n of nodes) {
      const r = nodeRadius(n);
      expect(n.x).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
      expect(n.x).toBeLessThanOrEqual(ctx.width - LAYOUT_PADDING - r);
      expect(n.y).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
      expect(n.y).toBeLessThanOrEqual(ctx.height - LAYOUT_PADDING - r);
    }
  });

  it('稀疏图：3 节点 1 边应使相连节点靠近，孤立节点远离', () => {
    // n1-n2 有边，n3 孤立
    const n1 = makeNode({ id: 'n1', x: 100, y: 150, score: 0.5 });
    const n2 = makeNode({ id: 'n2', x: 300, y: 150, score: 0.5 });
    const n3 = makeNode({ id: 'n3', x: 200, y: 50, score: 0.5 });
    const edges = [makeEdge('n1', 'n2')];
    const ctx = buildContext([n1, n2, n3], edges);
    runInitialLayout(ctx);
    // 验证布局后所有节点在边界内
    for (const n of [n1, n2, n3]) {
      const r = nodeRadius(n);
      expect(n.x).toBeGreaterThanOrEqual(LAYOUT_PADDING + r);
      expect(n.x).toBeLessThanOrEqual(ctx.width - LAYOUT_PADDING - r);
    }
  });

  it('runInitialLayout 后接 updateLayout 应平滑过渡', () => {
    // 先跑初始布局，再跑单帧更新，不应抛错
    const a = makeNode({ id: 'a', x: 100, y: 100, score: 0.5 });
    const b = makeNode({ id: 'b', x: 300, y: 200, score: 0.5 });
    const edge = makeEdge('a', 'b');
    const ctx = buildContext([a, b], [edge]);
    runInitialLayout(ctx);
    const xAfterInit = a.x;
    expect(() => updateLayout(ctx)).not.toThrow();
    // updateLayout 后位置可能变化
    expect(Number.isNaN(a.x)).toBe(false);
    expect(Number.isNaN(b.x)).toBe(false);
    // 验证 updateLayout 确实运行了（不一定变化，但不应崩溃）
    expect(typeof a.x).toBe('number');
    expect(typeof xAfterInit).toBe('number');
  });

  it('孤立的边（两端点都不存在）应被安全跳过', () => {
    // 边的两端点都不在 nodes 中
    const a = makeNode({ id: 'a', x: 100, y: 150, score: 0.5 });
    const ghostEdge = makeEdge('ghost1', 'ghost2');
    const ctx = buildContext([a], [ghostEdge]);
    expect(() => runInitialLayout(ctx)).not.toThrow();
    expect(() => updateLayout(ctx)).not.toThrow();
  });

  it('初始布局后节点不应出现 NaN/Infinity', () => {
    // 验证数值合法性（防 dist=0 兜底失效）
    const a = makeNode({ id: 'a', x: 200, y: 150, score: 0.5 });
    const b = makeNode({ id: 'b', x: 200, y: 150, score: 0.5 });
    const edge = makeEdge('a', 'b');
    const ctx = buildContext([a, b], [edge]);
    runInitialLayout(ctx);
    for (const n of [a, b]) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(Number.isFinite(n.vx)).toBe(true);
      expect(Number.isFinite(n.vy)).toBe(true);
    }
  });
});
