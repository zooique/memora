/**
 * 记忆详情面板子系统辅助（从 memoryPanelManager.ts 提取）
 *
 * 职责：
 *   集中管理记忆详情弹窗的渲染逻辑，降低 memoryPanelManager.ts 体量。涵盖：
 *   - 记忆详情模态框渲染（基本信息 + 关联记忆列表 + dataset 状态保存）
 *   - 演化脉络路径追溯渲染（Phase 5.1：BFS 多跳 incoming 方向）
 *   - 直接邻居视图渲染（Phase 5.2：both 方向 1 跳全景）
 *
 * 提取原因：
 *   memoryPanelManager.ts 超标（1968 行，超 1800 触发线）。
 *   记忆详情相关方法（showMemoryDetail + showMemoryLineage + showMemoryNeighbors）
 *   形成完整子系统，相对独立，适合提取为接受 context 的纯函数模块。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过 MemoryDetailPanelContext 注入
 *   - 编辑模式状态（isEditing）通过 getter/setter 访问
 *   - 回调（memoryClickCallback/memoryEditCallback/memoryDiscussCallback）通过 getter 读取
 *   - type-only 导入 MemoryPanelHost 避免运行时循环依赖
 *
 * 先例：
 *   参照 memoryPanelEvents.ts 的提取模式，本次为记忆详情拆分
 */

import { getOptionalElement, clearElement, formatTimeAgo } from './domHelpers.js';
import { getSourceColorClass } from './sourceColor.js';
// 类型仅导入：运行时不会产生循环依赖（type-only 在编译期擦除）
import type { MemoryPanelHost } from '../panels/memoryPanelManager.js';
import type { EventTracker } from './eventTracker.js';
import type { MemoryDetail, RelationPath, RelationNeighbor } from '../types.js';

// ─── 上下文接口（依赖注入容器） ────────────────────────────

/**
 * 记忆详情面板子系统所需的上下文
 *
 * 由 MemoryPanelManager 构建并传入。设计为接口而非直接传入 manager 实例，
 * 避免运行时循环依赖并便于独立测试。
 */
export interface MemoryDetailPanelContext {
  // ─── 宿主能力 ───
  readonly host: MemoryPanelHost;
  /** 事件跟踪器（用于注册关联记忆/脉络/邻居节点的点击和键盘事件） */
  readonly events: EventTracker;

  // ─── 状态访问器 ───
  /** 获取编辑模式状态（true 时 textarea 已替换 pre） */
  getIsEditing(): boolean;
  /** 设置编辑模式状态 */
  setIsEditing(editing: boolean): void;
  /** 获取记忆详情模态框元素（可能为 null，缺失时详情功能降级） */
  getMemoryDetailModal(): HTMLElement | null;

  // ─── 回调读取器（onXxx 注册晚于 init，用 getter 读取最新值） ───
  /** 获取记忆点击回调（点击关联记忆/脉络节点/邻居节点 → 显示对应记忆详情） */
  getMemoryClickCallback(): ((id: string) => void) | null;
}

// ─── 记忆详情渲染 ────────────────────────────────────────

/**
 * 显示记忆详情模态框
 *
 * 渲染记忆的基本信息（名称/source/评分/创建时间/访问时间/内容）和关联记忆列表，
 * 同时重置演化脉络和直接邻居区域（异步加载完成后由 controller 注入）。
 * 保存当前记忆 ID 到 dataset，供编辑/删除按钮使用。
 *
 * @param ctx 记忆详情面板上下文
 * @param memory 记忆详情数据
 */
