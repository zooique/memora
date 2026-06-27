/**
 * 记忆关系图谱渲染器 — Canvas 2D 力导向图
 *
 * 职责：
 * - 将记忆节点和关系边渲染为交互式力导向图谱
 * - 节点：圆形，大小由 score 决定，颜色由 source 决定
 * - 边：线条，粗细由 weight 决定，颜色由 type 决定
 * - 支持节点拖拽和点击查看详情
 *
 * 设计原则：
 * - 零外部依赖：纯 Canvas 2D + 手写力导向布局
 * - 降级友好：数据为空时显示空状态，不阻塞
 * - 性能优先：requestAnimationFrame 驱动，节点数>200 时自动降采样
 *
 * 力导向算法参考：Fruchterman-Reingold 简化版
 * - 斥力：所有节点对之间（平方反比）
 * - 引力：有边相连的节点之间（胡克定律）
 * - 阻尼：每帧速度衰减 0.85
 */

// ─── 类型定义 ────────────────────────────────────────────────

/** 图谱节点（来自 MemoryListItem） */
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

/** 图谱原始数据 */
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

// ─── 常量 ────────────────────────────────────────────────────

/** Canvas 内边距 */
const PADDING = 40;
/** 节点最小半径 */
const MIN_NODE_RADIUS = 6;
/** 节点最大半径 */
const MAX_NODE_RADIUS = 18;
/** 力导向迭代次数（初始布局阶段） */
const LAYOUT_ITERATIONS = 80;
/** 速度阻尼系数 */
const DAMPING = 0.85;
/** 斥力常数 */
const REPULSION = 800;
/** 引力常数 */
const ATTRACTION = 0.02;
/** 边线最小宽度 */
const MIN_EDGE_WIDTH = 0.5;
/** 边线最大宽度 */
const MAX_EDGE_WIDTH = 3;
/** 动画帧率（ms） */
const FRAME_INTERVAL = 16;

// ─── 颜色映射 ────────────────────────────────────────────────

/** source → 节点填充色（CSS 变量引用） */
const SOURCE_COLORS: Record<string, string> = {
  profile: '#34c759',
  insight: '#0066ff',
  guardrail: '#ad1457',
  skill: '#ff9f0a',
  rule: '#7b1fa2',
  persona: '#00838f',
  session: '#e65100',
};

/** 默认节点颜色 */
const DEFAULT_NODE_COLOR = '#a1a1a6';

/** type → 边线颜色 */
const EDGE_TYPE_COLORS: Record<string, string> = {
  contradicts: '#ff3b30',
  supports: '#34c759',
  follows: '#0066ff',
  refines: '#ff9f0a',
  caused: '#7b1fa2',
  related: '#a1a1a6',
};

/** 默认边线颜色 */
const DEFAULT_EDGE_COLOR = '#a1a1a6';

// ─── 力导向图谱渲染器 ────────────────────────────────────────

export class RelationGraphRenderer {
  // 数据
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  /** nodeId → GraphNode 快速查找 */
  private nodeMap = new Map<string, GraphNode>();

  // Canvas
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;

  // 交互状态
  /** 当前拖拽的节点 */
  private dragNode: GraphNode | null = null;
  /** 鼠标悬停的节点 */
  private hoverNode: GraphNode | null = null;
  /** 拖拽偏移量 */
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  // 动画
  private animFrameId: number | null = null;
  /** 布局是否已稳定 */
  private layoutStable = false;
  /** 布局稳定后的静止帧计数器 */
  private stableFrameCount = 0;

  // 回调
  private onNodeClick: NodeClickCallback | null = null;

  // 高 DPI 缩放
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 上下文不可用');
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;

