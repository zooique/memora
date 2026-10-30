/**
 * 用户气泡限高折叠（CHATVIEW-SLIM 后续腾行批 · COPY-2 行数账同批外置）
 *
 * 工厂形态（SLIM 同型：deps 注入 + 纯 DOM 行为）。唯一闭包依赖 = 吸底滚动
 * （展开/收起改变高度，吸底时跟随到底部）——注入而非复制逻辑。
 */
export function createClampUserBubble(deps: {
  document: Document;
  /** 吸底滚动（chatView 实例化时绑定消息容器：用户在翻历史时由吸底标记自动静默） */
  scrollToBottom(): void;
}): { clamp(body: HTMLElement, bubble: HTMLElement): void } {
  const { document, scrollToBottom } = deps;
  /**
   * 长输入气泡折叠（SSOT：user 气泡限高唯一实现点）
   *
   * 先加 is-clamped 再比对 scrollHeight / clientHeight——借 CSS 阈值判溢出，JS 不持有
   * 阈值副本（阈值改一处即可）。未溢出的短消息撤掉截断且不留按钮；真溢出才在气泡内
   * 底部插「展开全文」，点击在折叠/展开间切换（文案随之切换）。
   * 必须在 append 之后调用：测量需要元素已在文档流中。
   */
  function clampUserBubble(body: HTMLElement, bubble: HTMLElement): void {
    body.classList.add('is-clamped');
    if (body.scrollHeight <= body.clientHeight) {
      body.classList.remove('is-clamped');
      return;
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'msg-user-more';
    more.textContent = '展开全文';
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      const collapsed = body.classList.toggle('is-clamped');
      more.textContent = collapsed ? '展开全文' : '收起';
      more.setAttribute('aria-expanded', String(!collapsed));
      // 展开/收起改变高度：吸底时跟随到底部（用户在翻历史时由吸底标记自动静默）
      scrollToBottom();
    });
    bubble.appendChild(more);
  }
  return { clamp: clampUserBubble };
}
