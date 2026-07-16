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
 *
 * 拆分说明：
 * - 类型与常量提取至 helpers/relationGraphTypes.ts（架构层，消除循环依赖）
 * - 布局算法提取至 helpers/relationGraphLayout.ts（枝叶层，LayoutContext 依赖注入）
 * - 颜色解析提取至 helpers/relationGraphColor.ts（枝叶层，纯函数 + 常量）
 * - 几何计算提取至 helpers/relationGraphGeometry.ts（枝叶层，纯函数）
 */

import { MemoraError, ErrorCode } from '../../../sprite/errors.js';
import {
  runInitialLayout,
  updateLayout,
  type LayoutContext,
} from '../helpers/relationGraphLayout.js';
import {
  CONNECTION_LINE_VAR,
  resolveCssVar,
  getNodeColor,
  getEdgeColor,
  hexToRgba,
  getContrastColor,
} from '../helpers/relationGraphColor.js';
import {
  nodeRadius,
  screenToWorld,
  findNodeAt,
  findEdgeAt,
} from '../helpers/relationGraphGeometry.js';
import type {
  GraphNode,
  GraphEdge,
  RelationGraphData,
  NodeClickCallback,
  NodeContextMenuCallback,
  EdgeClickCallback,
  ConnectionCreateCallback,
} from '../helpers/relationGraphTypes.js';
import {
  MIN_EDGE_WIDTH,
  MAX_EDGE_WIDTH,
  FRAME_INTERVAL,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_SENSITIVITY,
  RESET_ANIM_DURATION,
  CONNECTION_LINE_DASH,
  CONFLICT_PULSE_PERIOD,
  CONFLICT_PULSE_MIN_ALPHA,
  CONFLICT_PULSE_MAX_ALPHA,
} from '../helpers/relationGraphTypes.js';
// 文本截断工具（跨层共享，统一 ellipsis 为 '…'，ADR-017 枝叶层 2 次提取）
import { truncate } from '../../../shared/truncate.js';
// setCanvasSize 统一 canvas DPR 设置（ADR-017 枝叶层 2 次提取，修复跨显示器 dpr 不更新 bug）
import { setCanvasSize } from '../helpers/domHelpers.js';

