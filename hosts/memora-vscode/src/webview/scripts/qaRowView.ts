/**
 * 问答回顾行构造（CHATVIEW-SLIM-3 首刀·零状态批，自 chatView.ts 外置）
 *
 * 域职责：把一轮用户输入（回答 / 补充 / 超时未答）构造成 `.round-block__input` 行，
 * 携带 question 时先渲染只读「问」行以还原提问上下文。
 *
 * **边界（与 `processFlowCells` 同一形态宪法）**：不持有 chatView 状态、不注册监听、
 * 不启定时器 ⇒ 无 `dispose`；DOM 入口只经 deps 注入的 `document`。
 *
 * @module qaRowView
 */

/** 问答行构造依赖：仅文档对象 */
export interface QaRowViewDeps {
  /** webview 文档对象（构造唯一 DOM 入口；禁在模块内读全局 document） */
  document: Document;
}

/** 问答行窄接口：chatView 仅经此驱动 */
export interface QaRowView {
  /** 构造问答回顾行（tag 语义按 kind 映射，文本经 textContent 上屏） */
  renderQaItem(
    text: string,
    kind: 'question-answer' | 'supplement' | 'timeout' | 'unanswered',
    question?: string,
    options?: string[],
  ): HTMLElement;
}

export function createQaRowView(deps: QaRowViewDeps): QaRowView {
  const { document } = deps;

  function renderQaItem(
    text: string,
    kind: 'question-answer' | 'supplement' | 'timeout' | 'unanswered',
    question?: string,
    options?: string[],
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'round-block__input';
    // 提问回顾行：question-answer/timeout/unanswered 携带 question 时先渲染只读「问」行
    //（还原提问上下文；unanswered = 崩溃收场转化 / 作答批次内跳过题的「问了没答」，问行同样可考）
    if ((kind === 'question-answer' || kind === 'timeout' || kind === 'unanswered') && question) {
      const q = document.createElement('div');
      q.className = 'round-block__input-q';
      const qTag = document.createElement('span');
      qTag.className = 'round-block__input-tag';
      qTag.textContent = '问';
      const qTxt = document.createElement('span');
      qTxt.className = 'round-block__input-text';
      qTxt.textContent = question;
      q.append(qTag, qTxt);
      if (options && options.length > 0) {
        const opts = document.createElement('span');
        opts.className = 'round-block__input-opts';
        opts.textContent = `候选：${options.join(' ｜ ')}`;
        q.appendChild(opts);
      }
      row.appendChild(q);
    }
    // 内容行：tag 语义映射（回答 →「你答」；补充 →「你补充」；超时/崩溃未答 →「未回答」）
    const main = document.createElement('div');
    main.className = 'round-block__input-row';
    const tag = document.createElement('span');
    tag.className = 'round-block__input-tag';
    tag.textContent =
      kind === 'supplement' ? '你补充' : kind === 'question-answer' ? '你答' : '未回答';
    const txt = document.createElement('span');
    txt.className = 'round-block__input-text';
    txt.textContent = text;
    main.append(tag, txt);
    row.appendChild(main);
    return row;
  }

  return { renderQaItem };
}
