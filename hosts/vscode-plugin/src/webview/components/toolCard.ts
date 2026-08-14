/**
 * 工具调用卡片组件 — 可复用、不绑定面板，对齐 memora-sprite toolCallCard
 *
 * 设计（组件化，兼容 webview 内联字符串约束）：
 *   - 暴露 window.ToolCard = { show, update }，面板脚本调用；
 *   - show(container, id, name, args)：在容器内渲染「执行中」卡片（默认折叠标题行）；
 *   - update(container, id, name, ok, summary)：按 data-tool-call-id 定位并更新状态；
 *   - 折叠/展开用事件委托 + closest，避免 CSS 选择器注入风险；
 *   - 依赖 getToolDisplayName（见 helpers/toolNameMap.ts，须先注入）。
 */
export const toolCardScript = `
window.ToolCard = (function () {
  function findCard(container, id) {
    var cards = container.querySelectorAll('.tool-card');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-tool-call-id') === id) return cards[i];
    }
    return null;
  }
  function show(container, id, name, args) {
    var card = document.createElement('div');
    card.className = 'tool-card is-running';
    card.setAttribute('data-tool-call-id', id);

    var header = document.createElement('button');
    header.type = 'button';
    header.className = 'tool-card__header';
    var chevron = document.createElement('span');
    chevron.className = 'tool-card__chevron';
    chevron.textContent = '▾';
    var nameSpan = document.createElement('span');
    nameSpan.className = 'tool-card__name';
    nameSpan.textContent = getToolDisplayName(name);
    nameSpan.title = name;
    var spinner = document.createElement('span');
    spinner.className = 'tool-card__spinner';
    var status = document.createElement('span');
    status.className = 'tool-card__status';
    status.textContent = '执行中…';
    header.appendChild(chevron);
    header.appendChild(nameSpan);
    header.appendChild(spinner);
    header.appendChild(status);
    card.appendChild(header);

    if (args) {
      var argsDiv = document.createElement('div');
      argsDiv.className = 'tool-card__args';
      argsDiv.textContent = args;
      card.appendChild(argsDiv);
    }
    container.appendChild(card);
    container.scrollTop = container.scrollHeight;
    return card;
  }
  function update(container, id, name, ok, summary) {
    var card = findCard(container, id);
    if (!card) return;
    card.classList.remove('is-running');
    card.classList.add(ok ? 'is-success' : 'is-failed');
    var spinner = card.querySelector('.tool-card__spinner');
    if (spinner) spinner.remove();
    var status = card.querySelector('.tool-card__status');
    if (status) status.textContent = (ok ? '✓ ' : '✗ ') + (ok ? '成功' : '失败');
    if (summary) {
      var resultDiv = document.createElement('div');
      resultDiv.className = 'tool-card__result';
      resultDiv.textContent = summary;
      card.appendChild(resultDiv);
    }
    // 完成后自动折叠，减少视觉干扰（对齐 sprite）
    card.classList.add('is-collapsed');
  }
  // 兜底终结：本轮流式结束后，把容器内所有残留「执行中」卡片标记为失败（中断态），
  // 避免 tool_start 后流异常/中断（error/超时）时卡片永远停在 spinner（对抗评估 P1-1）。
  // 幂等：无 is-running 卡片时无操作，可安全在 error 与 done 处重复调用。
  function settleRunning(container, label) {
    var cards = container.querySelectorAll('.tool-card.is-running');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.remove('is-running');
      cards[i].classList.add('is-failed');
      var spinner = cards[i].querySelector('.tool-card__spinner');
      if (spinner) spinner.remove();
      var status = cards[i].querySelector('.tool-card__status');
      if (status) status.textContent = label || '已中断';
    }
  }
  // 折叠/展开：事件委托，一次性注册
  if (!window.__toolCardDelegated) {
    window.__toolCardDelegated = true;
    document.addEventListener('click', function (e) {
      var header = e.target && e.target.closest ? e.target.closest('.tool-card__header') : null;
      if (header) {
        var card = header.closest('.tool-card');
        if (card) card.classList.toggle('is-collapsed');
        e.stopPropagation();
      }
    });
  }
  return { show: show, update: update, settleRunning: settleRunning };
})();`;