    this.bindEvents();
  }

  // ─── 公开 API ──────────────────────────────────────────────

  /** 设置节点点击回调 */
  setOnNodeClick(cb: NodeClickCallback): void {
    this.onNodeClick = cb;
  }

  /**
   * 加载图谱数据并启动布局
   *
   * @param data 图谱原始数据（nodes + edges）
   */
  loadData(data: RelationGraphData): void {
    // 停止当前动画
    this.stopAnimation();

    // 构建节点（附带初始随机位置）
    this.nodes = data.nodes.map((n) => ({
      ...n,
      x: Math.random() * 100 - 50,
      y: Math.random() * 100 - 50,
      vx: 0,
      vy: 0,
    }));
    this.edges = data.edges;
    this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
    this.layoutStable = false;
    this.stableFrameCount = 0;

    // 调整 Canvas 尺寸
    this.resize();

    // 如果没有数据，直接渲染空状态
    if (this.nodes.length === 0) {
      this.renderEmpty();
      return;
    }

    // 运行初始布局（同步迭代，快速收敛）
    this.runInitialLayout();

    // 启动动画循环
    this.startAnimation();
  }

  /** 销毁渲染器，清理资源 */
  destroy(): void {
    this.stopAnimation();
    this.unbindEvents();
  }

  // ─── 布局算法 ──────────────────────────────────────────────

  /** 运行初始布局迭代（同步，快速收敛到稳定状态） */
  private runInitialLayout(): void {
    const centerX = this.width / 2;
    const centerY = this.height / 2;

    for (let iter = 0; iter < LAYOUT_ITERATIONS; iter++) {
      // 温度随迭代递减
      const temperature = Math.max(0.1, 1 - iter / LAYOUT_ITERATIONS);

      // 计算斥力（所有节点对）
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + 1; j < this.nodes.length; j++) {
          const a = this.nodes[i];
          const b = this.nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = REPULSION / (dist * dist);
          const fx = (dx / dist) * force * temperature;
          const fy = (dy / dist) * force * temperature;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }

      // 计算引力（有边相连的节点对）
      for (const edge of this.edges) {
        const source = this.nodeMap.get(edge.sourceId);
        const target = this.nodeMap.get(edge.targetId);
        if (!source || !target) continue;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * ATTRACTION * edge.weight * temperature;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }

      // 向中心引力（防止节点飞散）
      for (const node of this.nodes) {
        const dx = centerX - node.x;
        const dy = centerY - node.y;
        node.vx += dx * 0.001 * temperature;
        node.vy += dy * 0.001 * temperature;
      }

      // 应用速度 + 阻尼
      for (const node of this.nodes) {
        node.x += node.vx;
        node.y += node.vy;
        node.vx *= DAMPING;
        node.vy *= DAMPING;

        // 边界约束
        const r = this.nodeRadius(node);
        node.x = Math.max(PADDING + r, Math.min(this.width - PADDING - r, node.x));
        node.y = Math.max(PADDING + r, Math.min(this.height - PADDING - r, node.y));
      }
    }
  }

  /** 单帧力导向更新 */
  private updateLayout(): void {
    let totalEnergy = 0;

    // 斥力
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // 引力
    for (const edge of this.edges) {
      const source = this.nodeMap.get(edge.sourceId);
      const target = this.nodeMap.get(edge.targetId);
      if (!source || !target) continue;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = dist * ATTRACTION * edge.weight;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    // 中心引力
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    for (const node of this.nodes) {
      node.vx += (centerX - node.x) * 0.0005;
      node.vy += (centerY - node.y) * 0.0005;
    }

    // 应用速度 + 阻尼 + 边界
    for (const node of this.nodes) {
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      totalEnergy += Math.abs(node.vx) + Math.abs(node.vy);

      const r = this.nodeRadius(node);
      node.x = Math.max(PADDING + r, Math.min(this.width - PADDING - r, node.x));
      node.y = Math.max(PADDING + r, Math.min(this.height - PADDING - r, node.y));
    }

    // 稳定检测：连续 30 帧低能量则停止动画
    if (totalEnergy < 0.5) {
      this.stableFrameCount++;
      if (this.stableFrameCount > 30) {
        this.layoutStable = true;
      }
    } else {
      this.stableFrameCount = 0;
    }
  }

  // ─── 渲染 ──────────────────────────────────────────────────

  /** 动画循环 */
  private startAnimation(): void {
    let lastTime = 0;
    const loop = (time: number) => {
      if (time - lastTime >= FRAME_INTERVAL) {
        lastTime = time;
        if (!this.layoutStable) {
          this.updateLayout();
        }
        this.render();
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  /** 停止动画 */
  private stopAnimation(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /** 渲染空状态 */
  private renderEmpty(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.fillStyle = 'var(--text-3, #a1a1a6)';
    this.ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText('暂无关系数据', this.width / 2, this.height / 2 - 10);
    this.ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    this.ctx.fillText('积累更多对话后，记忆关系将自动生成', this.width / 2, this.height / 2 + 15);
  }

  /** 渲染图谱 */
  private render(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // 绘制边
    for (const edge of this.edges) {
      const source = this.nodeMap.get(edge.sourceId);
      const target = this.nodeMap.get(edge.targetId);
      if (!source || !target) continue;

      // Phase 4：hover 节点的高亮边（连接到 hover 节点的边加亮 + 加粗）
      const isConnectedToHover = this.hoverNode && (source === this.hoverNode || target === this.hoverNode);

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = EDGE_TYPE_COLORS[edge.type] || DEFAULT_EDGE_COLOR;
      ctx.lineWidth = MIN_EDGE_WIDTH + (MAX_EDGE_WIDTH - MIN_EDGE_WIDTH) * edge.weight;
      ctx.globalAlpha = isConnectedToHover ? 0.8 : 0.4;
      if (isConnectedToHover) {
        ctx.lineWidth *= 1.5; // 高亮边加粗
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 绘制节点
    for (const node of this.nodes) {
      const r = this.nodeRadius(node);
      const isHovered = node === this.hoverNode;
      const isDragged = node === this.dragNode;

      // Phase 4：hover 光晕效果（径向渐变，放大 1.3 倍）
      if (isHovered) {
        const glowR = r * 1.8;
        const gradient = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, glowR);
        gradient.addColorStop(0, this.getNodeColor(node));
        gradient.addColorStop(1, 'rgba(0, 102, 255, 0)');
        ctx.beginPath();
        ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.globalAlpha = 0.3;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // 节点圆形（hover 时放大 15%）
      const renderR = isHovered ? r * 1.15 : r;
      ctx.beginPath();
      ctx.arc(node.x, node.y, renderR, 0, Math.PI * 2);
      ctx.fillStyle = this.getNodeColor(node);
      ctx.fill();

      // hover / drag 描边（Phase 4：加粗 + 发光色）
      if (isHovered || isDragged) {
        ctx.strokeStyle = isDragged ? '#0066ff' : 'rgba(0, 102, 255, 0.6)';
        ctx.lineWidth = isDragged ? 2.5 : 2;
        ctx.stroke();
      }

      // 节点名称（截断，hover 时字号略大）
      const maxNameLen = Math.max(3, Math.floor(renderR / 2));
      const displayName =
        node.name.length > maxNameLen ? node.name.slice(0, maxNameLen) + '…' : node.name;

      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(10, renderR * 0.7)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(displayName, node.x, node.y);
    }
  }

  // ─── 辅助方法 ──────────────────────────────────────────────

  /** 根据 score 计算节点半径 */
  private nodeRadius(node: GraphNode): number {
    return MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * Math.min(1, node.score);
  }

  /** 根据 source 获取节点颜色 */
  private getNodeColor(node: GraphNode): string {
    return SOURCE_COLORS[node.source] || DEFAULT_NODE_COLOR;
  }

  /** 调整 Canvas 尺寸（响应容器大小 + 高 DPI） */
  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const rect = parent.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** 根据坐标查找节点 */
  private findNodeAt(x: number, y: number): GraphNode | null {
    for (const node of this.nodes) {
      const r = this.nodeRadius(node) + 4; // 增加 4px 的热区
      const dx = node.x - x;
      const dy = node.y - y;
      if (dx * dx + dy * dy <= r * r) {
        return node;
      }
    }
    return null;
  }

  // ─── 事件绑定 ──────────────────────────────────────────────

  private bindEvents(): void {
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('mouseleave', this.onMouseUp);
    this.canvas.addEventListener('click', this.onClick);
  }

  private unbindEvents(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('mouseleave', this.onMouseUp);
    this.canvas.removeEventListener('click', this.onClick);
  }

  private onMouseDown = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = this.findNodeAt(x, y);
    if (node) {
      this.dragNode = node;
      this.dragOffsetX = node.x - x;
      this.dragOffsetY = node.y - y;
      this.layoutStable = false; // 拖拽时恢复布局
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.dragNode) {
      this.dragNode.x = x + this.dragOffsetX;
      this.dragNode.y = y + this.dragOffsetY;
      // 边界约束
      const r = this.nodeRadius(this.dragNode);
      this.dragNode.x = Math.max(PADDING + r, Math.min(this.width - PADDING - r, this.dragNode.x));
      this.dragNode.y = Math.max(PADDING + r, Math.min(this.height - PADDING - r, this.dragNode.y));
      return;
    }

    this.hoverNode = this.findNodeAt(x, y);
    this.canvas.style.cursor = this.hoverNode ? 'pointer' : 'default';
  };

  private onMouseUp = (): void => {
    this.dragNode = null;
  };

  private onClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = this.findNodeAt(x, y);
    if (node && this.onNodeClick) {
      this.onNodeClick(node.id);
    }
  };
}