/**
 * askInlineView — 内联提问卡（HOST-I18N-2 C-3 域外置，自 chatView.ts）
 *
 * 域职责：把内核 `ask_user` 的提问渲染成「逐题点选/输入 → 一次性提交」的内联块，
 * 挂在同轮交互链末位之后。单问与多问共用同一形态（单问 = 只有一个问题的多问）。
 *
 * **边界**：只持有这张卡自身的 DOM 构造与逐题累计状态；**不**判会话相位、**不**选锚点、
 * **不**决定提交后如何续跑——锚点解析 / 等待态光标 / 提交动作全部由调用方以回调注入。
 *
 * 文案：本域自有英文源键（按钮 / 占位符）经 `l10n.t` 解析；提问正文与选项来自内核，
 * 已是用户语言，原样上屏。
 *
 * @module askInlineView
 */

import * as l10n from '@vscode/l10n';
import { MAX_ASK_ANSWER_CHARS } from '../../shared/constants.js';
import type { PendingQuestionDto } from '../../shared/protocol.js';

/** 提问卡依赖（DOM + 四个回流回调） */
export interface AskInlineViewDeps {
  /** webview 文档对象（构造唯一 DOM 入口；幂等清理旧块也靠它） */
  document: Document;
  /** 锚点解析：同轮交互链末位；`null` = 无可用锚点（调用方降级底部 clarifyBar） */
  resolveAnchor: () => HTMLElement | null;
  /** 进入「等待输入」光标态（ask 预检停顿） */
  markWaitingInput: () => void;
  /** 提交聚合回答（按提问顺序原样回传，未答位空串） */
  onSubmit: (answers: string[]) => void;
  /** 滚动消息区到底（新块挂载后可见性） */
  scrollToBottom: () => void;
}

/** 提问卡窄接口：chatView 仅经此驱动 */
export interface AskInlineView {
  /**
   * 渲染（或重建）内联提问块
   *
   * @param questions 提问列表（内核 DTO，原样消费）
   * @returns 内联块元素；无可用锚点时返回 `null`（调用方走 clarifyBar 兜底）
   */
  render(questions: PendingQuestionDto[]): HTMLElement | null;
}

