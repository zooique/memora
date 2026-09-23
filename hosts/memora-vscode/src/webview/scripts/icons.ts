/**
 * icons — 统一 SVG 图标管理模块
 *
 * 集中管理所有内联 SVG 图标，采用 Trae 风格：柔和线条、圆润端点、简洁几何。
 * 设计原则：
 *   - 16x16 viewBox，通过 CSS width/height 控制显示尺寸
 *   - stroke="currentColor" 跟随父元素颜色，线条描绘而非填充
 *   - stroke-width="1.5"，stroke-linecap="round"，stroke-linejoin="round"
 *   - 每个图标导出为独立常量，按需引用
 *
 * 使用示例：
 *   import { createIcon } from './icons';
 *   const btn = createIcon('copy', '复制消息');
 *   btn.className = 'msg-icon-btn';
 *   container.appendChild(btn);
 *
 *   // HTML 中使用 data-icon 属性：
 *   <span class="btn-icon" data-icon="copy"></span>
 *   // 然后调用 populateIcons(root) 填充
 */

/** 图标名称类型 */
export type IconName =
  | 'copy'          // 复制
  | 'delete'        // 删除/垃圾桶
  | 'folder'        // 打开目录/文件夹
  | 'refresh'       // 刷新
  | 'check'         // 勾选/确认
  | 'close'         // 关闭/叉号
  | 'edit'          // 编辑/重命名/润色
  | 'bolt'          // 闪电/Skill 触发（原 play 重命名）
  | 'trash'         // 永久删除
  | 'cancel'        // 取消
  | 'chevron-down'  // 向下尖角（plan-bar 展开态；消费者是折叠开关，非下拉组件）
  | 'chevron-right' // 右箭头（折叠态）
  | 'fork'          // 分叉会话
  | 'plus'          // 新建会话/加号
  | 'history'       // 历史记录/时钟
  | 'scroll-bottom' // 回到底部
  | 'pause'         // 暂停（双竖线）
  | 'send'          // 发送（上箭头）
  | 'stop'          // 停止（方块）
  | 'play'          // 继续/播放（三角）
  | 'team'          // 小组会议（双人轮廓，柔和线条）
  | 'ellipsis'      // 更多操作（三点；原 ⋯ 字符，2026-09-19 HOST-S8 收口）
  | 'target';       // 当前执行位置（同心圆靶心；plan-tag「正在执行任务项 N」锚点）

/** SVG 路径集合（viewBox 0 0 16 16）— Trae 柔和线条风格 */
const ICON_PATHS: Record<IconName, string> = {
  // 复制：两个重叠矩形轮廓
  copy: '<rect x="4" y="5" width="7" height="7" rx="1.5"/><rect x="7" y="3" width="7" height="7" rx="1.5"/>',
  // 删除：垃圾桶轮廓
  delete: '<path d="M5.5 3.5h5"/><path d="M4 3.5h8l-.5 9a1 1 0 0 1-1 .95H5.5a1 1 0 0 1-1-.95L4 3.5z"/><path d="M6 6.5v5"/><path d="M8 6.5v5"/><path d="M10 6.5v5"/>',
  // 文件夹：打开的目录
  folder: '<path d="M2.5 4h3.5l1 1h6.5a1 1 0 0 1 1 1v1H3L2 5l.5-1z"/><path d="M2 5.5h12l-1 7a1 1 0 0 1-1 .95H3a1 1 0 0 1-1-.95L2 5.5z"/>',
  // 刷新：循环箭头
  refresh: '<path d="M13 2.5v3h-3"/><path d="M3 13.5v-3h3"/><path d="M12.5 5.5a5 5 0 0 0-9.5-1.5"/><path d="M3.5 10.5a5 5 0 0 0 9.5 1.5"/>',
  // 勾选：对号
  check: '<path d="M3.5 8.5l3 3 6-6"/>',
  // 关闭：叉号
  close: '<path d="M4 4l8 8"/><path d="M12 4l-8 8"/>',
  // 编辑：铅笔（用于重命名）
  edit: '<path d="M11 2.5l2.5 2.5-8 8-3 .5.5-3 8-8z"/>',
  // 闪电：Skill 触发器
  bolt: '<path d="M8 2l-4 7h3l-1 5 5-7H8l2-5z"/>',
  // 暂停：双竖线
  pause: '<rect x="5" y="3.5" width="2" height="9" rx="0.5"/><rect x="9" y="3.5" width="2" height="9" rx="0.5"/>',
  // 发送：上箭头
  send: '<path d="M8 12V3.5"/><path d="M4.5 7l3.5-3.5L11.5 7"/>',
  // 停止：方块
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/>',
  // 继续/播放：三角
  play: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
  // 永久删除：带叉垃圾桶
  trash: '<path d="M5.5 2.5h5"/><path d="M4 2.5h8l-.5 9.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1L4 2.5z"/><path d="M6.5 6.5l3.5 3.5"/><path d="M10 6.5L6.5 10"/>',
  // 取消：圆叉
  cancel: '<circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5"/><path d="M10.5 5.5l-5 5"/>',
  // 下拉箭头
  'chevron-down': '<path d="M3.5 5.5l4.5 4.5 4.5-4.5"/>',
  // 右箭头（收起态；与 chevron-down 同曲率，但为独立 path —— 非 transform 旋转）
  'chevron-right': '<path d="M5.5 3.5l4.5 4.5-4.5 4.5"/>',
  // 分叉：带分支的节点
  fork: '<circle cx="4" cy="4" r="1.5"/><circle cx="4" cy="12" r="1.5"/><circle cx="12" cy="8" r="1.5"/><path d="M5.5 4H9a3 3 0 0 1 3 3"/><path d="M5.5 12H9a3 3 0 0 0 3-3"/>',
  // 加号：新建会话
  plus: '<path d="M8 3v10"/><path d="M3 8h10"/>',
  // 历史记录：时钟
  history: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/>',
  // 回到底部：向下箭头到横线
  'scroll-bottom': '<path d="M8 3v7"/><path d="M5 7l3 3 3-3"/><path d="M3 12h10"/>',
  // 小组会议：双人轮廓（小在前大在后，柔和线条）
  team: '<circle cx="5.5" cy="6" r="1.5"/><circle cx="10.5" cy="6.5" r="2"/><path d="M3 13c0-1.5 1.1-2.5 2.5-2.5S8 11.5 8 13"/><path d="M8.5 13c0-1.7 1.5-3 3-3s3 1.3 3 3"/>',
  // 更多操作：三点（替换原『⋯』字符，2026-09-19 HOST-S8 图标语言收口；
  // 实心点局部覆盖 SVG_BASE_ATTRS 的 fill=none——16px 下描边小圆会糊成环）
  ellipsis: '<circle cx="4" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1.2" fill="currentColor" stroke="none"/>',
  // 当前执行位置：同心圆靶心（替换原 emoji 📍 的 plan-tag 锚点，2026-09-19 图标语言收口）
  target: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.5"/>',
};

