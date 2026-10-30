/**
 * 代码块增强视图（CHATVIEW-SLIM-3 后续腾行批 · COPY-2 同域外置）
 *
 * renderMarkdown 后调用：把每个 <pre> 包装为 .code-block（header[语言名 + 复制按钮] + pre）。
 * 语言名取自 marked 渲染的 class="language-xxx"；无语言回退显示 code。复制按钮读取
 * <pre> 内文本。仅最终渲染时增强一次（流式期间不包装，避免节流重绘反复重建 DOM）。
 *
 * 工厂形态（SLIM-3 同型：deps 注入 + 纯 DOM 变换）：无定时器 / 无全局监听
 * （copyBtn 监听挂在被增强的 DOM 上随 DOM 生命周期走）⇒ 无 dispose。
 */
import type { copyText } from '../helpers/selectionClipboard.js';

export function createCodeBlockEnhancer({
  document,
  copyText: copy,
}: {
  document: Document;
  copyText: typeof copyText;
}): { enhance(container: HTMLElement): void } {
  /**
   * 代码块增强（吸收养分：对齐 TraeWork 代码块「语言标签 + 一键复制」）
   *
   * @param container 已渲染 markdown 的消息正文容器
   */
  function enhanceCodeBlocks(container: HTMLElement): void {
    container.querySelectorAll('pre').forEach((pre) => {
      // 已增强（history 回放多次渲染防重复包装）
      if (pre.parentElement?.classList.contains('code-block')) return;
      const code = pre.querySelector('code');
      const lang = (code?.className.match(/language-([\w-]+)/) ?? [])[1] ?? 'code';
      const block = document.createElement('div');
      block.className = 'code-block';
      const header = document.createElement('div');
      header.className = 'code-block__header';
      const langEl = document.createElement('span');
      langEl.className = 'code-block__lang';
      langEl.textContent = lang;
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'code-block__copy';
      copyBtn.textContent = '复制';
      copyBtn.title = '复制代码';
      copyBtn.addEventListener('click', () => copy(code?.textContent ?? ''));
      header.appendChild(langEl);
      header.appendChild(copyBtn);
      // 用 .code-block 包裹原 <pre>（replaceWith 把 pre 移入 block）
      pre.replaceWith(block);
      block.appendChild(header);
      block.appendChild(pre);
    });
  }
  return { enhance: enhanceCodeBlocks };
}