// 类型 re-export（外部调用方仍可从本模块导入类型）
export type {
  GraphNode,
  GraphEdge,
  RelationGraphData,
  NodeClickCallback,
  NodeContextMenuCallback,
  EdgeClickCallback,
  ConnectionCreateCallback,
};

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

  // ─── 键盘焦点状态 ─────────────────────────────────
  /** 键盘焦点节点索引（-1 = 无焦点）；与 hover/selected 独立 */
  private focusedNodeIndex = -1;

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
    this.focusedNodeIndex = -1;
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
    runInitialLayout(this.buildLayoutContext());

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

  /** 构建布局上下文（桥接 renderer 实例字段到 LayoutContext 接口） */
  private buildLayoutContext(): LayoutContext {
    const self = this;
    return {
      nodes: this.nodes,
      edges: this.edges,
      nodeMap: this.nodeMap,
      width: this.width,
      height: this.height,
      get stableFrameCount() { return self.stableFrameCount; },
      set stableFrameCount(v: number) { self.stableFrameCount = v; },
      get layoutStable() { return self.layoutStable; },
      set layoutStable(v: boolean) { self.layoutStable = v; },
      nodeRadius: (node: GraphNode) => nodeRadius(node),
    };
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
          updateLayout(this.buildLayoutContext());
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
    // 复用 resolveCssVar 解析主题色（含 CSS_VAR_FALLBACKS 深浅色双 fallback，避免硬编码）
    const textColor = resolveCssVar('--text-3');
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
      ctx.strokeStyle = getEdgeColor(edge.type);
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
      ctx.strokeStyle = resolveCssVar(CONNECTION_LINE_VAR);
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.setLineDash([]); // 重置虚线设置
      ctx.globalAlpha = 1;
    }

    // 绘制节点
    for (const node of this.nodes) {
      const r = nodeRadius(node);
      const isHovered = node === this.hoverNode;
      const isDragged = node === this.dragNode;
      const isSelected = node.id === this.selectedNodeId;
      const nodeHighlighted = isNodeHighlighted(node);

      // 选中节点外发光环（强调色脉冲效果，在最底层）
      if (isSelected) {
        const selectedGlowR = r * 2.2;
        const accentColor = resolveCssVar('--accent');
        const gradient = ctx.createRadialGradient(node.x, node.y, r * 1.2, node.x, node.y, selectedGlowR);
        gradient.addColorStop(0, hexToRgba(accentColor, 0.4));
        gradient.addColorStop(1, hexToRgba(accentColor, 0));
        ctx.beginPath();
        ctx.arc(node.x, node.y, selectedGlowR, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // hover 光晕效果
      if (isHovered && nodeHighlighted) {
        const glowR = r * 1.8;
        const nodeColor = getNodeColor(node.source);
        const gradient = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, glowR);
        gradient.addColorStop(0, nodeColor);
        gradient.addColorStop(1, hexToRgba(nodeColor, 0));
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
      ctx.fillStyle = getNodeColor(node.source);
      // 搜索淡化：非高亮节点降低不透明度
      ctx.globalAlpha = nodeHighlighted ? 1 : 0.15;
      ctx.fill();
      ctx.globalAlpha = 1;

      // 选中节点强调色描边（优先级最高）
      if (isSelected) {
        ctx.strokeStyle = resolveCssVar('--accent');
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (isHovered || isDragged) {
        // hover / drag 描边（强调色半透明）
        const accentColor = resolveCssVar('--accent');
        ctx.strokeStyle = isDragged ? accentColor : hexToRgba(accentColor, 0.6);
        ctx.lineWidth = isDragged ? 2.5 : 2;
        ctx.stroke();
      }

      // 键盘焦点环（虚线圆环，与 hover/selected 视觉区分）
      const isFocused = this.focusedNodeIndex >= 0 && this.nodes[this.focusedNodeIndex] === node;
      if (isFocused) {
        const focusR = renderR + 5;
        ctx.beginPath();
        ctx.arc(node.x, node.y, focusR, 0, Math.PI * 2);
        ctx.strokeStyle = resolveCssVar('--accent');
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 节点名称（截断，hover 时字号略大；非高亮节点文字也淡化）
      if (nodeHighlighted) {
        const maxNameLen = Math.max(3, Math.floor(renderR / 2));
        const displayName = truncate(node.name, maxNameLen);

        ctx.fillStyle = getContrastColor(getNodeColor(node.source));
        ctx.font = `${Math.max(10, renderR * 0.7)}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayName, node.x, node.y);
      }
    }

    ctx.restore();
  }

  // ─── 辅助方法 ──────────────────────────────────────────────

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

    // setCanvasSize 每次重新获取 devicePixelRatio，修复跨显示器移动后 dpr 不更新导致渲染模糊
    const dpr = setCanvasSize(this.canvas, this.width, this.height);
    // setTransform 设置 dpr 缩放（canvas.width 赋值会重置变换矩阵，setTransform 与 scale 等价）
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    this.canvas.addEventListener('keydown', this.onKeyDown);
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
    this.canvas.removeEventListener('keydown', this.onKeyDown);
  }

  private onMouseDown = (e: MouseEvent): void => {
    // 重置拖拽标志，后续 onMouseMove 中发生拖拽时设为 true
    this.didDrag = false;
    // 鼠标交互开始时清除键盘焦点（避免双重指示器）
    if (this.focusedNodeIndex !== -1) {
      this.focusedNodeIndex = -1;
    }

    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const node = findNodeAt(this.nodes, screenX, screenY, this.cameraX, this.cameraY, this.zoom);

    // 连线模式：Ctrl + 从节点开始拖拽 → 画连线到目标节点
    if (node && (e.ctrlKey || e.metaKey)) {
      this.connectionSourceNode = node;
      const world = screenToWorld(screenX, screenY, this.cameraX, this.cameraY, this.zoom);
      this.connectionMouseX = world.x;
      this.connectionMouseY = world.y;
      this.canvas.style.cursor = 'crosshair';
      e.preventDefault();
      return;
    }

    if (node) {
      this.dragNode = node;
      // 拖拽偏移：节点世界坐标 - 鼠标世界坐标
      const world = screenToWorld(screenX, screenY, this.cameraX, this.cameraY, this.zoom);
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
      const world = screenToWorld(screenX, screenY, this.cameraX, this.cameraY, this.zoom);
      this.connectionMouseX = world.x;
      this.connectionMouseY = world.y;
      this.hideTooltip();
      return;
    }

    // 节点拖拽
    if (this.dragNode) {
      this.didDrag = true; // 标记发生过拖拽，阻止后续 click 事件误触发
      const world = screenToWorld(screenX, screenY, this.cameraX, this.cameraY, this.zoom);
      this.dragNode.x = world.x + this.dragOffsetX;
      this.dragNode.y = world.y + this.dragOffsetY;
      // 宽松边界约束（允许拖拽到较大范围，中心引力会在动画中拉回）
      const r = nodeRadius(this.dragNode);
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
    this.hoverNode = findNodeAt(this.nodes, screenX, screenY, this.cameraX, this.cameraY, this.zoom);
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
      const targetNode = findNodeAt(this.nodes, screenX, screenY, this.cameraX, this.cameraY, this.zoom);
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
    const edge = findEdgeAt(this.edges, this.nodeMap, screenX, screenY, this.cameraX, this.cameraY, this.zoom);
    if (edge && this.onEdgeClick) {
      this.onEdgeClick(edge.sourceId, edge.targetId, edge.type, edge.weight);
      return;
    }

    // 节点点击
    const node = findNodeAt(this.nodes, screenX, screenY, this.cameraX, this.cameraY, this.zoom);
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
    const node = findNodeAt(this.nodes, screenX, screenY, this.cameraX, this.cameraY, this.zoom);
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

  // ─── 键盘导航 ─────────────────────────

  /**
   * 键盘事件处理：Canvas 节点导航
   *
   * - ArrowRight / ArrowDown：焦点移到下一个节点（循环）
   * - ArrowLeft / ArrowUp：焦点移到上一个节点（循环）
   * - Enter / Space：触发当前焦点节点的点击回调
   * - Escape：清除键盘焦点 + 隐藏 tooltip
   *
   * 首次按方向键时若无焦点，则聚焦第一个节点。
   * 焦点变化时同步显示 tooltip 并恢复布局动画以绘制焦点环。
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    // 无节点时所有键都不处理
    if (this.nodes.length === 0) return;

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        this.moveFocus(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        this.moveFocus(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.activateFocusedNode();
        break;
      case 'Escape':
        e.preventDefault();
        this.clearFocus();
        break;
    }
  };

  /**
   * 移动键盘焦点到相邻节点
   *
   * @param direction 1 = 下一个，-1 = 上一个
   */
  private moveFocus(direction: 1 | -1): void {
    // 首次聚焦：从第一个节点开始
    if (this.focusedNodeIndex === -1) {
      this.focusedNodeIndex = direction === 1 ? 0 : this.nodes.length - 1;
    } else {
      // 循环移动（+ nodes.length 防止负数取模）
      this.focusedNodeIndex =
        (this.focusedNodeIndex + direction + this.nodes.length) % this.nodes.length;
    }

    const node = this.nodes[this.focusedNodeIndex];
    if (!node) return;

    // 恢复动画以绘制焦点环
    this.layoutStable = false;
    this.stableFrameCount = 0;

    // 键盘焦点变化时显示 tooltip
    this.showTooltip(node);

    // 将焦点节点定位到 tooltip（用节点屏幕坐标近似鼠标位置）
    const rect = this.canvas.getBoundingClientRect();
    const screenX = node.x * this.zoom + this.cameraX + rect.left;
    const screenY = node.y * this.zoom + this.cameraY + rect.top;
    this.updateTooltipPosition(screenX, screenY);
  }

  /**
   * 激活当前键盘焦点节点（Enter / Space → 触发 onNodeClick）
   */
  private activateFocusedNode(): void {
    if (this.focusedNodeIndex === -1) return;
    const node = this.nodes[this.focusedNodeIndex];
    if (node && this.onNodeClick) {
      this.onNodeClick(node.id);
    }
  }

  /**
   * 清除键盘焦点状态
   *
   * 重置 focusedNodeIndex 并隐藏 tooltip，
   * 恢复动画以擦除焦点环。
   */
  private clearFocus(): void {
    if (this.focusedNodeIndex === -1) return;
    this.focusedNodeIndex = -1;
    this.hideTooltip();
    this.layoutStable = false;
    this.stableFrameCount = 0;
  }

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