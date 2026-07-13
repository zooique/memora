/**
 * 关系图谱几何计算纯函数测试
 *
 * 覆盖范围：
 * - nodeRadius：根据 score 线性映射节点半径
 * - screenToWorld：屏幕坐标转世界坐标（考虑相机偏移 + 缩放）
 * - findNodeAt：根据坐标查找节点（含热区扩展）
 * - findEdgeAt：根据坐标查找边（点到线段距离检测）
 * - pointToSegmentDist：点到线段最短距离（向量投影法）
 *
 * 纯逻辑测试，无 JSDOM 依赖。
 */
import { describe, it, expect } from 'vitest';
import {
  nodeRadius,
  screenToWorld,
  findNodeAt,
  findEdgeAt,
  pointToSegmentDist,
} from '../../../electron/renderer/helpers/relationGraphGeometry.js';
import {
  MIN_NODE_RADIUS,
  MAX_NODE_RADIUS,
} from '../../../electron/renderer/helpers/relationGraphTypes.js';
import type { GraphNode, GraphEdge } from '../../../electron/renderer/helpers/relationGraphTypes.js';

// ─── 测试夹具 ────────────────────────────────────────────────

/** 构造测试节点（默认坐标 0,0） */
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

/** 构造测试边 */
function makeEdge(sourceId: string, targetId: string): GraphEdge {
  return {
    sourceId,
    targetId,
    type: 'supports',
    weight: 1,
    createdAt: '2026-07-13T00:00:00Z',
  };
}

// ─── nodeRadius ──────────────────────────────────────────────

describe('nodeRadius', () => {
  it('score=0 应返回 MIN_NODE_RADIUS', () => {
    expect(nodeRadius(makeNode({ score: 0 }))).toBe(MIN_NODE_RADIUS);
  });

  it('score=1 应返回 MAX_NODE_RADIUS', () => {
    expect(nodeRadius(makeNode({ score: 1 }))).toBe(MAX_NODE_RADIUS);
  });

  it('score=0.5 应返回中间值', () => {
    const expected = MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * 0.5;
    expect(nodeRadius(makeNode({ score: 0.5 }))).toBe(expected);
  });

  it('score>1 应被截断到 MAX_NODE_RADIUS', () => {
    expect(nodeRadius(makeNode({ score: 2 }))).toBe(MAX_NODE_RADIUS);
    expect(nodeRadius(makeNode({ score: 100 }))).toBe(MAX_NODE_RADIUS);
  });

  it('score<0 应被映射到小于 MIN_NODE_RADIUS 的值（线性外推，不截断下界）', () => {
    // Math.min(1, -1) = -1，因此结果为 MIN + (MAX-MIN) * -1 = MIN - (MAX-MIN)
    const expected = MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * -1;
    expect(nodeRadius(makeNode({ score: -1 }))).toBe(expected);
  });
});

// ─── screenToWorld ───────────────────────────────────────────

