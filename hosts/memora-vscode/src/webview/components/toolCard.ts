/**
 * 工具调用卡片组件 — 可复用、不绑定面板，对齐 memora-sprite toolCallCard
 *
 * 阶段 B（对抗评估 P2-1）：由「window.ToolCard 注入字符串」演进为「模块导出对象
 * ToolCard」，供 chatView 直接 import（消除全局污染）。原 toolCardScript 字符串
 * 已随 chatPanel 接线完成删除。
 *
 * DOM 副作用安全：事件委托注册（ensureDelegated）延迟到首次 show() 时执行，模块
 * 顶层不做任何 DOM 操作——保证 extension 端 import 本模块（Node 环境）不崩溃。
 *
 * API：
 *   - show(container, id, name, args)：渲染「执行中」卡片（默认折叠标题行）
 *   - update(container, id, name, ok, summary)：按 data-tool-call-id 定位并更新状态
 *   - settleRunning(container, label)：兜底终结残留「执行中」卡片（P1-1）
 *   - 折叠/展开用事件委托 + closest，避免 CSS 选择器注入风险
 */
import { getToolDisplayName } from '../helpers/toolNameMap.js';
import { getToolIcon } from '../helpers/toolNameMap.js';
import { scrollToBottom } from '../helpers/scrollToBottom.js';

/** 工具调用卡片 API（chatView 直接调用） */
export interface ToolCardApi {
  show(container: HTMLElement, id: string, name: string, args?: string): void;
  update(container: HTMLElement, id: string, name: string, ok: boolean, summary?: string): void;
  /** 兜底终结所有「执行中」卡片为失败（中断态），幂等（P1-1） */
  settleRunning(container: HTMLElement, label?: string): void;
}

// 折叠/展开事件委托：模块级闭包防重复注册，延迟到首次 show 时执行（避免 extension
// 端 import 触发 DOM 副作用）。document 从调用方传入的 container 派生（ownerDocument），
// 消除模块级全局 document 引用，与 chatView 依赖注入的环境隔离策略统一（对抗评估 P2-4）。
let delegated = false;
function ensureDelegated(container: HTMLElement): void {
  if (delegated) return;
  delegated = true;
  const doc = container.ownerDocument;
  doc.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const header = target?.closest ? target.closest('.tool-card__header') : null;
    if (header) {
      header.closest('.tool-card')?.classList.toggle('is-collapsed');
      e.stopPropagation();
    }
  });
}

/** 按 data-tool-call-id 定位卡片 */
function findCard(container: HTMLElement, id: string): HTMLElement | null {
  const cards = container.querySelectorAll('.tool-card');
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i] as HTMLElement;
    if (card.getAttribute('data-tool-call-id') === id) return card;
  }
  return null;
}

/** 渲染「执行中」工具卡片（默认折叠标题行，减少视觉干扰） */
function show(container: HTMLElement, id: string, name: string, args?: string): void {
  ensureDelegated(container);
  // 从容器派生 document：新建卡片与调用方同一文档上下文，消除全局 document 引用（P2-4）
  const doc = container.ownerDocument;
  const card = doc.createElement('div');
  card.className = 'tool-card is-running';
  card.setAttribute('data-tool-call-id', id);

  const header = doc.createElement('button');
  header.type = 'button';
  header.className = 'tool-card__header';
  const chevron = doc.createElement('span');
  chevron.className = 'tool-card__chevron';
  chevron.textContent = '▾';
  // 工具图标：按工具名映射 emoji，提升扫读识别度（ui-redesign.md §7.2）
  const iconSpan = doc.createElement('span');
  iconSpan.className = 'tool-card__icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.textContent = getToolIcon(name);
  const nameSpan = doc.createElement('span');
  nameSpan.className = 'tool-card__name';
  nameSpan.textContent = getToolDisplayName(name);
  nameSpan.title = name;
  const spinner = doc.createElement('span');
  spinner.className = 'tool-card__spinner';
  const status = doc.createElement('span');
  status.className = 'tool-card__status';
  status.textContent = '执行中…';
  header.appendChild(chevron);
  header.appendChild(iconSpan);
  header.appendChild(nameSpan);
  header.appendChild(spinner);
  header.appendChild(status);
  card.appendChild(header);

  if (args) {
    const argsDiv = doc.createElement('div');
    argsDiv.className = 'tool-card__args';
    argsDiv.textContent = args;
    card.appendChild(argsDiv);
  }
  container.appendChild(card);
  scrollToBottom(container);
}

/** 更新工具卡片状态：成功降级为单行胶囊，失败保持卡片展示结果摘要 */
function update(
  container: HTMLElement,
  id: string,
  name: string,
  ok: boolean,
  summary?: string,
): void {
  const card = findCard(container, id);
  if (!card) return;
  card.classList.remove('is-running');
  card.querySelector('.tool-card__spinner')?.remove();
  const status = card.querySelector('.tool-card__status');
  if (ok) {
    // 成功：压缩为单行胶囊（图标 + 名称 + ✓），移除参数/结果详情。
    // 工具成功是过程性反馈，不值得占据垂直空间——对齐大厂 AI Chat 的
    // 「成功工具调用折叠为一行」惯例（metacto AI Chat UX Patterns）。
    card.classList.add('is-success', 'tool-card--capsule');
    if (status) status.textContent = '✓';
    card.querySelector('.tool-card__chevron')?.remove();
    card.querySelector('.tool-card__args')?.remove();
    card.querySelector('.tool-card__result')?.remove();
  } else {
    // 失败：保持卡片 + 结果摘要（可诊断），移除 spinner
    card.classList.add('is-failed');
    if (status) status.textContent = '✗ 失败';
    if (summary) {
      const resultDiv = document.createElement('div');
      resultDiv.className = 'tool-card__result';
      resultDiv.textContent = summary;
      card.appendChild(resultDiv);
    }
    // 完成后自动折叠，减少视觉干扰（对齐 sprite）
    card.classList.add('is-collapsed');
  }
}

/** 兜底终结：把所有残留「执行中」卡片标记为失败（中断态），避免状态悬挂（P1-1） */
function settleRunning(container: HTMLElement, label?: string): void {
  const cards = container.querySelectorAll('.tool-card.is-running');
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i] as HTMLElement;
    card.classList.remove('is-running');
    card.classList.add('is-failed');
    card.querySelector('.tool-card__spinner')?.remove();
    const status = card.querySelector('.tool-card__status');
    if (status) status.textContent = label || '已中断';
  }
}

/** 工具调用卡片（chatView 直接 import 使用，去全局污染） */
export const ToolCard: ToolCardApi = { show, update, settleRunning };
