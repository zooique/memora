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

// P0-B：结构化错误抛出（替代裸 throw new Error，让 ErrorHandler 正确分类）
import { MemoraError, ErrorCode } from '../../../sprite/errors.js';

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

/** 节点右键菜单回调 */
export type NodeContextMenuCallback = (nodeId: string, screenX: number, screenY: number) => void;

/** 边点击回调（编辑关系） */
export type EdgeClickCallback = (sourceId: string, targetId: string, type: string, weight: number) => void;

/** 手动连线创建关系回调 */
export type ConnectionCreateCallback = (sourceId: string, targetId: string) => void;

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
/** 最小缩放级别 */
const MIN_ZOOM = 0.3;
/** 最大缩放级别 */
const MAX_ZOOM = 3;
/** 滚轮缩放灵敏度（每步缩放因子） */
const ZOOM_SENSITIVITY = 0.001;
/** 双击缩放重置动画时长（ms） */
const RESET_ANIM_DURATION = 400;
/** 边点击检测热区半径（像素） */
const EDGE_HIT_RADIUS = 8;
/** 连线模式提示线虚线间隔 */
const CONNECTION_LINE_DASH = [6, 4];
/** 冲突脉冲周期（ms） */
const CONFLICT_PULSE_PERIOD = 1200;
/** 冲突脉冲最小 alpha */
const CONFLICT_PULSE_MIN_ALPHA = 0.3;
/** 冲突脉冲最大 alpha */
const CONFLICT_PULSE_MAX_ALPHA = 0.9;

// ─── 颜色映射（source → CSS 变量名，运行时从主题解析实际色值） ──

/** source 类型 → 对应的 CSS 变量名（在 base.css 中定义，支持双主题） */
const SOURCE_COLOR_VARS: Record<string, string> = {
  profile: '--green',
  insight: '--accent',
  guardrail: '--pink',
  skill: '--yellow',
  rule: '--mauve',
  persona: '--teal',
  session: '--peach',
};

/** 边类型 → 对应的 CSS 变量名 */
const EDGE_COLOR_VARS: Record<string, string> = {
  contradicts: '--red',
  supports: '--green',
  follows: '--accent',
  refines: '--yellow',
  caused: '--mauve',
  related: '--muted',
};