describe('screenToWorld', () => {
  it('zoom=1 且无相机偏移时，应原样返回屏幕坐标', () => {
    const result = screenToWorld(100, 200, 0, 0, 1);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('相机 X 偏移 100 时，世界 X 应减 100', () => {
    const result = screenToWorld(150, 200, 100, 0, 1);
    expect(result.x).toBe(50);
    expect(result.y).toBe(200);
  });

  it('相机 Y 偏移 50 时，世界 Y 应减 50', () => {
    const result = screenToWorld(100, 150, 0, 50, 1);
    expect(result.x).toBe(100);
    expect(result.y).toBe(100);
  });

  it('zoom=2 时，世界坐标应除以 2', () => {
    const result = screenToWorld(100, 200, 0, 0, 2);
    expect(result.x).toBe(50);
    expect(result.y).toBe(100);
  });

  it('zoom=0.5 时，世界坐标应乘以 2', () => {
    const result = screenToWorld(100, 200, 0, 0, 0.5);
    expect(result.x).toBe(200);
    expect(result.y).toBe(400);
  });

  it('相机偏移 + 缩放组合应正确计算', () => {
    // 屏幕 (200, 300)，相机 (100, 100)，zoom=2
    // 期望世界 = (200 - 100) / 2 = 50, (300 - 100) / 2 = 100
    const result = screenToWorld(200, 300, 100, 100, 2);
    expect(result.x).toBe(50);
    expect(result.y).toBe(100);
  });
});

// ─── findNodeAt ──────────────────────────────────────────────

describe('findNodeAt', () => {
  it('点击节点中心应命中节点', () => {
    const node = makeNode({ id: 'n1', x: 100, y: 100, score: 1 });
    // score=1 → radius=MAX_NODE_RADIUS=18；点击中心
    const result = findNodeAt([node], 100, 100, 0, 0, 1);
    expect(result).toBe(node);
  });

  it('点击节点边缘（半径内）应命中节点', () => {
    const node = makeNode({ id: 'n1', x: 100, y: 100, score: 1 });
    // radius=18，点击 (100+18, 100) 应命中
    const result = findNodeAt([node], 118, 100, 0, 0, 1);
    expect(result).toBe(node);
  });

  it('点击热区（半径 +4px 内）应命中节点', () => {
    const node = makeNode({ id: 'n1', x: 100, y: 100, score: 1 });
    // radius=18 + 4px 热区 = 22，点击 (100+22, 100) 应命中
    const result = findNodeAt([node], 122, 100, 0, 0, 1);
    expect(result).toBe(node);
  });

  it('点击热区外应返回 null', () => {
    const node = makeNode({ id: 'n1', x: 100, y: 100, score: 1 });
    // radius + 热区 = 22，点击 (100+23, 100) 应未命中
    const result = findNodeAt([node], 123, 100, 0, 0, 1);
    expect(result).toBeNull();
  });

  it('空节点数组应返回 null', () => {
    const result = findNodeAt([], 100, 100, 0, 0, 1);
    expect(result).toBeNull();
  });

  it('多个节点时应返回第一个命中的节点', () => {
    const node1 = makeNode({ id: 'n1', x: 100, y: 100, score: 1 });
    const node2 = makeNode({ id: 'n2', x: 200, y: 200, score: 1 });
    const result = findNodeAt([node1, node2], 100, 100, 0, 0, 1);
    expect(result).toBe(node1);
  });

  it('考虑相机偏移：屏幕坐标 (200,200) + 相机 (100,100) → 世界 (100,100)', () => {
    const node = makeNode({ id: 'n1', x: 100, y: 100, score: 1 });
    const result = findNodeAt([node], 200, 200, 100, 100, 1);
    expect(result).toBe(node);
  });

  it('考虑缩放：zoom=2 时，屏幕 (200,200) → 世界 (100,100)', () => {
    const node = makeNode({ id: 'n1', x: 100, y: 100, score: 1 });
    const result = findNodeAt([node], 200, 200, 0, 0, 2);
    expect(result).toBe(node);
  });
});

// ─── findEdgeAt ──────────────────────────────────────────────

describe('findEdgeAt', () => {
  it('点击边上应返回该边', () => {
    const nodeA = makeNode({ id: 'a', x: 0, y: 0 });
    const nodeB = makeNode({ id: 'b', x: 100, y: 0 });
    const edge = makeEdge('a', 'b');
    const nodeMap = new Map([
      ['a', nodeA],
      ['b', nodeB],
    ]);
    // 边从 (0,0) 到 (100,0)，点击中点 (50, 0) 应命中
    const result = findEdgeAt([edge], nodeMap, 50, 0, 0, 0, 1);
    expect(result).toBe(edge);
  });

  it('点击边附近（热区内）应返回该边', () => {
    const nodeA = makeNode({ id: 'a', x: 0, y: 0 });
    const nodeB = makeNode({ id: 'b', x: 100, y: 0 });
    const edge = makeEdge('a', 'b');
    const nodeMap = new Map([
      ['a', nodeA],
      ['b', nodeB],
    ]);
    // 边在 y=0，点击 (50, 5) 距离 5 < EDGE_HIT_RADIUS(8) 应命中
    const result = findEdgeAt([edge], nodeMap, 50, 5, 0, 0, 1);
    expect(result).toBe(edge);
  });

  it('点击边外（超出热区）应返回 null', () => {
    const nodeA = makeNode({ id: 'a', x: 0, y: 0 });
    const nodeB = makeNode({ id: 'b', x: 100, y: 0 });
    const edge = makeEdge('a', 'b');
    const nodeMap = new Map([
      ['a', nodeA],
      ['b', nodeB],
    ]);
    // 点击 (50, 10) 距离 10 > EDGE_HIT_RADIUS(8) 应未命中
    const result = findEdgeAt([edge], nodeMap, 50, 10, 0, 0, 1);
    expect(result).toBeNull();
  });

  it('点击端点外侧应返回 null（投影 t<0 或 t>1）', () => {
    const nodeA = makeNode({ id: 'a', x: 0, y: 0 });
    const nodeB = makeNode({ id: 'b', x: 100, y: 0 });
    const edge = makeEdge('a', 'b');
    const nodeMap = new Map([
      ['a', nodeA],
      ['b', nodeB],
    ]);
    // 点击 (-50, 0)：垂足在线段外（t<0），距离 50 远超热区
    const result = findEdgeAt([edge], nodeMap, -50, 0, 0, 0, 1);
    expect(result).toBeNull();
  });

  it('空边数组应返回 null', () => {
    const result = findEdgeAt([], new Map(), 50, 0, 0, 0, 1);
    expect(result).toBeNull();
  });

  it('边的端点不存在于 nodeMap 时应跳过该边', () => {
    const edge = makeEdge('a', 'b');
    const nodeMap = new Map(); // 空 map
    const result = findEdgeAt([edge], nodeMap, 50, 0, 0, 0, 1);
    expect(result).toBeNull();
  });

  it('多条边时应返回最近的边', () => {
    const nodeA = makeNode({ id: 'a', x: 0, y: 0 });
    const nodeB = makeNode({ id: 'b', x: 100, y: 0 });
    const nodeC = makeNode({ id: 'c', x: 0, y: 50 });
    const edgeAB = makeEdge('a', 'b');
    const edgeAC = { ...makeEdge('a', 'c'), type: 'contradicts' };
    const nodeMap = new Map([
      ['a', nodeA],
      ['b', nodeB],
      ['c', nodeC],
    ]);
    // 点击 (50, 0)：edgeAB 距离 0，edgeAC 距离较远，应命中 edgeAB
    const result = findEdgeAt([edgeAB, edgeAC], nodeMap, 50, 0, 0, 0, 1);
    expect(result).toBe(edgeAB);
  });
});

// ─── pointToSegmentDist ──────────────────────────────────────

describe('pointToSegmentDist', () => {
  it('点在线段中点上方应返回垂直距离', () => {
    // 线段 (0,0)→(100,0)，点 (50, 10)
    const dist = pointToSegmentDist(50, 10, 0, 0, 100, 0);
    expect(dist).toBe(10);
  });

  it('点在线段上应返回 0', () => {
    const dist = pointToSegmentDist(50, 0, 0, 0, 100, 0);
    expect(dist).toBe(0);
  });

  it('点在线段端点上方应返回垂直距离', () => {
    // 点 (0, 10)，线段 (0,0)→(100,0)，垂足在端点 (0,0)
    const dist = pointToSegmentDist(0, 10, 0, 0, 100, 0);
    expect(dist).toBe(10);
  });

  it('点在线段起点外侧应返回到起点的距离（投影 t<0）', () => {
    // 点 (-30, 40)，线段 (0,0)→(100,0)
    // 投影 t = -30/100 = -0.3，截断为 0，垂足为 (0,0)
    // 距离 = sqrt(30^2 + 40^2) = 50
    const dist = pointToSegmentDist(-30, 40, 0, 0, 100, 0);
    expect(dist).toBe(50);
  });

  it('点在线段终点外侧应返回到终点的距离（投影 t>1）', () => {
    // 点 (130, 40)，线段 (0,0)→(100,0)
    // 投影 t = 130/100 = 1.3，截断为 1，垂足为 (100,0)
    // 距离 = sqrt(30^2 + 40^2) = 50
    const dist = pointToSegmentDist(130, 40, 0, 0, 100, 0);
    expect(dist).toBe(50);
  });

  it('线段退化为点（起终点重合）应返回点到该点的距离', () => {
    // 线段 (50,50)→(50,50)，点 (50, 60)
    const dist = pointToSegmentDist(50, 60, 50, 50, 50, 50);
    expect(dist).toBe(10);
  });

  it('斜线段的垂直距离应正确计算', () => {
    // 线段 (0,0)→(3,4)（长度 5），点 (0, 4)
    // 投影 t = (0*3 + 4*4) / 25 = 16/25 = 0.64
    // 垂足 (3*0.64, 4*0.64) = (1.92, 2.56)
    // 距离 = sqrt((0-1.92)^2 + (4-2.56)^2) = sqrt(3.6864 + 2.0736) = sqrt(5.76) = 2.4
    const dist = pointToSegmentDist(0, 4, 0, 0, 3, 4);
    expect(dist).toBeCloseTo(2.4, 5);
  });

  it('点与线段端点重合应返回 0', () => {
    const dist = pointToSegmentDist(0, 0, 0, 0, 100, 0);
    expect(dist).toBe(0);
  });

  it('点与线段终点重合应返回 0', () => {
    const dist = pointToSegmentDist(100, 0, 0, 0, 100, 0);
    expect(dist).toBe(0);
  });
});
