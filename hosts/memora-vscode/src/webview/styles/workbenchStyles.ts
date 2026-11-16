/**
 * 工作台 v0 样式（编辑器区面板）
 *
 * 口径：
 *   - 所有尺寸 / 圆角 / 行高一律取 `tokens.ts` 的设计令牌，**不写裸 px**（值守卫硬门）；
 *   - 颜色只引 L2 语义令牌（其内部再映射 `--vscode-*`），跟着明/暗主题走；
 *   - 窄窗口把徽记与按钮换行，不做横向滚动；
 *   - 本文件零文案、零逻辑。
 *
 * ⚠ 令牌表必须**内嵌**（与 chatStyles / settingsStyles 同范式）：
 *   本文件只引 `var(--…)`，若不同时注入 `tokens`，宿主给到的 CSS 里所有 `var()` 都是空值，
 *   padding / border / background / gap / 字号整条失效——真机验收里工作台「整页没样式、
 *   标题回到浏览器默认大字号、右侧状态被挤出面板」就是这个原因（2026-11-15）。
 *   不要用「逐条写色值兜底」的方式绕：那会引出第二个色源，主题切换立刻分叉。
 */
import { tokens } from './tokens.js';

export const workbenchStyles = `
${tokens}
body {
  padding: 0;
  margin: 0;
  color: var(--text-primary);
  background: var(--surface-page);
  font-family: var(--font-ui);
  font-size: var(--font-base);
  line-height: var(--lh-snug);
}

.workbench {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
  padding: var(--sp-6);
}

/* 第一块：代理是谁 */
.wb-seat {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-5) var(--sp-6);
  border: var(--line-solid);
  border-radius: var(--radius);
  background: var(--surface-card);
}

.wb-seat__name {
  font-size: 1.35em;
  font-weight: 600;
  word-break: break-word;
}

.wb-seat__title {
  color: var(--text-secondary);
  word-break: break-word;
}

.wb-seat__role,
.wb-seat__state {
  font-size: 0.92em;
  color: var(--text-secondary);
}

.wb-seat__state {
  color: var(--warn);
}

/* 第二块：最近在办什么 */
.wb-jobs__title {
  margin: 0 0 var(--sp-3);
  font-size: 1.05em;
  font-weight: 600;
}

.wb-jobs__empty {
  padding: var(--sp-6) var(--sp-1);
  color: var(--text-secondary);
}

.wb-jobs__notice {
  margin: 0 0 var(--sp-3);
  font-size: 0.9em;
  color: var(--warn);
  word-break: break-word;
}

.wb-jobs__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.wb-job {
  display: flex;
  align-items: flex-start;
  /* 允许换行：窄列（真机默认约 280px）下「标题块 + 右侧状态」放不下一行时，
     右块整体落到第二行；不换行会把徽记/按钮**挤出面板右缘**（真机截图实证） */
  flex-wrap: wrap;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5);
  border: var(--line-solid);
  border-radius: var(--radius);
  background: var(--surface-card);
}

.wb-job:hover {
  background: var(--surface-hover);
}

.wb-job__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-0);
}

.wb-job__title {
  font-weight: 500;
  word-break: break-word;
}

.wb-job__detail {
  font-size: 0.9em;
  color: var(--text-secondary);
  word-break: break-word;
}

/* 来源分档（助手新建 / 派发接管）：比状态副行更弱，只交代「它怎么来的」 */
.wb-job__via {
  font-size: 0.85em;
  color: var(--text-secondary);
  opacity: 0.8;
  word-break: break-word;
}

.wb-job__side {
  /* 可收缩 + 允许内部换行：徽记很长（如「当前没有实时驱动方」）时先在自身内部折行；
     margin-left: auto 保持右对齐（父级换行后仍贴右缘，不回到左缘） */
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-3);
  margin-left: auto;
}

/* 状态徽记：四档 + 边缘事实各一档；颜色只表语义，不承载唯一信息（文字恒在） */
.wb-badge {
  display: inline-block;
  padding: var(--sp-hair) var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: 0.85em;
  white-space: nowrap;
  border: var(--sp-hair) solid currentColor;
}

.wb-badge[data-kind='running'] {
  color: var(--chart-blue);
}

.wb-badge[data-kind='waiting'] {
  color: var(--warn);
}

.wb-badge[data-kind='completed'] {
  color: var(--chart-green);
}

.wb-badge[data-kind='stopped'] {
  color: var(--danger);
}

.wb-badge[data-kind='unsettled'],
.wb-badge[data-kind='queued'],
.wb-badge[data-kind='unreadable'] {
  color: var(--text-secondary);
}

.wb-job__open {
  border: var(--line-solid);
  border-radius: var(--radius-sm);
  padding: var(--sp-0) var(--sp-4);
  background: var(--btn-secondary-bg);
  color: var(--btn-secondary-fg);
  font-family: inherit;
  font-size: 0.88em;
  cursor: pointer;
  white-space: nowrap;
}

.wb-job__open:focus-visible {
  outline: var(--sp-hair) solid var(--border-focus);
  outline-offset: var(--sp-hair);
}

/* 「查看运行情况」：与「去这个会话」同级弱化展示（局部展开用，不上行消息） */
.wb-job__toggle {
  border: var(--border-panel) solid var(--sp-hair);
  border-radius: var(--radius-sm);
  padding: var(--sp-0) var(--sp-4);
  background: var(--btn-secondary-bg);
  color: var(--btn-secondary-fg);
  font-family: inherit;
  font-size: 0.88em;
  cursor: pointer;
  white-space: nowrap;
}

.wb-job__toggle:focus-visible {
  outline: var(--sp-hair) solid var(--border-focus);
  outline-offset: var(--sp-hair);
}

/* 末轮运行情况：整行展开（窄列优先纵向，不挤右侧按钮） */
.wb-job__progress {
  flex: 1 1 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-left: var(--sp-hair) solid var(--border-panel);
  color: var(--text-primary);
  font-size: 0.88em;
  word-break: break-word;
}

.wb-progress__heading {
  color: var(--text-secondary);
  font-size: 0.9em;
}

.wb-progress__request {
  white-space: pre-wrap;
}

.wb-progress__response {
  white-space: pre-wrap;
  padding-left: var(--sp-3);
  border-left: var(--sp-hair) solid var(--border-panel);
  color: var(--text-secondary);
}

.wb-progress__note,
.wb-progress__none {
  color: var(--text-secondary);
  font-size: 0.9em;
}

/* 窄窗口：整行改纵向，右块占满宽度并保持右对齐（不再依赖 overflow 裁切） */
@media (max-width: 420px) {
  .wb-job {
    flex-direction: column;
  }

  .wb-job__side {
    align-self: stretch;
  }
}
`;