/** 连线模式预览线使用的 CSS 变量名 */
const CONNECTION_LINE_VAR = '--yellow';

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
  /** 是否发生过拖拽（用于 onClick 守卫，阻止拖拽结束后误触发 click） */
  private didDrag = false;

  // 动画
  private animFrameId: number | null = null;
  /** 布局是否已稳定 */
  private layoutStable = false;
  /** 布局稳定后的静止帧计数器 */
  private stableFrameCount = 0;

  // 回调
  private onNodeClick: NodeClickCallback | null = null;
  /** 节点右键菜单回调 */
  private onNodeContextMenu: NodeContextMenuCallback | null = null;
  /** 边点击回调（编辑关系） */
  private onEdgeClick: EdgeClickCallback | null = null;
  /** 手动连线创建关系回调 */
  private onConnectionCreate: ConnectionCreateCallback | null = null;

  // ─── 连线模式状态 ───────────────────────────────────────────
  /** 连线模式：拖拽的源节点 */
  private connectionSourceNode: GraphNode | null = null;
  /** 连线模式：当前鼠标世界坐标 */
  private connectionMouseX = 0;
  private connectionMouseY = 0;

  // 高 DPI 缩放
  private dpr = 1;

  // ─── Tooltip DOM 元素 ───────────────────────────────────────
  /** tooltip 容器元素 */
  private tooltipEl: HTMLElement | null = null;
  /** tooltip 名称元素 */
  private tooltipNameEl: HTMLElement | null = null;
  /** tooltip source 元素 */
  private tooltipSourceEl: HTMLElement | null = null;
  /** tooltip 预览元素 */
  private tooltipPreviewEl: HTMLElement | null = null;

  // ─── Resize 监听 ────────────────────────────────────────────
  private resizeObserver: ResizeObserver | null = null;

  // ─── 高亮/选中状态（外部联动） ──────────────────────────────
  /** 搜索命中高亮节点 ID 集合（这些节点正常显示，其他淡化） */
  private highlightedNodeIds: Set<string> | null = null;
  /** 当前选中的节点 ID（列表/详情联动，显示外发光环） */
  private selectedNodeId: string | null = null;

  // ─── 视口平移/缩放（用于选中节点居中动画 + 用户交互） ────────
  /** 视口 X 偏移（相机位置） */
  private cameraX = 0;
  /** 视口 Y 偏移（相机位置） */
  private cameraY = 0;
  /** 目标视口 X 偏移（平滑动画目标） */
  private targetCameraX = 0;
  /** 目标视口 Y 偏移（平滑动画目标） */
  private targetCameraY = 0;
  /** 当前缩放级别（1 = 原始大小） */
  private zoom = 1;
  /** 目标缩放级别（平滑动画目标） */
  private targetZoom = 1;
  /** 是否正在拖拽画布平移 */
  private isPanning = false;
  /** 平移起始屏幕 X 坐标 */
  private panStartX = 0;
  /** 平移起始屏幕 Y 坐标 */
  private panStartY = 0;
  /** 平移起始相机 X 偏移 */
  private panStartCameraX = 0;
  /** 平移起始相机 Y 偏移 */
  private panStartCameraY = 0;
  /** 视图重置动画起始时间（0 表示无动画） */
  private resetAnimStart = 0;
  /** 视图重置动画起始相机 X */
  private resetStartCameraX = 0;
  /** 视图重置动画起始相机 Y */
  private resetStartCameraY = 0;
  /** 视图重置动画起始缩放 */
  private resetStartZoom = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new MemoraError(ErrorCode.INITIALIZATION_FAILED, 'Canvas 2D 上下文不可用');
    this.ctx = ctx;
    this.dpr = window.devicePixelRatio || 1;

    // 查找 tooltip DOM 元素
    this.tooltipEl = document.getElementById('graph-tooltip');
    if (this.tooltipEl) {
      this.tooltipNameEl = this.tooltipEl.querySelector('.graph-tooltip-name');
      this.tooltipSourceEl = this.tooltipEl.querySelector('.graph-tooltip-source');
      this.tooltipPreviewEl = this.tooltipEl.querySelector('.graph-tooltip-preview');
    }

    this.bindEvents();
    this.setupResizeObserver();
  }

  // ─── 公开 API ──────────────────────────────────────────────

  /** 设置节点点击回调 */
  setOnNodeClick(cb: NodeClickCallback): void {
    this.onNodeClick = cb;
  }

  /** 设置节点右键菜单回调 */
  setOnNodeContextMenu(cb: NodeContextMenuCallback): void {
    this.onNodeContextMenu = cb;
  }

  /** 设置边点击回调（编辑关系） */
  setOnEdgeClick(cb: EdgeClickCallback): void {
    this.onEdgeClick = cb;
  }

  /** 设置手动连线创建关系回调 */
  setOnConnectionCreate(cb: ConnectionCreateCallback): void {
    this.onConnectionCreate = cb;
  }

  /**
   * 设置高亮节点集合（搜索结果联动）
   *
   * 高亮节点正常显示，非高亮节点和连接它们的边会淡化（alpha=0.15）。
   * 传 null 清除高亮状态，恢复全量显示。
   *
   * @param nodeIds 要高亮的节点 ID 数组，null 表示清除高亮
   */
  setHighlightedNodes(nodeIds: string[] | null): void {
    this.highlightedNodeIds = nodeIds ? new Set(nodeIds) : null;
  }

  /**
   * 设置选中节点（列表/详情联动）
   *
   * 选中节点会显示蓝色外发光环，并通过平滑相机动画将其居中到视口。
   * 传 null 取消选中。
   *
   * @param nodeId 要选中的节点 ID，null 表示取消选中
   */
  setSelectedNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
    if (nodeId) {
      const node = this.nodeMap.get(nodeId);
      if (node) {
        // 设置目标相机位置，使节点居中（考虑当前缩放级别）
        this.targetCameraX = this.width / 2 - node.x * this.zoom;
        this.targetCameraY = this.height / 2 - node.y * this.zoom;
        // 拖拽/选中时恢复动画
        this.layoutStable = false;
        this.stableFrameCount = 0;
      }
    }
  }

  /** 清除所有高亮和选中状态，重置视图到初始位置 */
  clearHighlights(): void {
    this.highlightedNodeIds = null;
    this.selectedNodeId = null;
    this.resetView();
  }

  /**
   * 重置视图到初始状态（居中 + 缩放 1x），带动画过渡
   */
  resetView(): void {
    this.targetCameraX = 0;
    this.targetCameraY = 0;
    this.targetZoom = 1;
    // 启动重置动画
    this.resetAnimStart = performance.now();
    this.resetStartCameraX = this.cameraX;
    this.resetStartCameraY = this.cameraY;
    this.resetStartZoom = this.zoom;
    this.layoutStable = false;
    this.stableFrameCount = 0;
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

    // 重置高亮/选中/相机/缩放状态（新数据不保留旧视图状态）
    this.highlightedNodeIds = null;
    this.selectedNodeId = null;
    this.cameraX = 0;
    this.cameraY = 0;
    this.targetCameraX = 0;
    this.targetCameraY = 0;
    this.zoom = 1;
    this.targetZoom = 1;
    this.isPanning = false;
    this.resetAnimStart = 0;

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
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.hideTooltip();
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
          const a = this.nodes[i]!;
          const b = this.nodes[j]!;
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
        const a = this.nodes[i]!;
        const b = this.nodes[j]!;
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

        // 处理视图重置动画（ease-out 缓动）
        if (this.resetAnimStart > 0) {
          const elapsed = time - this.resetAnimStart;
          const t = Math.min(1, elapsed / RESET_ANIM_DURATION);
          // easeOutCubic 缓动函数
          const ease = 1 - Math.pow(1 - t, 3);
          this.cameraX = this.resetStartCameraX + (this.targetCameraX - this.resetStartCameraX) * ease;
          this.cameraY = this.resetStartCameraY + (this.targetCameraY - this.resetStartCameraY) * ease;
          this.zoom = this.resetStartZoom + (this.targetZoom - this.resetStartZoom) * ease;
          if (t >= 1) {
            this.resetAnimStart = 0;
          }
        } else {
          // 正常平滑插值
          this.cameraX += (this.targetCameraX - this.cameraX) * 0.12;
          this.cameraY += (this.targetCameraY - this.cameraY) * 0.12;
          this.zoom += (this.targetZoom - this.zoom) * 0.15;
        }

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
    // Canvas 2D 不支持 CSS var()，需通过 getComputedStyle 解析主题色
    const textColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-3').trim() || '#a1a1a6';
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.fillStyle = textColor;
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

    // 应用相机偏移 + 缩放变换（先缩放再平移，保证缩放以画布中心为锚点）
    ctx.save();
    ctx.translate(this.cameraX, this.cameraY);
    ctx.scale(this.zoom, this.zoom);

    // 辅助函数：判断节点是否高亮
    const isNodeHighlighted = (node: GraphNode): boolean => {
      if (!this.highlightedNodeIds) return true; // 无高亮模式，全部显示
      return this.highlightedNodeIds.has(node.id);
    };

    // 辅助函数：判断边是否高亮（两端点至少有一个高亮则边高亮）
    const isEdgeHighlighted = (source: GraphNode, target: GraphNode): boolean => {
      if (!this.highlightedNodeIds) return true;
      return this.highlightedNodeIds.has(source.id) || this.highlightedNodeIds.has(target.id);
    };

    // 绘制边
    for (const edge of this.edges) {
      const source = this.nodeMap.get(edge.sourceId);
      const target = this.nodeMap.get(edge.targetId);
      if (!source || !target) continue;

      // hover 节点的高亮边（连接到 hover 节点的边加亮 + 加粗）
      const isConnectedToHover = this.hoverNode && (source === this.hoverNode || target === this.hoverNode);
      // 搜索高亮淡化
      const edgeHighlighted = isEdgeHighlighted(source, target);

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = this.getEdgeColor(edge.type);
      ctx.lineWidth = MIN_EDGE_WIDTH + (MAX_EDGE_WIDTH - MIN_EDGE_WIDTH) * edge.weight;

      // 冲突边脉冲动画（正弦波 alpha 振荡）
      if (edge.type === 'contradicts') {
        const pulse =
          CONFLICT_PULSE_MIN_ALPHA +
          (CONFLICT_PULSE_MAX_ALPHA - CONFLICT_PULSE_MIN_ALPHA) *
          (0.5 + 0.5 * Math.sin(performance.now() / CONFLICT_PULSE_PERIOD * Math.PI * 2));
        ctx.globalAlpha = pulse;
        ctx.lineWidth *= 1.4; // 冲突边略粗
      } else if (!edgeHighlighted) {
        ctx.globalAlpha = 0.08;
      } else if (isConnectedToHover) {
        ctx.globalAlpha = 0.8;
        ctx.lineWidth *= 1.5;
      } else {
        ctx.globalAlpha = 0.4;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 绘制连线模式预览线（虚线，从源节点到鼠标位置）
    if (this.connectionSourceNode) {
      ctx.beginPath();
      ctx.setLineDash(CONNECTION_LINE_DASH);
      ctx.moveTo(this.connectionSourceNode.x, this.connectionSourceNode.y);
      ctx.lineTo(this.connectionMouseX, this.connectionMouseY);
      ctx.strokeStyle = this.resolveCssVar(CONNECTION_LINE_VAR, '#ff9f0a');
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.setLineDash([]); // 重置虚线设置
      ctx.globalAlpha = 1;
    }

    // 绘制节点
    for (const node of this.nodes) {
      const r = this.nodeRadius(node);
      const isHovered = node === this.hoverNode;
      const isDragged = node === this.dragNode;
      const isSelected = node.id === this.selectedNodeId;
      const nodeHighlighted = isNodeHighlighted(node);

      // 选中节点外发光环（强调色脉冲效果，在最底层）
      if (isSelected) {
        const selectedGlowR = r * 2.2;
        const accentColor = this.resolveCssVar('--accent', '#0066ff');
        const gradient = ctx.createRadialGradient(node.x, node.y, r * 1.2, node.x, node.y, selectedGlowR);
        gradient.addColorStop(0, this.hexToRgba(accentColor, 0.4));
        gradient.addColorStop(1, this.hexToRgba(accentColor, 0));
        ctx.beginPath();
        ctx.arc(node.x, node.y, selectedGlowR, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // hover 光晕效果
      if (isHovered && nodeHighlighted) {
        const glowR = r * 1.8;
        const nodeColor = this.getNodeColor(node);
        const gradient = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, glowR);
        gradient.addColorStop(0, nodeColor);
        gradient.addColorStop(1, this.hexToRgba(nodeColor, 0));
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
      // 搜索淡化：非高亮节点降低不透明度
      ctx.globalAlpha = nodeHighlighted ? 1 : 0.15;
      ctx.fill();
      ctx.globalAlpha = 1;

      // 选中节点强调色描边（优先级最高）
      if (isSelected) {
        ctx.strokeStyle = this.resolveCssVar('--accent', '#0066ff');
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (isHovered || isDragged) {
        // hover / drag 描边（强调色半透明）
        const accentColor = this.resolveCssVar('--accent', '#0066ff');
        ctx.strokeStyle = isDragged ? accentColor : this.hexToRgba(accentColor, 0.6);
        ctx.lineWidth = isDragged ? 2.5 : 2;
        ctx.stroke();
      }

      // 节点名称（截断，hover 时字号略大；非高亮节点文字也淡化）
      if (nodeHighlighted) {
        const maxNameLen = Math.max(3, Math.floor(renderR / 2));
        const displayName =
          node.name.length > maxNameLen ? node.name.slice(0, maxNameLen) + '…' : node.name;

        ctx.fillStyle = this.getContrastColor(this.getNodeColor(node));
        ctx.font = `${Math.max(10, renderR * 0.7)}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayName, node.x, node.y);
      }
    }

    ctx.restore();
  }

  // ─── 辅助方法 ──────────────────────────────────────────────

  /** 根据 score 计算节点半径 */
  private nodeRadius(node: GraphNode): number {
    return MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * Math.min(1, node.score);
  }

  /**
   * 从 CSS 变量解析当前主题色值
   * Canvas 2D 无法直接使用 CSS var()，需在绘制时动态读取
   */
  private resolveCssVar(varName: string, fallback: string): string {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim() || fallback;
  }

  /** 根据 source 获取节点颜色（从 CSS 变量解析，支持双主题自动切换） */
  private getNodeColor(node: GraphNode): string {
    const varName = SOURCE_COLOR_VARS[node.source];
    if (varName) {
      return this.resolveCssVar(varName, '#a1a1a6');
    }
    return this.resolveCssVar('--muted', '#a1a1a6');
  }

  /** 根据边类型获取边颜色（从 CSS 变量解析，支持双主题自动切换） */
  private getEdgeColor(edgeType: string): string {
    const varName = EDGE_COLOR_VARS[edgeType];
    if (varName) {
      return this.resolveCssVar(varName, '#a1a1a6');
    }
    return this.resolveCssVar('--muted', '#a1a1a6');
  }

  /** 将十六进制颜色转换为 rgba 字符串（用于光晕/渐变等需要透明度的场景） */
  private hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace('#', '');
    if (h.length !== 6) return `rgba(0,0,0,${alpha})`;
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * 根据背景色计算高对比度文字颜色（黑/白）
   * 使用 YIQ 颜色空间判断亮度，同时考虑当前主题背景
   */
  private getContrastColor(hexColor: string): string {
    const hex = hexColor.replace('#', '');
    if (hex.length !== 6) return '#ffffff';
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    // YIQ 亮度公式
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    // 亮色背景用深色文字，暗色背景用浅色文字（文字颜色跟随主题 --text）
    return yiq >= 128
      ? this.resolveCssVar('--text', '#1d1d1f')
      : this.resolveCssVar('--white', '#ffffff');
  }

  /**
   * 设置 ResizeObserver 监听容器大小变化
   * 窗口大小改变时自动调整 Canvas 尺寸
   */
  private setupResizeObserver(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(parent);
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

  /**
   * 将屏幕坐标转换为世界坐标（考虑相机偏移 + 缩放）
   * @param screenX 相对于 Canvas 左上角的屏幕 X
   * @param screenY 相对于 Canvas 左上角的屏幕 Y
   * @returns 世界坐标 { x, y }
   */
  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.cameraX) / this.zoom,
      y: (screenY - this.cameraY) / this.zoom,
    };
  }

  /** 根据坐标查找节点 */
  private findNodeAt(screenX: number, screenY: number): GraphNode | null {
    const { x, y } = this.screenToWorld(screenX, screenY);
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

  /**
   * 根据屏幕坐标查找边（点到线段距离检测）
   *
   * 返回距离鼠标最近的边，用于点击边触发关系编辑弹窗。
   * 仅检测距离在 EDGE_HIT_RADIUS 范围内的边。
   *
   * @param screenX 屏幕 X 坐标
   * @param screenY 屏幕 Y 坐标
   * @returns 最近的边，未命中返回 null
   */
  private findEdgeAt(screenX: number, screenY: number): GraphEdge | null {
    const { x, y } = this.screenToWorld(screenX, screenY);
    let closestEdge: GraphEdge | null = null;
    let closestDist = EDGE_HIT_RADIUS;

    for (const edge of this.edges) {
      const source = this.nodeMap.get(edge.sourceId);
      const target = this.nodeMap.get(edge.targetId);
      if (!source || !target) continue;

      // 点到线段距离（数学公式，不依赖 DOM）
      const dist = this.pointToSegmentDist(x, y, source.x, source.y, target.x, target.y);
      if (dist < closestDist) {
        closestDist = dist;
        closestEdge = edge;
      }
    }
    return closestEdge;
  }

  /**
   * 计算点到线段的最短距离
   *
   * 使用向量投影法，投影参数 t 在 [0,1] 之间时为垂足在线段上，
   * 否则取到端点的距离。
   */
  private pointToSegmentDist(
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

  // ─── 事件绑定 ──────────────────────────────────────────────

  private bindEvents(): void {
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('mouseleave', this.onMouseLeave);
    this.canvas.addEventListener('click', this.onClick);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDblClick);
  }

  private unbindEvents(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
  }

  private onMouseDown = (e: MouseEvent): void => {
    // 重置拖拽标志，后续 onMouseMove 中发生拖拽时设为 true
    this.didDrag = false;

    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const node = this.findNodeAt(screenX, screenY);

    // 连线模式：Ctrl + 从节点开始拖拽 → 画连线到目标节点
    if (node && (e.ctrlKey || e.metaKey)) {
      this.connectionSourceNode = node;
      const world = this.screenToWorld(screenX, screenY);
      this.connectionMouseX = world.x;
      this.connectionMouseY = world.y;
      this.canvas.style.cursor = 'crosshair';
      e.preventDefault();
      return;
    }

    if (node) {
      this.dragNode = node;
      // 拖拽偏移：节点世界坐标 - 鼠标世界坐标
      const world = this.screenToWorld(screenX, screenY);
      this.dragOffsetX = node.x - world.x;
      this.dragOffsetY = node.y - world.y;
      this.layoutStable = false; // 拖拽时恢复布局
    } else {
      // 未点击到节点 → 开始画布平移
      this.isPanning = true;
      this.panStartX = screenX;
      this.panStartY = screenY;
      this.panStartCameraX = this.targetCameraX;
      this.panStartCameraY = this.targetCameraY;
      this.canvas.style.cursor = 'grabbing';
      this.hideTooltip();
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // 连线模式：更新鼠标位置，绘制连线预览
    if (this.connectionSourceNode) {
      const world = this.screenToWorld(screenX, screenY);
      this.connectionMouseX = world.x;
      this.connectionMouseY = world.y;
      this.hideTooltip();
      return;
    }

    // 节点拖拽
    if (this.dragNode) {
      this.didDrag = true; // 标记发生过拖拽，阻止后续 click 事件误触发
      const world = this.screenToWorld(screenX, screenY);
      this.dragNode.x = world.x + this.dragOffsetX;
      this.dragNode.y = world.y + this.dragOffsetY;
      // 宽松边界约束（允许拖拽到较大范围，中心引力会在动画中拉回）
      const r = this.nodeRadius(this.dragNode);
      const bound = Math.max(this.width, this.height) * 2 / this.zoom;
      this.dragNode.x = Math.max(-bound + r, Math.min(bound - r, this.dragNode.x));
      this.dragNode.y = Math.max(-bound + r, Math.min(bound - r, this.dragNode.y));
      this.hideTooltip();
      return;
    }

    // 画布平移拖拽
    if (this.isPanning) {
      this.didDrag = true; // 标记发生过拖拽，阻止后续 click 事件误触发
      this.targetCameraX = this.panStartCameraX + (screenX - this.panStartX);
      this.targetCameraY = this.panStartCameraY + (screenY - this.panStartY);
      // 直接设置当前值避免延迟
      this.cameraX = this.targetCameraX;
      this.cameraY = this.targetCameraY;
      this.hideTooltip();
      return;
    }

    const prevHover = this.hoverNode;
    this.hoverNode = this.findNodeAt(screenX, screenY);
    this.canvas.style.cursor = this.hoverNode ? 'pointer' : 'grab';

    // tooltip 显示/隐藏/更新
    if (this.hoverNode) {
      if (this.hoverNode !== prevHover) {
        this.showTooltip(this.hoverNode);
      }
      this.updateTooltipPosition(e.clientX, e.clientY);
    } else {
      this.hideTooltip();
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    // 连线模式释放：检测是否在目标节点上
    if (this.connectionSourceNode) {
      const rect = this.canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const targetNode = this.findNodeAt(screenX, screenY);
      // 释放到另一个节点上 → 触发连线创建回调
      if (targetNode && targetNode !== this.connectionSourceNode && this.onConnectionCreate) {
        this.onConnectionCreate(this.connectionSourceNode.id, targetNode.id);
      }
      this.connectionSourceNode = null;
      this.canvas.style.cursor = this.hoverNode ? 'pointer' : 'grab';
      return;
    }

    this.dragNode = null;
    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = this.hoverNode ? 'pointer' : 'grab';
    }
  };

  private onMouseLeave = (): void => {
    this.dragNode = null;
    this.hoverNode = null;
    this.isPanning = false;
    this.connectionSourceNode = null;
    this.canvas.style.cursor = 'grab';
    this.hideTooltip();
  };

  private onClick = (e: MouseEvent): void => {
    // 拖拽结束后的 click 不应触发节点选中（拖拽平移或节点拖拽后避免误触）
    if (this.didDrag) return;
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // 优先检测边点击（编辑关系）
    const edge = this.findEdgeAt(screenX, screenY);
    if (edge && this.onEdgeClick) {
      this.onEdgeClick(edge.sourceId, edge.targetId, edge.type, edge.weight);
      return;
    }

    // 节点点击
    const node = this.findNodeAt(screenX, screenY);
    if (node && this.onNodeClick) {
      this.onNodeClick(node.id);
    }
  };

  /**
   * 右键菜单事件处理
   *
   * 右键点击节点时触发 onNodeContextMenu 回调，
   * 由 memoryPanelManager 显示自定义上下文菜单。
   */
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const node = this.findNodeAt(screenX, screenY);
    if (node && this.onNodeContextMenu) {
      this.onNodeContextMenu(node.id, e.clientX, e.clientY);
    }
  };

  /**
   * 滚轮缩放事件处理
   *
   * 以鼠标位置为锚点缩放，保证鼠标下的内容在缩放前后保持在同一位置。
   * 缩放通过调整 targetZoom 和 targetCamera 实现，由动画循环平滑插值。
   */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    // 计算缩放因子（deltaY 向下为正 → 缩小；向上为负 → 放大）
    const delta = -e.deltaY * ZOOM_SENSITIVITY;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.targetZoom * (1 + delta)));

    // 以鼠标位置为锚点调整相机偏移，保证鼠标下的世界坐标点不变
    // 推导：缩放前 world = (screen - camera) / zoom；缩放后 world' = (screen - camera') / zoom'
    // 要求 world = world'，则 camera' = screen - (screen - camera) * zoom' / zoom
    const zoomRatio = newZoom / this.targetZoom;
    this.targetCameraX = screenX - (screenX - this.targetCameraX) * zoomRatio;
    this.targetCameraY = screenY - (screenY - this.targetCameraY) * zoomRatio;
    this.targetZoom = newZoom;

    // 直接同步一部分值，提供即时响应感
    this.cameraX += (this.targetCameraX - this.cameraX) * 0.3;
    this.cameraY += (this.targetCameraY - this.cameraY) * 0.3;
    this.zoom += (this.targetZoom - this.zoom) * 0.3;
  };

  /**
   * 双击事件处理：重置视图到初始状态
   */
  private onDblClick = (_e: MouseEvent): void => {
    this.resetView();
  };

  // ─── Tooltip 辅助方法 ──────────────────────────────────────

  /** 显示节点 tooltip */
  private showTooltip(node: GraphNode): void {
    if (!this.tooltipEl) return;
    if (this.tooltipNameEl) this.tooltipNameEl.textContent = node.name;
    if (this.tooltipSourceEl) this.tooltipSourceEl.textContent = `source: ${node.source}`;
    if (this.tooltipPreviewEl) this.tooltipPreviewEl.textContent = node.contentPreview;
    this.tooltipEl.classList.remove('hidden');
  }

  /** 隐藏 tooltip */
  private hideTooltip(): void {
    if (!this.tooltipEl) return;
    this.tooltipEl.classList.add('hidden');
  }

  /**
   * 更新 tooltip 位置（跟随鼠标，避免超出视口）
   * @param clientX 鼠标相对于视口的 x 坐标
   * @param clientY 鼠标相对于视口的 y 坐标
   */
  private updateTooltipPosition(clientX: number, clientY: number): void {
    if (!this.tooltipEl) return;
    const container = this.canvas.parentElement;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const tooltipRect = this.tooltipEl.getBoundingClientRect();
    const offset = 16; // 鼠标与 tooltip 的间距

    let left = clientX - containerRect.left + offset;
    let top = clientY - containerRect.top + offset;

    // 防止 tooltip 超出容器右/下边界
    if (left + tooltipRect.width > containerRect.width - 8) {
      left = clientX - containerRect.left - tooltipRect.width - offset;
    }
    if (top + tooltipRect.height > containerRect.height - 8) {
      top = clientY - containerRect.top - tooltipRect.height - offset;
    }

    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top = `${top}px`;
  }
}