export function showMemoryDetail(ctx: MemoryDetailPanelContext, memory: MemoryDetail): void {
  const modal = ctx.getMemoryDetailModal();
  if (!modal) return;

  // 打开详情时退出编辑模式，恢复只读状态
  ctx.setIsEditing(false);

  // Phase 5.1：重置演化脉络区域（避免显示上一次详情的残留数据）
  // 实际脉络数据由 controller 异步加载完成后调用 showMemoryLineage 注入
  resetLineage();
  // Phase 5.2：重置直接邻居区域（同脉络模式，异步加载完成后注入）
  resetNeighbors();

  const nameEl = getOptionalElement('memory-detail-name', 'h3');
  const sourceEl = getOptionalElement('memory-detail-source', 'code');
  const scoreEl = getOptionalElement('memory-detail-score', 'span');
  const createdEl = getOptionalElement('memory-detail-created', 'span');
  const accessedEl = getOptionalElement('memory-detail-accessed', 'span');
  const contentEl = getOptionalElement('memory-detail-content', 'pre');
  const relationsEl = document.getElementById('memory-detail-relations');
  const relationsListEl = document.getElementById('memory-relations-list');

  if (nameEl) nameEl.textContent = memory.name;
  if (sourceEl) {
    sourceEl.textContent = memory.source;
    // source 标签颜色区分（与列表保持一致）
    sourceEl.className = `source-${getSourceColorClass(memory.source)}`;
  }
  if (scoreEl) scoreEl.textContent = memory.score.toFixed(2);
  // R5 详情面板日期用 formatTimeAgo 统一格式化（ISO → 相对时间）
  if (createdEl) createdEl.textContent = formatTimeAgo(memory.createdAt);
  if (accessedEl) accessedEl.textContent = formatTimeAgo(memory.accessedAt);
  if (contentEl) contentEl.textContent = memory.content;

  // 保存原始内容到 dataset，供编辑取消时恢复
  if (contentEl) contentEl.dataset.originalContent = memory.content;

  // 渲染关联记忆列表
  if (relationsEl && relationsListEl) {
    if (memory.relations.length > 0) {
      relationsEl.classList.remove('hidden');
      // 使用 clearElement 替代 innerHTML=''，遵循统一 DOM 操作模式
      clearElement(relationsListEl);
      for (const rel of memory.relations) {
        const item = document.createElement('div');
        item.className = `relation-item relation-type-${rel.type}`;
        item.dataset.memoryId = rel.targetId;
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'button');

        const typeTag = document.createElement('span');
        typeTag.className = `relation-type-tag relation-type-${rel.type}`;
        typeTag.textContent = rel.type;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'relation-target-name';
        nameSpan.textContent = rel.targetName;

        const weightSpan = document.createElement('span');
        weightSpan.className = 'relation-weight';
        weightSpan.textContent = `w:${rel.weight.toFixed(2)}`;

        item.appendChild(typeTag);
        item.appendChild(nameSpan);
        item.appendChild(weightSpan);

        // 点击关联记忆 → 触发 memoryClickCallback 查看该记忆详情
        const openRelation = () => {
          ctx.getMemoryClickCallback()?.(rel.targetId);
        };
        ctx.events.addEventListener(item, 'click', openRelation);
        ctx.events.addEventListener(item, 'keydown', (e: Event) => {
          if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
            e.preventDefault();
            openRelation();
          }
        });

        relationsListEl.appendChild(item);
      }
    } else {
      relationsEl.classList.add('hidden');
    }
  }

  // 记录当前查看的记忆 ID（供删除/编辑按钮使用）
  modal.dataset.memoryId = memory.id;
  // 保存 source 和 name 到 dataset，供编辑保存时使用
  modal.dataset.memorySource = memory.source;
  modal.dataset.memoryName = memory.name;

  // 切换按钮可见性：只读模式显示编辑/删除，隐藏保存/取消
  updateDetailButtons(ctx.getIsEditing());
  ctx.host.showModal('memory-detail-modal');
}

// ─── 演化脉络（Phase 5.1：路径追溯） ────────────────────

/**
 * 重置演化脉络区域
 *
 * 在 showMemoryDetail 开头调用，清空上一次的脉络数据并隐藏区域。
 * 实际脉络数据由 controller 异步加载完成后调用 showMemoryLineage 注入。
 */
export function resetLineage(): void {
  const lineageEl = document.getElementById('memory-detail-lineage');
  const lineageListEl = document.getElementById('memory-lineage-list');
  if (lineageEl) lineageEl.classList.add('hidden');
  if (lineageListEl) clearElement(lineageListEl);
}

/**
 * 显示演化脉络空状态文案
 *
 * 当 BFS 返回空路径或仅起点节点（无上游来源）时调用，
 * 显示"暂无演化脉络"提示用户该记忆暂无来源链。
 */
