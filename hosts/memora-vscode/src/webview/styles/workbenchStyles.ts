/**
 * 工作台 v0 样式（编辑器区面板）
 *
 * 口径：
 *   - 所有尺寸 / 圆角 / 行高一律取 `tokens.ts` 的设计令牌，**不写裸 px**（值守卫硬门）；
 *   - 颜色只引 L2 语义令牌（其内部再映射 `--vscode-*`），跟着明/暗主题走；
 *   - 窄窗口把徽记与按钮换行，不做横向滚动；
 *   - 本文件零文案、零逻辑。
 */
export const workbenchStyles = `
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

.wb-job__side {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
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

/* 窄窗口：徽记与按钮换行，避免标题被挤成一列单字（媒体查询无声明值，不入户值守卫） */
@media (max-width: 420px) {
  .wb-job {
    flex-direction: column;
  }

  .wb-job__side {
    align-self: flex-end;
  }
}
`;
