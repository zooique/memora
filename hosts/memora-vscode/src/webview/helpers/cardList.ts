/**
 * cardList — 列表分区渲染纯函数（分组标题 + 空态引导）
 *
 * SSOT：configView（激活 Provider / 其他 Provider）与
 * rolesView（当前角色 / 其他角色）的「分组标题」与「空态引导」DOM 构建共用本纯函数
 * （仅文案参数化），两面板不得各自另立一份。
 *
 * 设计（对齐 helpers 规范）：
 *   - 纯函数：接收 document 依赖（DOM 注入，可独立 vitest 测试），无闭包捕获；
 *   - 只收敛「列表级」同构（分组标题 + 空态），卡片本体（buildCard）字段差异大，
 *     留在各自面板内构建（自然生长：未达 3 次阈值不强抽）。
 */

/**
 * 构建分区标题（列表分组，如「当前角色」/「其他角色」）
 *
 * @param doc 文档对象（webview window.document，依赖注入）
 * @param text 分区标题文本（textContent 赋值防注入）
 */
export function createGroupTitle(doc: Document, text: string): HTMLElement {
  const title = doc.createElement('div');
  title.className = 'group-title';
  title.textContent = text;
  return title;
}

/**
 * 构建空态引导块（empty-state > empty-title + empty-hint）
 *
 * @param doc 文档对象（webview window.document，依赖注入）
 * @param opts 空态文案（标题 + 提示，textContent 赋值防注入）
 */
export function createEmptyState(
  doc: Document,
  opts: { title: string; hint: string },
): HTMLElement {
  const empty = doc.createElement('div');
  empty.className = 'empty-state';
  const title = doc.createElement('div');
  title.className = 'empty-title';
  title.textContent = opts.title;
  const hint = doc.createElement('div');
  hint.className = 'empty-hint';
  hint.textContent = opts.hint;
  empty.appendChild(title);
  empty.appendChild(hint);
  return empty;
}