function showLineageEmpty(): void {
  const lineageEl = document.getElementById('memory-detail-lineage');
  const lineageListEl = document.getElementById('memory-lineage-list');
  if (!lineageEl || !lineageListEl) return;
  clearElement(lineageListEl);
  const empty = document.createElement('div');
  empty.className = 'lineage-empty';
  empty.textContent = '暂无演化脉络';
  lineageListEl.appendChild(empty);
  lineageEl.classList.remove('hidden');
}

/**
 * 显示演化脉络加载失败状态 + 重试按钮
 *
 * 异步加载脉络 IPC 失败时调用，在脉络子区域显示"加载失败"文案和重试按钮。
 * 重试按钮通过 EventTracker 绑定 click 事件，cleanup 时统一清理。
 *
 * @param ctx 记忆详情面板上下文（提供 EventTracker 绑定重试事件）
 * @param onRetry 重试回调（点击重试按钮触发，通常为重新加载脉络）
 */
export function showLineageError(ctx: MemoryDetailPanelContext, onRetry: () => void): void {
  const lineageEl = document.getElementById('memory-detail-lineage');
  const lineageListEl = document.getElementById('memory-lineage-list');
  if (!lineageEl || !lineageListEl) return;
  clearElement(lineageListEl);
  const errorBox = document.createElement('div');
  errorBox.className = 'lineage-error';
  const msg = document.createElement('span');
  msg.textContent = '加载失败';
  const retryBtn = document.createElement('button');
  retryBtn.className = 'panel-error-btn inline-retry-btn';
  retryBtn.textContent = '重试';
  ctx.events.addEventListener(retryBtn, 'click', onRetry);
  errorBox.append(msg, retryBtn);
  lineageListEl.appendChild(errorBox);
  lineageEl.classList.remove('hidden');
}

/**
 * 渲染演化脉络（异步加载完成后注入）
 *
 * 将 RelationPath[]（BFS 扁平数组 + depth 字段）渲染为按 depth 分组的缩进列表，
 * 展示当前记忆的来源演化链（incoming 方向，多跳追溯）。
 *
 * 设计：
 * - path[0] 是当前记忆（depth=0），高亮标记
 * - 后续节点按 depth 递增缩进，呈现"从哪来"的纵向演化链
 * - 点击节点复用 memoryClickCallback 跳转（与关联列表行为一致）
 * - 空数据或仅起点节点（无上游来源）：显示"暂无演化脉络"空状态文案
 *
 * @param ctx 记忆详情面板上下文
 * @param path 内核 BFS 返回的路径节点数组
 */
export function showMemoryLineage(ctx: MemoryDetailPanelContext, path: RelationPath[]): void {
  const lineageEl = document.getElementById('memory-detail-lineage');
  const lineageListEl = document.getElementById('memory-lineage-list');
  if (!lineageEl || !lineageListEl) return;

  // 空数据或仅起点节点（无上游来源）：显示空状态文案（不再静默隐藏）
  if (!path || path.length <= 1) {
    showLineageEmpty();
    return;
  }

  clearElement(lineageListEl);
  for (const node of path) {
    const item = document.createElement('div');
    // depth 驱动缩进：通过 CSS 变量 --lineage-depth 传递层级，CSS 中 calc 计算实际 padding-left
    // （遵循"UI 组件通过 CSS 变量驱动"规则，避免 inline style 硬编码）
    item.className = 'lineage-item';
    item.style.setProperty('--lineage-depth', String(node.depth));
    item.dataset.memoryId = node.memoryId;
    item.setAttribute('tabindex', '0');
    item.setAttribute('role', 'button');

    // depth 标签：起点显示"当前"，其他显示层级数字
    const depthTag = document.createElement('span');
    depthTag.className = 'lineage-depth-tag';
    depthTag.textContent = node.depth === 0 ? '当前' : `L${node.depth}`;

    // source 标签：颜色区分（复用列表项 source 配色）
    const sourceTag = document.createElement('span');
    sourceTag.className = `lineage-source-tag source-${getSourceColorClass(node.memorySource)}`;
    sourceTag.textContent = node.memorySource;

    // 关系类型标签（起点节点 relationType 为 null，不显示）
    if (node.relationType) {
      const relTag = document.createElement('span');
      relTag.className = `lineage-relation-tag relation-type-${node.relationType}`;
      relTag.textContent = node.relationType;
      item.appendChild(relTag);
    }

    // 记忆名称
    const nameSpan = document.createElement('span');
    nameSpan.className = 'lineage-name';
    nameSpan.textContent = node.memoryName;

    item.appendChild(depthTag);
    item.appendChild(sourceTag);
    item.appendChild(nameSpan);

    // 点击节点 → 触发 memoryClickCallback 跳转查看该记忆详情
    const openNode = () => {
      ctx.getMemoryClickCallback()?.(node.memoryId);
    };
    ctx.events.addEventListener(item, 'click', openNode);
    ctx.events.addEventListener(item, 'keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
        e.preventDefault();
        openNode();
      }
    });

    lineageListEl.appendChild(item);
  }

  lineageEl.classList.remove('hidden');
}

