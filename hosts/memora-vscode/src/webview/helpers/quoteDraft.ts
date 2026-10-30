/**
 * 引用回复快照草稿（COPY-2 真机反馈形态优化）：右键「引用回复」的暂存态
 *
 * 语义边界（防与文件引用混淆）：文件引用（ChatRef）= **指针**（挂路径，正文模型按需
 * 读取）；本快照 = **文本快照**（选中内容即刻定格，原消息删改不影响胶囊）——两者消费
 * 链完全不同（指针走协议 refs 字段注入，快照发送时展开为引用块拼进 text），**不合并、
 * 不进协议**（快照无协议字段，纯 webview 本地态，宿主不知情）。
 *
 * 形态：skill-chip 同构胶囊（「引用：摘要」+ ✕ 移除），与文件引用 chip 混排在
 * refChipRow（同一行 = 都是「本轮挂载的引用」）。渲染编排归 renderAttachmentRow
 * （refChipRow 全清重绘的单点），本模块只持状态 + 纯构造 chip——两处渲染 = 漂移。
 *
 * 生命周期：单枚（再引用 = 替换）；发送后无条件清（快照即焚，无 pin 语义）；手动 ✕ 清。
 */
import { getIconSvg } from '../scripts/icons.js';

/** 摘要可见字符上限（超出截断加省略号；全文在 title） */
const SUMMARY_MAX = 24;

/** 快照摘要：首行 trim，超限截断加省略号（多行选区首行往往不是语义主体，title 补全文） */
function summarize(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX)}…` : firstLine;
}

/**
 * 规范引用块（发送展开形态）：**每行**都加 `> ` 前缀——markdown blockquote 的多行
 * 语法要求逐行前缀，只给首行加（旧直塞形态）会让第二行起掉出引用块混入正文。
 */
export function buildQuotedBlock(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export interface QuoteDraft {
  /** 暂存快照（替换语义：已有草稿再引用 = 覆盖） */
  set(text: string): void;
  clear(): void;
  /** 当前快照原文（无草稿 = 空串） */
  get(): string;
  /** 按当前状态构造胶囊（无草稿 = null）；由 renderAttachmentRow 编排挂载 */
  chip(): HTMLElement | null;
  /**
   * 发送消费：有草稿 = 规范引用块置顶拼在 raw 前（`\n\n` 分隔）并**清状态**（快照即焚，
   * 发送即消费——发送链无需另调 clear）；无草稿 = 原样返回 raw。发送文本组装单点。
   */
  consumeFor(raw: string): string;
}

export function createQuoteDraft(deps: {
  document: Document;
  /** ✕ 移除后的回调（chatView 借此触发 renderAttachmentRow 同步行显隐） */
  onRemove?: () => void;
}): QuoteDraft {
  let snapshot = '';
  const { document, onRemove } = deps;

  return {
    set(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return; // 空选区不建立草稿（调用方 when 已挡，此处兜底）
      snapshot = trimmed;
    },
    clear(): void {
      snapshot = '';
    },
    get(): string {
      return snapshot;
    },
    consumeFor(raw: string): string {
      if (!snapshot) return raw;
      const block = buildQuotedBlock(snapshot);
      snapshot = '';
      return `${block}\n\n${raw}`;
    },
    chip(): HTMLElement | null {
      if (!snapshot) return null;
      const chip = document.createElement('span');
      chip.className = 'skill-chip';
      const name = document.createElement('span');
      name.className = 'skill-chip__name';
      name.textContent = `引用：${summarize(snapshot)}`;
      // 全文放 title（摘要截断的补偿）；非文件指针，无跳转语义 ⇒ 不可点、无 role=button
      name.title = snapshot;
      chip.appendChild(name);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'skill-chip__remove';
      // 图标走 icons.ts 单点（与引用 chip ✕ 同源，禁手抄 SVG = 第二真理源）
      remove.innerHTML = getIconSvg('close', 11, 11);
      remove.setAttribute('title', '移除引用');
      remove.setAttribute('aria-label', `移除引用：${summarize(snapshot)}`);
      remove.addEventListener('click', () => {
        snapshot = '';
        onRemove?.();
      });
      chip.appendChild(remove);
      return chip;
    },
  };
}