/** SVG 通用属性（Trae 柔和风格） */
const SVG_BASE_ATTRS = {
  viewBox: '0 0 16 16',
  width: '16',
  height: '16',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.5',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

/**
 * 创建带图标的按钮元素
 *
 * @param name 图标名称
 * @param title 鼠标悬停提示
 * @param extraClass 额外的 CSS 类名
 * @returns 包含 SVG 图标的按钮元素
 */
export function createIcon(name: IconName, title: string, extraClass?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  const baseClass = extraClass ? `msg-icon-btn ${extraClass}` : 'msg-icon-btn';
  btn.className = baseClass;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  // 设置 Trae 风格 SVG 属性
  Object.entries(SVG_BASE_ATTRS).forEach(([key, value]) => {
    svg.setAttribute(key, value);
  });
  svg.innerHTML = ICON_PATHS[name];
  btn.appendChild(svg);
  return btn;
}

/**
 * 获取完整的 SVG 元素字符串（含属性，用于 innerHTML）
 *
 * @param name 图标名称
 * @param width 显示宽度
 * @param height 显示高度
 * @returns 完整 SVG 字符串
 */
export function getIconSvg(name: IconName, width = 16, height = 16): string {
  const attrs = Object.entries({
    ...SVG_BASE_ATTRS,
    width: String(width),
    height: String(height),
  }).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<svg ${attrs}>${ICON_PATHS[name]}</svg>`;
}

/**
 * 运行时切换单个元素图标（2026-09-07 补：populateIcons 只在初始化跑一次，
 * 运行中改 data-icon 不会重注入 SVG——pauseBtn 暂停→继续图标不更新即此因）。
 * 与 populateIcons 共用 getIconSvg，单一图标注入实现（SSOT）。
 *
 * @param el 目标元素（须为 [data-icon] 容器）
 * @param name 目标图标名
 */
export function applyIcon(el: HTMLElement, name: IconName): void {
  el.dataset.icon = name;
  el.innerHTML = getIconSvg(name, 16, 16);
}

/**
 * 填充 HTML 中所有 data-icon 属性的元素为 SVG 图标
 * 统一图标管理入口，避免散落在 HTML 中硬编码 SVG
 *
 * @param root 根元素（通常是 document.body）
 */
export function populateIcons(root: HTMLElement): void {
  const containers = root.querySelectorAll<HTMLElement>('[data-icon]');
  containers.forEach((el) => {
    const name = el.dataset.icon as IconName | undefined;
    if (!name || !ICON_PATHS[name]) return;
    // 清空容器并注入 SVG 图标（16x16，Trae 柔和风格）
    applyIcon(el, name);
  });
}