// ─── Phase 5.2：直接邻居视图 ───────────────────────────

/**
 * 重置直接邻居区域
 *
 * 在 showMemoryDetail 开头调用，清空上一次的邻居数据并隐藏区域。
 * 实际邻居数据由 controller 异步加载完成后调用 showMemoryNeighbors 注入。
 */
export function resetNeighbors(): void {
  const neighborsEl = document.getElementById('memory-detail-neighbors');
  const neighborsListEl = document.getElementById('memory-neighbors-list');
  if (neighborsEl) neighborsEl.classList.add('hidden');
  if (neighborsListEl) clearElement(neighborsListEl);
}

/**
 * 显示直接邻居空状态文案
 *
 * 当内核返回空邻居列表时调用，显示"暂无关联邻居"提示用户该记忆无直接关联。
 */
function showNeighborsEmpty(): void {
  const neighborsEl = document.getElementById('memory-detail-neighbors');
  const neighborsListEl = document.getElementById('memory-neighbors-list');
  if (!neighborsEl || !neighborsListEl) return;
  clearElement(neighborsListEl);
  const empty = document.createElement('div');
  empty.className = 'lineage-empty';
  empty.textContent = '暂无关联邻居';
  neighborsListEl.appendChild(empty);
  neighborsEl.classList.remove('hidden');
}

/**
 * 显示直接邻居加载失败状态 + 重试按钮
 *
 * 异步加载邻居 IPC 失败时调用，在邻居子区域显示"加载失败"文案和重试按钮。
 * 重试按钮通过 EventTracker 绑定 click 事件，cleanup 时统一清理。
 *
 * @param ctx 记忆详情面板上下文（提供 EventTracker 绑定重试事件）
 * @param onRetry 重试回调（点击重试按钮触发，通常为重新加载邻居）
 */
export function showNeighborsError(ctx: MemoryDetailPanelContext, onRetry: () => void): void {
  const neighborsEl = document.getElementById('memory-detail-neighbors');
  const neighborsListEl = document.getElementById('memory-neighbors-list');
  if (!neighborsEl || !neighborsListEl) return;
  clearElement(neighborsListEl);
  const errorBox = document.createElement('div');
  errorBox.className = 'lineage-error';
  const msg = document.createElement('span');
  msg.textContent = '加载失败';
  const retryBtn = document.createElement('button');
  retryBtn.className = 'panel-error-btn inline-retry-btn';
  retryBtn.textContent = '重试';
  ctx.events.addEventListener(retryBtn, 'click', onRetry);
  errorBox.append(msg, retryBtn);
  neighborsListEl.appendChild(errorBox);
  neighborsEl.classList.remove('hidden');
}

