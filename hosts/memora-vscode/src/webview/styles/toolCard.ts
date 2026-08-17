/**
 * 工具调用卡片样式 — 对齐 memora-sprite 的视觉语言，用 --vscode-* 语义变量做主题兼容
 *
 * 结构约定（由 components/toolCard.ts 生成）：
 *   .tool-card[data-tool-call-id]          卡片（running/success/failed 三种状态类）
 *     .tool-card__header[id=toolCardHeader]按钮（点击折叠/展开）
 *       .tool-card__chevron   .tool-card__icon   .tool-card__name   .tool-card__spinner   .tool-card__status
 *     .tool-card__args        工具参数（可折叠）
 *     .tool-card__result      工具结果摘要（可折叠）
 * 折叠：卡片加 .is-collapsed 时隐藏 args/result 并旋转箭头。
 */
export const toolCardStyles = `
  /* 过程性反馈降级（编排对齐）：工具调用是 Agent 的过程步骤，不是对话主体。
   * 无背景色（透明表面），仅左侧细边框 + 状态文字指示状态，字号更小更灰，
   * 与用户/AI 消息明显区分——避免「每条都对、合起来乱」的密度失控。 */
  .tool-card {
    margin-top: var(--sp-1, 4px); padding: var(--sp-1, 4px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px); line-height: 1.5;
    border-radius: var(--radius, 6px);
    animation: toolCardIn 0.15s ease-out;
    border-left: 3px solid var(--border-panel, rgba(128,128,128,.4)); /* 默认中性细边框 */
    background: transparent;
  }
  /* 入场微位移：属动画细节，不在间距刻度内（对齐令牌铁律例外） */
  @keyframes toolCardIn { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
  /* 状态仅由左侧边框颜色 + 状态文字承载（不带背景色，不抢视觉） */
  .tool-card.is-running { border-left-color: var(--status-info); }
  .tool-card.is-success { border-left-color: var(--status-pass); }
  .tool-card.is-failed { border-left-color: var(--status-fail); }
  .tool-card__header {
    display: flex; align-items: center; gap: var(--sp-2, 6px); width: 100%;
    background: none; border: none; padding: 0; margin: 0;
    font-family: inherit; font-size: inherit; text-align: left;
    color: inherit; cursor: pointer; user-select: none;
  }
  .tool-card__chevron { display: inline-flex; align-items: center; color: var(--text-secondary, #9aa0a6); transition: transform 0.15s ease; font-size: var(--font-xs, 10px); }
  .tool-card.is-collapsed .tool-card__chevron { transform: rotate(-90deg); }
  /* 工具图标（emoji）：装饰性元素，不随状态变化，与名称同灰阶 */
  .tool-card__icon { display: inline-flex; align-items: center; font-size: var(--font-sm, 11px); line-height: 1; user-select: none; }
  .tool-card__name {
    font-weight: 500; color: var(--text-secondary, #9aa0a6);
    font-family: ui-monospace, Consolas, monospace; font-size: var(--font-sm, 11px);
  }
  .tool-card__spinner {
    display: inline-block; width: 10px; height: 10px; margin-left: auto;
    border: 1.5px solid var(--border-panel, #ccc);
    border-top-color: var(--status-info);
    border-radius: 50%; animation: toolSpin 0.8s linear infinite;
  }
  .tool-card.is-success .tool-card__spinner, .tool-card.is-failed .tool-card__spinner { display: none; }
  @keyframes toolSpin { to { transform: rotate(360deg); } }
  .tool-card__status { margin-left: auto; font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); }
  /* 成功工具调用 → 单行胶囊（图标 + 名称 + ✓，无详情）。压缩成功反馈为一行，
   * 不再占据垂直空间（对齐大厂 AI Chat「成功工具折叠为一行」惯例）。 */
  .tool-card--capsule {
    height: 24px; padding: 0 10px; margin-top: var(--sp-1, 4px);
    display: inline-flex; align-items: center; gap: var(--sp-2, 6px);
    border-radius: 12px; border-left: none;
    background: var(--surface-code, rgba(128,128,128,.12));
    font-size: var(--font-xs, 10px); line-height: 1;
  }
  .tool-card--capsule .tool-card__header { padding: 0; gap: var(--sp-1, 4px); cursor: default; }
  .tool-card--capsule .tool-card__name { font-size: var(--font-xs, 10px); }
  .tool-card--capsule .tool-card__status { margin-left: 0; color: var(--status-pass, #4ec9b0); }
  .tool-card__args, .tool-card__result {
    margin-top: var(--sp-1, 4px); padding: var(--sp-1, 4px) var(--sp-2, 6px); max-height: 120px; overflow: auto;
    background: var(--surface-code);
    border-radius: var(--radius, 6px);
    font-family: ui-monospace, Consolas, monospace; font-size: var(--font-sm, 11px);
    color: var(--text-secondary);
    white-space: pre-wrap; word-break: break-all;
    transition: max-height 0.15s ease, opacity 0.1s ease, margin 0.15s ease;
  }
  .tool-card__result { border-top: 1px dashed var(--border-panel, #ccc); }
  .tool-card.is-collapsed .tool-card__args,
  .tool-card.is-collapsed .tool-card__result { max-height: 0; opacity: 0; margin-top: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; }
`;