export function createAskInlineView(deps: AskInlineViewDeps): AskInlineView {
  const { document, resolveAnchor, markWaitingInput, onSubmit, scrollToBottom } = deps;

  function render(questions: PendingQuestionDto[]): HTMLElement | null {
    // 锚点 = 同轮交互链末位（提问块/骨架/前一问答对之后；连环 ask 与回答行
    // 共用同一锚点解析——第二次提问框须出现在第一问答对之后而非之前）；
    // 无链接（异常）返回 null 降级 clarifyBar
    const host = resolveAnchor();
    if (!host?.parentNode) return null;
    // 提问等待态：容器操作栏保持隐藏（底部只留 ask-inline 交互块，不出现「复制+时间」）。
    // 防御 interrupted 已提前移除 is-pending 的路径——提问未回答前操作栏不显示，
    // 回答 resume 完成（done）后 finalizeStreaming 再统一显示（SSOT 同态收敛）
    host
      .closest<HTMLElement>('.round-group')
      ?.querySelector<HTMLElement>('.round-group__footer')
      ?.classList.add('is-pending');
    // 光标挂起态「等待输入」：ask 预检停顿（无正文块时 no-op——纯问答轮由 ask-inline 承担可见性）
    markWaitingInput();
    // 幂等：重复提问（如连续多问/多次 turn_update 推送）先移除旧内联块，再挂新
    document.querySelector('.ask-inline')?.remove();
    const box = document.createElement('div');
    box.className = 'ask-inline';
    // 单一形态：单问 = 只有一个问题的多问，统一「逐题点选/输入 → 一次性提交」。
    // 选项点击/输入/提交逻辑单一同源（SSOT），不为单/多问分写两套。answers[i] 逐题累计。
    // **部分作答合法（ASK-PARTIAL-ANSWER-1 判据②）**：至少答一题即可提交，未答项不拦提交、
    // 在按钮上明示「将记为未回答」；提交时按提问顺序**原样**回传（未答位空串），宿主与内核
    // 均按位消费 ⇒ 位次即配对真源，压缩位次即错位。
    const answers: (string | undefined)[] = questions.map(() => undefined);
    let submitBtn: HTMLButtonElement | null = null;
    const syncSubmit = (): void => {
      if (!submitBtn) return;
      const answered = answers.filter((a) => a && a.trim().length > 0).length;
      const missing = questions.length - answered;
      submitBtn.disabled = answered === 0;
      // 只在「已答一部分」时改文案：0 答时按钮 disabled，此时喊「还有 N 题未答」是空指针式提示
      submitBtn.textContent =
        questions.length > 1 && answered > 0 && missing > 0
          ? l10n.t('Submit ({0} unanswered, marked unanswered)', String(missing))
          : questions.length > 1
            ? l10n.t('Submit all answers')
            : l10n.t('Submit answer');
    };
    // 强制单选：任一题带 options 且 allowCustom=false → 全部隐藏输入框（仅限点选，语义对齐内核 ask_user）
    const forceChoose = questions.some(
      (q) => q.options && q.options.length > 0 && q.allowCustom === false,
    );
    // 每题构建：question 标题 + 选项按钮组（点选标记该题已答，可再点改选）+ 每题输入框
    for (const [i, q] of questions.entries()) {
      const item = document.createElement('div');
      item.className = 'ask-inline__item';
      const qEl = document.createElement('div');
      qEl.className = 'ask-inline__q';
      qEl.textContent = q.question; // textContent 防注入
      item.appendChild(qEl);
      if (q.options && q.options.length > 0) {
        const opts = document.createElement('div');
        opts.className = 'ask-inline__opts';
        for (const opt of q.options) {
          const b = document.createElement('button');
          b.className = 'ask-inline__opt';
          b.textContent = opt;
          b.addEventListener('click', () => {
            // 点选标记该题已答（is-selected 高亮，可再点改选），不立即提交——全部答完走底部提交按钮
            answers[i] = opt;
            opts
              .querySelectorAll<HTMLElement>('.ask-inline__opt')
              .forEach((o) => o.classList.toggle('is-selected', o === b));
            syncSubmit();
          });
          opts.appendChild(b);
        }
        item.appendChild(opts);
      }
      // 每题输入框（forceChoose 时隐藏——仅点选，见下）
      const input = document.createElement('input');
      input.className = 'ask-inline__input';
      // INPUT-LIMIT-1：ask 回答 = 短档（值真源 shared/constants.ts，与 clarifyBar 兜底输入同档）
      input.maxLength = MAX_ASK_ANSWER_CHARS;
      input.placeholder = l10n.t('Type your answer…');
      input.addEventListener('input', () => {
        answers[i] = input.value;
        syncSubmit();
      });
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') {
          // 回车即视为提交当前输入：先同步 answers[i]（免依赖先触发 input 事件），再点提交按钮
          answers[i] = input.value;
          syncSubmit();
          submitBtn?.click();
        }
      });
      if (forceChoose) input.hidden = true;
      item.appendChild(input);
      box.appendChild(item);
    }
    // 底部一次性提交按钮（initial 文案由 syncSubmit 统一决定，此处只建节点）
    submitBtn = document.createElement('button');
    submitBtn.className = 'ask-inline__submit';
    submitBtn.textContent =
      questions.length > 1 ? l10n.t('Submit all answers') : l10n.t('Submit answer');
    submitBtn.disabled = true;
    submitBtn.addEventListener('click', () => {
      // 🔴 位次不变量：按提问顺序原样提交，未答位传空串。旧实现 `reduce` 压掉空位 ⇒
      // 其后答案整体前移 ⇒ 宿主按位回填时「答第 2 题的文本」落到第 1 题头上（错位根因）。
      // 「未答」不是错误态：内核把空串归一为 `[ASK_ABORTED]` 占位，并在盘上落 unanswered 行。
      onSubmit(answers.map((a) => (a ?? '').trim()));
      box.remove();
      scrollToBottom();
    });
    box.appendChild(submitBtn);
    host.after(box);
    // 焦点：连同输入行可见时才给输入框（强制单选时无从聚焦；多问聚焦首题输入框）
    const firstInput = box.querySelector<HTMLInputElement>('.ask-inline__input');
    if (firstInput && !firstInput.hidden) firstInput.focus();
    scrollToBottom();
    return box;
  }

  return { render };
}