/**
 * 渲染直接关联邻居（异步加载完成后注入）
 *
 * 将 RelationNeighbor[]（both 方向，1 跳）渲染为扁平列表，
 * 展示当前记忆的所有直接关联记忆（演化脉络是 incoming 多跳追溯，邻居是 both 方向 1 跳全景）。
 *
 * 设计：
 * - 与 showMemoryLineage 同构，复用 lineage-item 样式体系
 * - direction 标签区分"来源"/"去向"（incoming = 邻居指向当前记忆，outgoing = 当前记忆指向邻居）
 * - 点击节点复用 memoryClickCallback 跳转（与脉络/关联列表行为一致）
 * - 空数组显示"暂无关联邻居"空状态文案
 *
 * @param ctx 记忆详情面板上下文
 * @param neighbors 内核返回的邻居节点数组
 */
export function showMemoryNeighbors(ctx: MemoryDetailPanelContext, neighbors: RelationNeighbor[]): void {
  const neighborsEl = document.getElementById('memory-detail-neighbors');
  const neighborsListEl = document.getElementById('memory-neighbors-list');
  if (!neighborsEl || !neighborsListEl) return;

  // 空数据：显示空状态文案（不再静默隐藏）
  if (!neighbors || neighbors.length === 0) {
    showNeighborsEmpty();
    return;
  }

  clearElement(neighborsListEl);
  for (const node of neighbors) {
    const item = document.createElement('div');
    // 复用 lineage-item 样式（扁平列表，无缩进，--lineage-depth=0）
    item.className = 'lineage-item';
    item.style.setProperty('--lineage-depth', '0');
    item.dataset.memoryId = node.memoryId;
    item.setAttribute('tabindex', '0');
    item.setAttribute('role', 'button');

    // 方向标签：incoming = 邻居指向当前记忆（来源），outgoing = 当前记忆指向邻居（去向）
    const dirTag = document.createElement('span');
    dirTag.className = `neighbor-direction-tag neighbor-dir-${node.direction}`;
    dirTag.textContent = node.direction === 'incoming' ? '来源' : '去向';

    // source 标签：颜色区分（复用列表项 source 配色）
    const sourceTag = document.createElement('span');
    sourceTag.className = `lineage-source-tag source-${getSourceColorClass(node.memorySource)}`;
    sourceTag.textContent = node.memorySource;

    // 关系类型标签
    const relTag = document.createElement('span');
    relTag.className = `lineage-relation-tag relation-type-${node.relationType}`;
    relTag.textContent = node.relationType;

    // 记忆名称
    const nameSpan = document.createElement('span');
    nameSpan.className = 'lineage-name';
    nameSpan.textContent = node.memoryName;

    item.appendChild(dirTag);
    item.appendChild(sourceTag);
    item.appendChild(relTag);
    item.appendChild(nameSpan);

    // 点击节点 → 触发 memoryClickCallback 跳转查看该记忆详情
    const openNode = () => {
      ctx.getMemoryClickCallback()?.(node.memoryId);
    };
    ctx.events.addEventListener(item, 'click', openNode);
    ctx.events.addEventListener(item, 'keydown', (e: Event) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
        e.preventDefault();
        openNode();
      }
    });

    neighborsListEl.appendChild(item);
  }

  neighborsEl.classList.remove('hidden');
}

// ─── 详情按钮可见性 ────────────────────────────────────────

/**
 * 切换详情弹窗底部按钮可见性
 *
 * 只读模式：显示编辑 + 删除 + 讨论 + 关闭
 * 编辑模式：显示保存 + 取消 + 关闭
 *
 * @param isEditing 当前是否处于编辑模式
 */
export function updateDetailButtons(isEditing: boolean): void {
  const btnEdit = getOptionalElement('btn-memory-edit', 'button');
  const btnDelete = getOptionalElement('btn-memory-delete', 'button');
  const btnDiscuss = getOptionalElement('btn-memory-discuss', 'button');
  const btnEditSave = getOptionalElement('btn-memory-edit-save', 'button');
  const btnEditCancel = getOptionalElement('btn-memory-edit-cancel', 'button');

  if (btnEdit) btnEdit.classList.toggle('hidden', isEditing);
  if (btnDelete) btnDelete.classList.toggle('hidden', isEditing);
  if (btnDiscuss) btnDiscuss.classList.toggle('hidden', isEditing);
  if (btnEditSave) btnEditSave.classList.toggle('hidden', !isEditing);
  if (btnEditCancel) btnEditCancel.classList.toggle('hidden', !isEditing);
}
