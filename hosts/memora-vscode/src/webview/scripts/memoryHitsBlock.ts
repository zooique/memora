/**
 * 记忆命中的行内容块（CHATVIEW-SLIM-2 第 5 刀·零状态批，自 chatView.ts 外置）
 *
 * 域职责：把「某次工具调用命中的记忆」渲染成明细项 / 明细块（MEM-EVENT-2 主落位）。
 *
 * **边界**：无状态、无定时器；只依赖 `document` 与 `vscode`（命中项的软删反馈通道）。
 * 两个消费者：过程流工具行（`processFlowCells.renderToolRow`）与实时记忆命中块
 * （`chatView.renderMemoryHits`）——单一定义、两处消费，禁各自手搓一份。
 *
 * @module memoryHitsBlock
 */
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import { getIconSvg } from './icons.js';
import type { MemoryHitEntry } from '../helpers/processFlowModel.js';

/** 记忆命中块依赖：文档对象 + 宿主通信（软删反馈） */
export interface MemoryHitsBlockDeps {
  /** webview 文档对象（禁在模块内读全局 document） */
  document: Document;
  /** 宿主通信 API（命中项「移入回收站」发 memory_delete） */
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
}

/** 记忆命中块窄接口：两个消费者各自取所需，内部构造函数零暴露 */
export interface MemoryHitsBlock {
  /** 命中明细项（`memory-hits__item` 列表，含软删按钮） */
  buildItems(hits: Iterable<[string, MemoryHitEntry]>): HTMLElement[];
  /** 命中明细块（标题行 + 明细列表；挂在工具行体内，刻意不再套 details） */
  buildBlock(hits: Map<string, MemoryHitEntry>): HTMLElement;
  /**
   * 「记忆 N」收起态徽章（规格单一副本，MEMO-BADGE-1 收口）：重建路径
   * （`processFlowCells.renderToolRow`）与实时挂载路径（`toolRowView.attachMemoryHits`）
   * 都从本函数取徽章，禁再各自手搓类名/文案/title——两链可独立变化是第二刀变异实证过的
   * 漂移面，这里收口为一份。
   *
   * @param hitCount 命中条数（徽章只关心数量，不持有 hits 明细）
   */
  createBadge(hitCount: number): HTMLSpanElement;
}

/**
 * 创建记忆命中块构造器。
 *
 * @param deps 文档对象 + 宿主通信
 */
export function createMemoryHitsBlock(deps: MemoryHitsBlockDeps): MemoryHitsBlock {
  const { document, vscode } = deps;

  /**
   * 记忆命中项构建器（单一真理源）：source 徽章 + 正文主行 + ✕ 反馈按钮。
   *
   * 两个消费面共用本函数——① 工具折叠块体内明细（MEM-EVENT-2 主落位，见
   * buildMemoryHitsBlock）；② 无配对对象的兜底轮次行（见 renderMemoryHits）。
   * 共用理由不是省代码：S3-3 反馈通道靠 `data-memory-id` 寻址，两处各写一份必然腐化
   * （漏挂一处 = 该处 ✕ 静默失效，而失效表现为「点了没反应」，是最难被发现的带伤形态）。
   * 列表项 textContent 构建防注入。
   *
   * @param hits [记忆 id, 命中项] 序列（Map 迭代序 = 到达序）
   */
  function buildMemoryHitItems(hits: Iterable<[string, MemoryHitEntry]>): HTMLElement[] {
    const items: HTMLElement[] = [];
    for (const [id, hit] of hits) {
      const item = document.createElement('div');
      item.className = 'memory-hits__item';
      // id 锚进 DOM：反馈通道按此寻址（memory_deleted 应答按 id 全局摘除，含已归档轮）
      item.dataset.memoryId = id;
      const source = document.createElement('span');
      source.className = 'memory-hits__source';
      source.textContent = hit.source;
      // 主行 = 命中正文（用户心智：这条记忆记住了什么）；contentPreview 缺失
      //（老内核/老证据）回退 name，name 也缺回退 id（不静默空行）。
      const name = document.createElement('span');
      name.className = 'memory-hits__name';
      name.textContent = hit.contentPreview || hit.name || id;
      name.title = hit.contentPreview ? hit.name : '';
      item.appendChild(source);
      item.appendChild(name);
      // 反馈入口（HOST-S3-3）：「没用/已过时」→ 发 memory_delete 软删该记忆
      //（宿主模态二次确认，回收站可恢复）；stopPropagation 防触发外层 <details> 折叠
      //（与 memoryView 卡片 ✕ 同范式，图标用 icons.ts close——字符图标被 iconLanguage 守卫拦）。
      const removeBtn = document.createElement('button');
      removeBtn.className = 'memory-hits__remove';
      removeBtn.type = 'button';
      removeBtn.title = '没用/已过时？移入回收站（可恢复）';
      removeBtn.setAttribute('aria-label', `反馈无用：${hit.contentPreview || hit.name || id}`);
      removeBtn.innerHTML = getIconSvg('close', 10, 10); // 静态 SVG，无外部输入
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'memory_delete', id });
      });
      item.appendChild(removeBtn);
      items.push(item);
    }
    return items;
  }

  /**
   * 单次记忆召回工具行内的命中明细块（MEM-EVENT-2 主落位）。
   *
   * 形态 = `标题行（本次命中 N 条记忆）+ 命中项平铺`，**刻意不再套一层 <details>**：
   * 父级工具行本身已是折叠体，双层折叠是同义重复（用户要点两次才见到明细）。
   * 代价与补偿：明细随工具行默认收起（成功行 open=false），故行摘要另挂「记忆 N」徽章
   * （见 toolRowView.attachMemoryHits），保证收起态仍保留「这次调用看过记忆」这一事实——
   * 落位迁移不得吃掉原本可见的信息。
   *
   * @param hits 该 toolCallId 下的命中（块内已按记忆 id 去重）
   */
  function buildMemoryHitsBlock(hits: Map<string, MemoryHitEntry>): HTMLElement {
    const box = document.createElement('div');
    box.className = 'round-block__memory-hits';
    const label = document.createElement('div');
    label.className = 'memory-hits__label';
    label.textContent = `本次命中 ${hits.size} 条记忆`;
    box.appendChild(label);
    const list = document.createElement('div');
    list.className = 'memory-hits__list';
    for (const item of buildMemoryHitItems(hits)) list.appendChild(item);
    box.appendChild(list);
    return box;
  }

  /**
   * 「记忆 N」徽章（规格唯一副本，MEMO-BADGE-1 收口）。文案与 title 是用户可读面：
   * 收起态下它是「这次调用看过记忆」的唯一可见证据（见 buildMemoryHitsBlock 注释的
   * 「落位迁移不得吃掉原本可见的信息」），故全文锁在这里，改动即两路径同时生效。
   *
   * @param hitCount 命中条数
   */
  function createMemoryBadge(hitCount: number): HTMLSpanElement {
    const badge = document.createElement('span');
    badge.className = 'round-block__memory-badge';
    badge.textContent = `记忆 ${hitCount}`;
    badge.title = `本次调用命中 ${hitCount} 条记忆（展开查看明细）`;
    return badge;
  }

  return { buildItems: buildMemoryHitItems, buildBlock: buildMemoryHitsBlock, createBadge: createMemoryBadge };
}
