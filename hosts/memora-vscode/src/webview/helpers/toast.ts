/**
 * 全局通知 toast — 设置面板 notice / config 操作反馈的单一实现（UI-TOAST-1）
 *
 * 背景（UI-TOAST-1 三面收口）：瞬态提示此前有三套并行形态——
 *   ① settingsView 的 notice toast（`#settings-toast` + `.show`/`.error`，2.5s）；
 *   ② configView 的操作反馈 toast（`#toast` + `.ok`/`.err`/`.visible`，2.5s，无阴影）；
 *   ③ chat 活动条（activityDrawerView，已按同一批令牌浮层化）。
 * 三套各写一份 DOM/计时器/类名逻辑 ⇒ 形态漂移无人看守（config 那份连 toast 阴影都没有，
 * z 层还曾用错档）。本文件把 ①② 合并为单一实现：同元素、同时长、同分级、同令牌。
 *
 * 形态契约（由 settingsStyles 的 .settings-toast 承载，config 侧样式随本收口删除）：
 *   - 定位 `fixed` 底部居中；z 层 = var(--z-bar)（语义「输入区与 toast」档，
 *     低于全屏遮罩 --z-overlay——弹窗在场时 toast 不盖模态，此前 settings 侧误用
 *     z-overlay 会在模态打开时盖住遮罩，属层序回退，已随本收口订正）；
 *   - error 变体（--feedback-error-toast-bg 等）与 chat 活动条 error 态同令牌。
 *
 * 设计约束：
 *   - **textContent 渲染**（XXS 纪律）：message 来自 host 推送（含用户可控文本），
 *     禁止 innerHTML；
 *   - **单元素 + 单计时器**：连续 notice 复用同元素，重触发须 clearTimeout 重置
 *     （config 旧实现不重置 ⇒ 连发两条时前者的定时器会提前撤掉后者）；
 *   - **从 doc.defaultView 派生 window**（不引用全局 window）：与 helpers 依赖注入
 *     惯例统一（对齐 scrollToBottom 从 ownerDocument 派生），可 jsdom 测试；
 *     defaultView 为空（脱离文档的 Document）时退化为「不排自动隐藏」——保持可见，
 *     不静默吞掉提示。
 */

/** toast 级别：与协议 notice.level 对齐（info | error，**无 warn**——不预支协议不存在的层级） */
export type ToastLevel = 'info' | 'error';

/** 自动隐藏时长（ms）：三面对齐同一时长（settings notice / config 反馈 / chat 活动条 2.5s） */
export const TOAST_DURATION_MS = 2500;

/** 单一元素 id（settings 与 config 同文档并存，共用一个 DOM 契约，不搞两套） */
const TOAST_ELEMENT_ID = 'settings-toast';

/** 自动隐藏计时器（模块级单例：连续展示复用同元素，须 clearTimeout 重置） */
let toastTimer: number | null = null;

/**
 * 展示全局通知 toast（设置面板 notice 与 config 操作反馈的唯一入口）
 *
 * 懒创建元素（首次调用时建并挂 body）：调用方无需在 HTML 骨架里预埋节点——
 * config 旧骨架的 `#toast` 预埋节点已随本收口删除（预埋即第二处 DOM 契约）。
 *
 * @param doc 目标文档（webview document；window 从其 defaultView 派生）
 * @param level 级别（error 标红醒目，info 常规）
 * @param message 文本正文（textContent 渲染，防注入）
 */
export function showToast(doc: Document, level: ToastLevel, message: string): void {
  let toast = doc.getElementById(TOAST_ELEMENT_ID);
  if (!toast) {
    toast = doc.createElement('div');
    toast.id = TOAST_ELEMENT_ID;
    toast.className = 'settings-toast';
    doc.body.appendChild(toast);
  }
  // 整体重置类（含 .show 移除）后强制重排，再挂 .show：重启 opacity 过渡动画。
  // 同元素连续展示时若不重排，transition 不自动重触发（第二条提示会「直接显形」无淡入）。
  toast.className = 'settings-toast' + (level === 'error' ? ' error' : '');
  toast.textContent = message;
  void toast.offsetWidth;
  toast.classList.add('show');
  const win = doc.defaultView;
  if (!win) return; // 脱离文档的 Document：不排自动隐藏，保持可见
  win.clearTimeout(toastTimer as number);
  toastTimer = win.setTimeout(() => toast?.classList.remove('show'), TOAST_DURATION_MS);
}
