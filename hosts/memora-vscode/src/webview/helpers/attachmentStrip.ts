/**
 * 聊天记录里的图片缩略图条 —— 唯一渲染实现
 *
 * ## 为什么外置成 helper
 * `chatView.ts` 贴着 eslint `max-lines` 的只降不升基线（6694），而在面板里写 DOM 又必须
 * 与 `append` 同命运；本文件的职责单一（refs + URL 表 → 一条缩略图带），落在 helpers 层
 * 与 `chipRow.ts` 同类（DOM 构造，无跨模块状态）。
 *
 * ## 为什么是缩略图而不是 chip（D30，2026-10-27 拍板）
 * 输入框附件行是**选择清单**（文字可扫、省高度，故为文件名 chip + 悬停预览）；聊天记录是
 * **对话内容**（图长什么样本身就是上下文）。把 chip 行约束外推到正文 = 判据作用域外溢，
 * 且长会话里「看图还得悬停」会被指针划过一串图的弹窗打断。
 *
 * ## 三条硬约束
 * 1. **无状态**：本模块不持有任何附件集合。采集层的 `accepted` 是「待发送清单」的唯一真源，
 *    历史图若流进去，下一轮就会把旧图重发一遍——两者**只共享 ImageRef 契约，不共享状态**；
 * 2. **缺 URL 不等于编一个**：宿主没给地址（视图销毁 / mime 不在支持集）时直接落文字态，
 *    与「加载失败」同一句话——都只声明「这一张现在取不到」，不断言文件是否存在
 *    （`error` 事件语义 = 这次请求失败，IMG-6 已钉死）；
 * 3. **长会话不炸**：`loading="lazy"` + `decoding="async"`，且用 `ImageRef` 的宽高设属性
 *    预留占位（60 轮 × ≤5 张 ≈ 上限 300 张，无占位会边加载边跳）。
 */
import type { ImageRef } from '@zooique/memora';

/**
 * 一条用户消息的附件渲染输入
 *
 * 字段名与两条投递通道**逐字相同**（`user` 消息 / `RoundView`）：这里不做「refs/uris」
 * 之类的中间命名，避免多一层翻译——通道对象可整体传入，没有第三套字段名要维护。
 *
 * `attachments` 缺省 / 空数组 ⇒ **零 DOM**（纯文字消息的形状与升级前逐字一致）。
 */
export interface UserAttachmentView {
  /** 附件引用（内核 `RoundMessage.attachments` 原样透传） */
  attachments?: readonly ImageRef[];
  /** 键 = `sha256` 的预览 URL 表；缺键 = 该张无预览 */
  attachmentUris?: Record<string, string>;
}

/** 取不到图时的统一文案（与输入框悬停预览同一句，避免同一缺陷两种说法） */
export function attachmentFailedText(sha256: string): string {
  return `预览加载失败（${sha256.slice(0, 8)}）`;
}

/**
 * 在给定容器尾部追加缩略图条
 *
 * 落点由调用方决定（当前 = 用户气泡内、正文之后），本函数只负责构造与降级，
 * 不搬运、不测量、不滚动——那些属 chatView 的职责（clamp 只量 `.msg-body`，
 * 故图片必须挂在 body 之外，否则一张高图会误触发「展开全文」）。
 *
 * @param parent 挂载容器（用户气泡元素）
 * @param view 附件引用与 URL 表
 */
export function renderAttachmentStrip(parent: HTMLElement, view: UserAttachmentView): void {
  const refs = view.attachments;
  if (!refs || refs.length === 0) return;
  const strip = document.createElement('div');
  strip.className = 'msg-attachments';
  for (const ref of refs) {
    const uri = view.attachmentUris?.[ref.sha256];
    strip.appendChild(uri ? buildThumb(ref, uri) : buildFailed(ref));
  }
  parent.appendChild(strip);
}

/** 缩略图：宽高属性只为占位比例（真实尺寸由 CSS 上限收敛） */
function buildThumb(ref: ImageRef, uri: string): HTMLElement {
  const img = document.createElement('img');
  img.className = 'msg-attachment';
  img.src = uri;
  // 文件名退到 alt/title（D30）：正文里图自证内容，文件名只服务读屏与悬停定位
  img.alt = ref.name;
  img.title = ref.name;
  img.width = ref.width;
  img.height = ref.height;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener(
    'error',
    () => {
      img.replaceWith(buildFailed(ref));
    },
    { once: true },
  );
  return img;
}

/** 缺陷态：留在原位的一句话（消息本身与其余缩略图不受影响） */
function buildFailed(ref: ImageRef): HTMLElement {
  const span = document.createElement('span');
  span.className = 'msg-attachment-failed';
  span.textContent = attachmentFailedText(ref.sha256);
  span.title = ref.name;
  return span;
}
