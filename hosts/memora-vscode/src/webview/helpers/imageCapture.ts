/**
 * 图片采集层 — 粘贴 / 拖入 / 文件选择框 → 一条 chip
 *
 * 职责边界（刻意划死，勿扩张）：
 *   - **采集 + 上行触发，不落盘、不碰内核**：落盘与 sha256 裁定归宿主（`ImageRef` 真源在会话
 *     存储侧），本文件产出的 `sha256` 只是**提案值**（用于 D29 兜底命名与同轮去重的粗筛），
 *     最终以宿主重算为准。
 *   - **上行通道已接线**（2026-10-28 Q1 拍板反转原 K1 期「发送时随 `input` 字段交付」口径）：
 *     真机实测隐藏侧栏即销毁 webview 上下文（未发送图全丢，边界文档 §7 第 7 条）⇒ 定案
 *     **采集即写盘**——校验通过即发 `image_ingest`，宿主落盘后回 `image_ingest_result`
 *     换真（两条通道定义见 `shared/protocol.ts`）。写盘本身仍不在本文件（禁 fs 进 webview）。
 *   - **发送交付已接线**：发送时刻由 `resolveSendable()` 给出真值 `ref` 列表，chatView 并进
 *     `input.attachments`；**取图的唯一出口就在本文件**（chatView 不许自己遍历 `accepted`）。
 *   - **文件选择框路径（Q3）已接线**：上传按钮点击 → `image_pick_request`（宿主开原生
 *     对话框、读盘落盘）→ 回执经 `applyPicked()` 建 chip——该路径**没有提案阶段**，
 *     `ref` 到手即真相（webview 从未见过字节）；`rejected`/`failed` 转**可见**拒收 chip，
 *     绝不静默丢（用户选了文件却什么都没发生 = 最坏静默错态）。
 *   - **仍未接线的只剩 `drop-uri`（资源管理器拖入）的读盘**：本端只有 URI、读不到字节，
 *     `resolveSendable()` 对此**恒拦并给原因**，绝不放行一条「图没跟上」的消息。
 *   - **上传按钮（常驻，D27）**：当前 Provider 声明了视觉能力 → 点击发拾取请求；未声明 →
 *     置灰态（`aria-disabled` + class，**不用** `disabled` 属性——置灰但可点，点击跳设置
 *     开启，D27 拍板「隐藏 = 不可发现的错误」）。置灰判据唯一来源 = `chat_providers`
 *     的 `vision` 投影字段，经 `setAttachEnabled()` 单点进_state_。
 *
 * 为什么走依赖注入而不是直接摸全局（对齐 `helpers/toast.ts` 的既有惯例）：
 *   chatView 的测试在 jsdom 里重建 DOM，模块级自执行会把监听器绑到上一轮的旧节点上。
 *   全部 DOM 入口由调用方传入 ⇒ 每次 mount 重新绑定、`dispose()` 一次收干净。
 *
 * 三条路径的能力差（真机结论见边界文档 §4）：
 *   | 来源 | 拿到什么 | 能否当场校验 |
 *   | 粘贴 / 从系统文件管理器拖入 | `File`（可读字节） | 能（六步校验全跑） |
 *   | 上传按钮（宿主开框读盘） | 只有回执（字节全程在宿主） | 宿主校验，本端收真相建 chip |
 *   | 从 VS Code 资源管理器拖入 | 只有 `text/uri-list` 字符串 | **不能**——webview 读不到工作区
 *     文件（`localResourceRoots` 只放行 `dist/webview`）⇒ 只登记 URI，读盘与校验推迟到宿主 |
 */

import type { ImageRef } from '@zooique/memora';
import { type ImageCheckResult, validateImageCandidate } from '../../shared/imageValidation.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { syncRowEdges } from './chipRow.js';
import { getIconSvg } from '../scripts/icons.js';

/** `image_ingest_result` 载荷类型（从协议联合取型，禁手写第二份字段表） */
type IngestResult = Extract<ExtensionToWebviewMessage, { type: 'image_ingest_result' }>;
/** `image_picked` 载荷类型（Q3 文件选择框回执，同上） */
type PickedResult = Extract<ExtensionToWebviewMessage, { type: 'image_picked' }>;

/**
 * 悬停预览浮层的固定 id（**单例**，挂 body 的绝对定位层）。
 *
 * 为什么单例而不是「一枚 chip 一份」：一个 `<img>` 同一时刻只会解码一张图；单例 + 离开即清
 * src，才能让内存峰值只等于「当前悬停的那一张」（方案 §5.10 的残余风险缓解边界，不做转码）。
 */
const PREVIEW_TIP_ID = 'imgPreviewTip';

/** 采集成功的候选图。字段与内核 `ImageRef` 对齐，但 `sha256` 是**提案值**（见文件头）。 */
export interface CapturedImage {
  source: 'paste' | 'drop-file' | 'drop-uri' | 'pick';
  /** 用户可见文件名（D29：唯一生产点就是这里，无名时由 `resolveImageName` 兜底） */
  name: string;
  /** 原始字节数；`drop-uri` 来源为 `undefined`（尚未读盘） */
  byteLength?: number;
  mime?: string;
  width?: number;
  height?: number;
  /** 提案摘要（`drop-uri` 来源没有，宿主读盘后自算） */
  sha256?: string;
  /** 仅 `drop-uri`：宿主侧读盘用的文件 URI 原文 */
  uri?: string;
  /**
   * 落盘**真值**（`image_ingest_result.status='ok'` 后才存在）。
   *
   * 在此之前本结构里的一切字段都是提案：宿主会用同一份字节复算，不一致时以 `ref` 为准
   * （见 `applyIngestResult`）。发送链路只应读 `ref`，读提案值 = 拿未验证数据当真相。
   */
  ref?: ImageRef;
  /**
   * webview 可直接加载的预览 URL（回执 `ok` 的 `uri`，宿主 `asWebviewUri` 产物）。
   *
   * 与 `uri` 的分野（同族词不同源，勿混）：`uri` 是**资源管理器拖入的原始文件 URI**
   * （本端读不到字节，仅登记待接线）；本字段是宿主翻好的 webview 地址，可直接塞 `<img src>`。
   * 缺失 = 预览不可用（回执在途 / 宿主视图已销毁），UI 必须如实说「暂无预览」而非留白。
   */
  previewUri?: string;
}

/** 被拒绝的候选：**必须可见**，不许静默丢（方案 D7 的二级语义）。 */
export interface RejectedImage {
  source: CapturedImage['source'];
  name: string;
  reason: string;
}

export interface ImageCaptureDeps {
  doc: Document;
  /** 粘贴监听目标（就地监听，不劫持 document 级 paste） */
  input: HTMLTextAreaElement | null;
  /** 拖放监听目标（`dragover` 必须 preventDefault 才收得到 drop） */
  dropZone: HTMLElement | null;
  /** chip 容器（`#imageChips`） */
  row: HTMLElement | null;
  /** SHA-256 提案实现（默认走 Web Crypto；注入以便测试） */
  sha256?: (bytes: Uint8Array) => Promise<string>;
  /** 读 `File` 字节（默认 `Blob.arrayBuffer()` → `FileReader` 兜底；注入以便测试） */
  readBytes?: (file: File) => Promise<Uint8Array>;
  /**
   * 上行通道（`image_ingest`）。
   *
   * 缺省 = 不落盘：单测可只验证「采集 + 校验」两段而不必搭宿主；生产由 chatView 注入
   * `vscode.postMessage`。**采集即写盘**（IMG-2 Q1 定案）——粘贴当场发，不等发送：
   * webview 隐藏即销毁，字节留在内存里就会随上下文蒸发。
   */
  post?: (msg: WebviewToExtensionMessage) => void;
  /** 瞬态提示（同轮重复粘贴「已添加」等）；缺省 = 静默 */
  notice?: (message: string) => void;
  /**
   * 上传按钮（`#imageAttachBtn`，常驻，D27）。缺省 = 无按钮（测试可不搭骨架）。
   *
   * 点击行为随 `setAttachEnabled()` 的能力态二分：有视觉能力 → `image_pick_request`；
   * 无 → `open_settings_tab('config')` 跳设置。绑定与状态全收在本层（chatView 只递
   * 元素与投影值），按钮的 class / title / aria 语义不散在视图里。
   */
  attachBtn?: HTMLButtonElement | null;
}

export interface ImageCaptureHandle {
  /** 当前候选（发送时刻的取值单点） */
  readonly accepted: readonly CapturedImage[];
  readonly rejected: readonly RejectedImage[];
  /**
   * 发送时刻取图（**唯一出口**，chatView 不许自己遍历 `accepted`）。
   *
   * 返回 `refs` 才是可随本轮发出的真值；返回 `blocked` 表示「有图发不出去」——此时
   * 调用方必须**整条拦下**（保留输入框与 chip），不得只发文字。为什么必须拦而不是丢弃：
   * 用户贴了图、看见 chip、按了发送，结果图没跟着走 = 「以为自己做到了」的静默错态。
   *
   * @param interjectRoute 本轮 send 会被宿主路由为**插话**（生成中）：该通道内核不收附件（D13）
   *   ⇒ 有图即拦。判据随渲染骨架态由调用方传入，本层不反向读 UI 状态。
   */
  resolveSendable(interjectRoute: boolean): SendableImages;
  /**
   * 落盘回执入口（chatView 把 `image_ingest_result` 原样转进来）。
   *
   * 归本层处理而非 chatView：chip 的状态只在这里维护，回调若散在视图层就会出现
   * 「数据改了、chip 没重绘」的两套状态。
   */
  applyIngestResult(msg: IngestResult): void;
  /**
   * 文件选择框回执入口（chatView 把 `image_picked` 原样转进来）。
   *
   * 与 `applyIngestResult` 分立而非合并：两通道时序不同构（那边「提案 chip → 换真」，
   * 这边「无提案，ref 即真相」），合并就要在函数里猜消息属于哪个时序 = 分支即暗排序。
   * 归本层处理的原因相同：chip 状态只在这里维护，视图层不碰候选数组。
   */
  applyPicked(msg: PickedResult): void;
  /**
   * 上传按钮能力态（chat_providers 投影值单点入口）。
   *
   * @param vision 当前激活 Provider 是否声明视觉能力；初始（chat_providers 未到）按
   *   `false` 处理——宁可先灰后亮，不可先亮后灰（后者诱导用户点了才发现发不出）。
   */
  setAttachEnabled(vision: boolean): void;
  clear(): void;
  dispose(): void;
}

/** 发送取图结果：要么给真值列表，要么给「为什么发不了」（二选一，禁同时为空语义） */
export type SendableImages = { refs: ImageRef[] } | { blocked: string };

/**
 * 解析 `text/uri-list`（RFC 2483）：按行切、去空白、跳过 `#` 注释行。
 *
 * 为什么单独抽成纯函数：VS Code 资源管理器拖出来的 URI 就是这一份文本，格式细节
 * （CRLF / 注释行 / 空行）只在这里判一次；将来若发现别的形态，改这一个函数即可。
 */
export function parseUriList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * 字节 → 小写十六进制摘要。
 *
 * ⚠ 这是**标准算法**的一部分（FIPS 180-4），不是业务规则：与宿主侧 `node:crypto` 算出的
 * 必然是同一个值。业务规则的单一真源仍然只有一处——嗅探与尺寸解析（`shared/imageValidation.ts`）。
 */
async function defaultSha256(bytes: Uint8Array): Promise<string> {
  // `slice()` 复制出一段**独立且 byteOffset 归零**的缓冲：既避开 lib.dom 对
  // `Uint8Array<ArrayBufferLike>` 的收窄问题（不写 `as` 断言），也顺手保证摘要范围就是
  // 整个字节序列——若将来有人传进来的是原缓冲的视图，也不会只摘要到后半段。
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * `Blob.arrayBuffer()` 优先、`FileReader` 兜底。
 *
 * 为什么两个都留：官方只承诺「webview 不能直接访问本地资源」，对这两个 API 都没有明文
 * 支持或禁止（边界文档 B5 把它标成「未禁止 ≠ 契约」）。两条都走一遍的成本极低，而单靠
 * 任何一条都可能在某个内核版本上让整个功能静默失效——探针阶段最怕的就是「没反应」。
 */
async function defaultReadBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('读取图片内容失败'));
    reader.readAsArrayBuffer(file);
  });
}

/** 从 `DataTransfer` 里挑出图片文件（`kind === 'file'` 且声明类型是图片） */
export function pickImageFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const out: File[] = [];
  const items = transfer.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file && file.type.startsWith('image/')) out.push(file);
    }
    if (out.length > 0) return out;
  }
  // 某些平台 `items` 为空但 `files` 有值（边界文档 B3 的同族现象）⇒ 两条都看
  for (let i = 0; i < transfer.files.length; i++) {
    const file = transfer.files[i];
    if (file && file.type.startsWith('image/')) out.push(file);
  }
  return out;
}

/**
 * 字节 → 标准 base64（带 padding）。
 *
 * 为什么不用 `btoa(String.fromCharCode(...bytes))` 一行写完：`apply` 的实参个数有上限
 * （V8 约 12 万），5 MiB 图片展开成 500 万个参数会直接 `RangeError`。故按 32 KiB 分块
 * 转字符再拼接——分块边界取 3 的倍数，避免块尾产生半个 base64 分组。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // 块大小 = 32768 字节（32768 % 3 === 2，故取 32766 保证每块都是完整分组）
  const CHUNK = 32766;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function createImageCapture(deps: ImageCaptureDeps): ImageCaptureHandle {
  const { doc, input, dropZone, row } = deps;
  const sha256 = deps.sha256 ?? defaultSha256;
  const readBytes = deps.readBytes ?? defaultReadBytes;
  // 上行缺省为空实现：单测不搭宿主时采集仍完整可用（且不会误发消息）
  const post = deps.post ?? (() => {});
  const notice = deps.notice ?? (() => {});

  const accepted: CapturedImage[] = [];
  const rejected: RejectedImage[] = [];

  function render(): void {
    if (!row) return;
    // 重建前先收起：chip 节点即将被替换，浮层若还指向旧节点就是悬在空处的一张图
    hidePreview();
    row.textContent = '';
    const total = accepted.length + rejected.length;
    if (total === 0) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    /**
     * 失败项排在**前面**：探针阶段要的是「一眼看见出事了」。等正式版接入落盘与预览后，
     * 这条顺序可以再议（届时失败项通常不进 chip 行，而是走瞬态提示）。
     */
    for (const item of rejected) row.appendChild(buildRejectedChip(item));
    for (const item of accepted) row.appendChild(buildChip(item));
    // 重建后必须按新宽度重算渐隐（与引用行同一判据，见 chipRow 注释）
    syncRowEdges(row);
  }

  /** chip 外形与引用 chip 同构（D28：只显示文件名，不做缩略图） */
  function buildChip(item: CapturedImage): HTMLElement {
    const chip = doc.createElement('span');
    chip.className = 'skill-chip image-chip';
    chip.dataset.imageSource = item.source;

    const icon = doc.createElement('span');
    icon.className = 'skill-chip__icon';
    icon.innerHTML = getIconSvg('file', 11, 11);
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);

    const name = doc.createElement('span');
    name.className = 'skill-chip__name';
    name.textContent = item.name;
    // 详情进 title：可见文本保持「只显示文件名」（D28），完整信息 hover 可查。
    name.title = describe(item);
    chip.appendChild(name);

    chip.appendChild(buildRemove(() => removeAccepted(item)));
    // 悬停预览只挂在**成功** chip 上：拒收项没有落盘文件，悬停出来只能是假象
    chip.addEventListener('mouseenter', () => showPreview(chip, item));
    chip.addEventListener('mouseleave', hidePreview);
    return chip;
  }

  function buildRejectedChip(item: RejectedImage): HTMLElement {
    const chip = doc.createElement('span');
    chip.className = 'skill-chip image-chip image-chip--rejected';
    chip.dataset.imageSource = item.source;

    const icon = doc.createElement('span');
    icon.className = 'skill-chip__icon';
    icon.innerHTML = getIconSvg('file', 11, 11);
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);

    const name = doc.createElement('span');
    name.className = 'skill-chip__name';
    name.textContent = `${item.name}（未采用）`;
    name.title = item.reason;
    chip.appendChild(name);

    chip.appendChild(buildRemove(() => removeRejected(item)));
    return chip;
  }

  function buildRemove(onClick: () => void): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'skill-chip__remove';
    btn.title = '移除';
    btn.setAttribute('aria-label', '移除这张图片');
    btn.innerHTML = getIconSvg('close', 11, 11);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function removeAccepted(target: CapturedImage): void {
    const i = accepted.indexOf(target);
    if (i >= 0) accepted.splice(i, 1);
    render();
  }

  function removeRejected(target: RejectedImage): void {
    const i = rejected.indexOf(target);
    if (i >= 0) rejected.splice(i, 1);
    render();
  }

  function describe(item: CapturedImage): string {
    const parts: string[] = [];
    if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
    if (typeof item.byteLength === 'number') {
      parts.push(`${Math.max(1, Math.round(item.byteLength / 1024))} KB`);
    }
    if (item.mime) parts.push(item.mime);
    /**
     * 三种状态必须说清，因为**行为不同**（`resolveSendable` 逐一对应）：
     *   - 有 `ref`：已落盘且会随下条消息发出（`本地已存`）；
     *   - 无 `ref` 且有 `uri`（资源管理器拖入）：本端读不到字节，发送被拦，须告知；
     *   - 无 `ref` 无 `uri`：落盘回执未到，发送会被拦下等它。
     */
    if (item.ref) parts.push('已保存到本地，将随消息发送');
    else if (item.uri) parts.push('来自资源管理器，暂不支持发送（请改用粘贴或拖入）');
    else parts.push('正在保存到本地，完成后可发送');
    return parts.join(' · ') || item.name;
  }

  /** 悬停预览 tip 单例（懒建；跨 mount 复用同一节点，见 `PREVIEW_TIP_ID`） */
  let previewTip: HTMLElement | null = null;

  /** 取（懒建）预览 tip：先查文档里已有节点，避免重挂后出现第二份浮层 */
  function ensureTip(): HTMLElement {
    const existing = doc.getElementById(PREVIEW_TIP_ID);
    if (existing) {
      previewTip = existing;
      return existing;
    }
    const tip = doc.createElement('div');
    tip.id = PREVIEW_TIP_ID;
    tip.className = 'image-chip-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    // body 缺失（极早期 / 异常文档）时退到 documentElement：浮层不能因宿主容器缺失而不存在
    (doc.body ?? doc.documentElement).appendChild(tip);
    previewTip = tip;
    return tip;
  }

  /**
   * 清空 tip 内容并收起。
   *
   * 摘掉 `<img>` 元素本身就是「离开即清 src」的落地：元素被移除后解码位图可回收，
   * 单例里绝不留着上一张图（方案 §5.10 的内存取舍）。
   */
  function resetTip(tip: HTMLElement): void {
    tip.textContent = '';
    tip.hidden = true;
  }

  /** 文本态（无预览 / 不可用）：与图片态互斥，同一单例里只留一种内容 */
  function fillTipText(tip: HTMLElement, text: string): void {
    const el = doc.createElement('div');
    el.className = 'image-chip-tip__text';
    el.textContent = text;
    tip.appendChild(el);
  }

  /**
   * 摆位：默认在 chip 上方；上方空间不足（贴近视口顶边）则翻到下方。
   *
   * 坐标 = `getBoundingClientRect()` + 页面滚动偏移。本仓滚动发生在消息区而非 body，
   * 加偏移是零成本的正确写法——防将来 body 出现滚动时浮层静默错位。
   */
  function placeTip(tip: HTMLElement, chip: HTMLElement): void {
    const rect = chip.getBoundingClientRect();
    const view = doc.defaultView;
    const scrollX = view?.scrollX ?? 0;
    const scrollY = view?.scrollY ?? 0;
    // chip 与浮层之间的视觉间隙
    const gap = 6;
    // 必须先显形再量尺寸（hidden 时 offsetHeight 恒 0，翻向判断会永远成立）
    const height = tip.offsetHeight;
    const above = rect.top - height - gap >= 0;
    tip.style.top = `${(above ? rect.top - height - gap : rect.bottom + gap) + scrollY}px`;
    // 水平：默认左贴 chip；右侧越界时左移，且不许压过左边界
    const width = tip.offsetWidth;
    const viewportWidth = view?.innerWidth ?? 0;
    const minLeft = scrollX + 8;
    const maxLeft = viewportWidth > 0 ? scrollX + viewportWidth - width - 8 : minLeft;
    tip.style.left = `${Math.max(minLeft, Math.min(rect.left + scrollX, maxLeft))}px`;
  }

  /**
   * 悬停进入：有预览 URL 才挂 `<img>`，并在 load / error 两个终点各自重摆位。
   *
   * 三种态如实区分（与 `describe()` 的文案一一对应，禁留白装成功）：
   *   - 有 URL → 出图；文件被移走时 `error` 切「图片不可用（sha 前 8）」；
   *   - 有 `ref` 无 URL → 宿主视图已销毁，说「暂无预览」；
   *   - 连 `ref` 都没有 → 回执在途，说「正在保存」。
   */
  function showPreview(chip: HTMLElement, item: CapturedImage): void {
    const tip = ensureTip();
    resetTip(tip);
    if (!item.previewUri) {
      fillTipText(tip, item.ref ? '暂无预览（宿主未提供图片地址）' : '正在保存到本地，暂无预览');
      tip.hidden = false;
      placeTip(tip, chip);
      return;
    }
    const img = doc.createElement('img');
    img.className = 'image-chip-tip__img';
    img.alt = item.name;
    img.addEventListener('load', () => placeTip(tip, chip));
    img.addEventListener('error', () => {
      // 文件被删 / 被移走：切文本态如实报（方案 §5.10 缺陷态），chip 本身不受影响
      resetTip(tip);
      fillTipText(tip, `图片不可用（${(item.ref?.sha256 ?? item.sha256 ?? '').slice(0, 8)}）`);
      tip.hidden = false;
      placeTip(tip, chip);
    });
    tip.appendChild(img);
    tip.hidden = false;
    placeTip(tip, chip);
    img.src = item.previewUri; // 悬停才设 src（不在 chip 上长期挂位图）
  }

  /** 悬停离开 / 重建 / 销毁：收起并清内容（唯一出口，防各调用点各清一半） */
  function hidePreview(): void {
    if (!previewTip) return;
    resetTip(previewTip);
  }

  /**
   * 单个 `File` → 校验 → 收入或拒收。任何异常都转成可见的拒绝项，不向上抛。
   *
   * 名字来源按入口分（IMG-4）：**粘贴一律不用 `file.name`**——剪贴板位图没有真实文件名，
   * Chromium 会合成一个 `image.png` 塞进来（**非空** ⇒ `resolveImageName` 走「原样用」
   * ⇒ D29 兜底成死码，多张截图同名不可辨）。粘贴本无名字，语义上就不该拿平台占位当锚，
   * 统一按 sha256 派生；拖入的 `File` 来自真实文件（拖入路径有真名，保留）。
   */
  async function ingestFile(file: File, source: 'paste' | 'drop-file'): Promise<void> {
    const declaredName = source === 'paste' ? '' : file.name || '';
    try {
      const bytes = await readBytes(file);
      const digest = await sha256(bytes);
      const result: ImageCheckResult = validateImageCandidate(
        bytes,
        digest,
        file.type,
        declaredName,
      );
      if (result.ok) {
        // 同轮同 sha256 只留一条 chip（方案 G4）：sha256 只管物理文件去重，数组去重
        // 必须显式做——同一张图发两遍 = 双倍 token + 无意义视觉重复。
        if (accepted.some((it) => it.sha256 === digest)) {
          notice('该图片已添加');
          render();
          return;
        }
        accepted.push({
          source,
          name: result.name,
          byteLength: bytes.length,
          mime: result.mime,
          width: result.width,
          height: result.height,
          sha256: digest,
        });
        // 采集即写盘（Q1 定案）：字节当场上行，**不等发送**——隐藏侧栏即销毁 webview
        // 上下文，留在内存里的图会随上下文蒸发。sha/mime/宽高随行只为 chip 即时可用
        // 与回执关联；真相由宿主复算后经 `image_ingest_result` 换回（见 applyIngestResult）。
        post({
          type: 'image_ingest',
          base64: bytesToBase64(bytes),
          name: result.name,
          mime: result.mime,
          width: result.width,
          height: result.height,
          sha256: digest,
        });
      } else {
        rejected.push({
          source,
          name: declaredName || '图片',
          // 文案刻意**不带环号**：屏上 loop 已占用「第 N 步」措辞（术语锚点 §4.2 禁同词同屏），
          // 且用户只关心「为什么被拒」、不关心是第几环——环号保留在结构化字段供测试/日志定位
          reason: `图片校验未通过：${result.message}`,
        });
      }
    } catch (err) {
      rejected.push({
        source,
        name: declaredName || '图片',
        reason: `读取失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
    render();
  }

  function ingestUri(uri: string): void {
    const name = uri.split('/').pop() || uri;
    accepted.push({ source: 'drop-uri', name, uri });
    render();
  }

  /**
   * 落盘回执处理 —— chip 的「提案值 → 真值」换真 / 转拒收态。
   *
   * 三条硬约束（都是「静默错态」的防口）：
   * ① 按回执回显的提案 sha256 定位原 chip，**不按名字/顺序猜**（多图并发必错配）；
   * ② 用户已 × 掉的条目不再复活：迟到回执找不到目标就直接丢弃（幽灵 chip 比丢回执更坏）；
   * ③ `rejected`/`failed` 一律转成**可见**拒收 chip，不许静默删除——用户必须知道图为什么没进。
   */
  function applyIngestResult(msg: IngestResult): void {
    const idx = accepted.findIndex((it) => it.sha256 === msg.sha256);
    const target = idx >= 0 ? accepted[idx] : undefined;
    if (msg.status === 'ok' && msg.ref) {
      if (!target) return;
      // 真值覆盖提案：同一份字节复算，正常必然相等；不相等只可能是传输损坏，一律信宿主
      target.ref = msg.ref;
      // 预览 URL 只在宿主真的给了才覆盖（缺省 = 不可预览，不是「旧地址仍有效」）
      if (msg.uri) target.previewUri = msg.uri;
      target.name = msg.ref.name;
      target.mime = msg.ref.mime;
      target.width = msg.ref.width;
      target.height = msg.ref.height;
      target.byteLength = msg.ref.bytes;
      target.sha256 = msg.ref.sha256;
      render();
      return;
    }
    if (!target) return;
    accepted.splice(idx, 1);
    rejected.push({
      source: target.source,
      name: target.name,
      // 文案原样上屏（宿主产出、面向用户）；缺省只可能是契约破损，给中性兜底不许留空
      reason: msg.reason ?? (msg.status === 'ok' ? '回执缺少图片引用' : '图片未被采用'),
    });
    render();
  }

  /**
   * 文件选择框回执（Q3）：无提案阶段，`ref` 到手即真相。
   *
   * 三条硬约束（与 `applyIngestResult` 同族同源，都是「静默错态」的防口）：
   * ① `ok` 先过 G4 同轮去重（同一张图选两次/先粘贴后选择只留一条 chip，提示「已添加」）；
   * ② `rejected`/`failed` 转**可见**拒收 chip（本路径没有既有 chip 可转态——拒绝也要
   *    让用户看见为什么，绝不静默丢）；
   * ③ `uri` 缺省 = 预览不可用（如实降级），不伪造地址。
   */
  function applyPicked(msg: PickedResult): void {
    if (msg.status === 'ok' && msg.ref) {
      const ref = msg.ref;
      // G4 去重：与粘贴路径同一判据（物理 sha256），键此刻已是宿主复算的真值
      if (accepted.some((it) => it.sha256 === ref.sha256)) {
        notice('该图片已添加');
        return;
      }
      accepted.push({
        source: 'pick',
        name: ref.name,
        byteLength: ref.bytes,
        mime: ref.mime,
        width: ref.width,
        height: ref.height,
        sha256: ref.sha256,
        ref,
        previewUri: msg.uri,
      });
      render();
      return;
    }
    rejected.push({
      source: 'pick',
      name: msg.name,
      // 文案原样上屏（宿主产出）；缺省只可能是契约破损，给中性兜底不许留空
      reason: msg.reason ?? (msg.status === 'ok' ? '回执缺少图片引用' : '图片未被采用'),
    });
    render();
  }

  /**
   * 发送取图：把 chip 状态翻译成「能发什么 / 为什么发不了」。
   *
   * 判据按 chip 的字段形态（与 `describe` 三态一一对应），不依赖异步时序：
   *   - `ref` 就绪 → 可发（真相已由宿主复算，见 `applyIngestResult`）；
   *   - 有 `uri` 无 `ref` → 资源管理器拖入，本端读不到字节、宿主读盘通道尚未接线
   *     （台账 IMG-2 未做项）⇒ **恒拦**，如实告知而不是悄悄跳过；
   *   - 无 `uri` 无 `ref` → 落盘回执在途 ⇒ 拦下等它（本地写盘是毫秒级，重试即可）。
   * 空候选返回空数组（零图片照常发送）。
   */
  function resolveSendable(interjectRoute: boolean): SendableImages {
    if (accepted.length === 0) return { refs: [] };
    if (interjectRoute) {
      return { blocked: '生成中不支持发送图片，请等本轮结束后再发' };
    }
    const uriOnly = accepted.filter((it) => !it.ref && it.uri);
    if (uriOnly.length > 0) {
      return { blocked: '资源管理器拖入的图片暂不支持发送，请移除后改用粘贴或拖入文件' };
    }
    const pending = accepted.filter((it) => !it.ref);
    if (pending.length > 0) {
      return { blocked: `有 ${pending.length} 张图片仍在保存到本地，请稍候再发送` };
    }
    return { refs: accepted.map((it) => it.ref!) };
  }

  function onPaste(e: ClipboardEvent): void {
    const files = pickImageFiles(e.clipboardData);
    // 没有图片就**不拦截**：纯文本粘贴照常进 textarea（劫持它才是 bug）
    if (files.length === 0) {
      /**
       * 富文本粘贴（从网页复制的图片）常见只有 `text/html`、没有 file item。
       * 方案 G5 定的是「不解析 text/html」，此处的责任只是**别装作收到了**——
       * 但也不能对任何一次普通文本粘贴都弹提示，故只在剪贴板里确实带 html 时留一条拒绝项。
       */
      const html = e.clipboardData?.getData('text/html') ?? '';
      if (html.includes('<img')) {
        rejected.push({
          source: 'paste',
          name: '网页图片',
          reason: '富文本里的图片不解析：请先把图片存成文件，再粘贴或拖入',
        });
        render();
      }
      return;
    }
    e.preventDefault(); // 有图才拦，避免图片的「文件名文本」同时落进 textarea
    for (const file of files) void ingestFile(file, 'paste');
  }

  function onDragOver(e: DragEvent): void {
    const transfer = e.dataTransfer;
    const hasFiles = transfer ? Array.from(transfer.types).includes('Files') : false;
    const hasUri = transfer ? Array.from(transfer.types).includes('text/uri-list') : false;
    if (!hasFiles && !hasUri) return; // 拖的是别的东西：不抢
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    dropZone?.classList.add('is-image-drag');
  }

  function onDragLeave(): void {
    dropZone?.classList.remove('is-image-drag');
  }

  function onDrop(e: DragEvent): void {
    dropZone?.classList.remove('is-image-drag');
    const transfer = e.dataTransfer;
    if (!transfer) return;
    const files = pickImageFiles(transfer);
    if (files.length > 0) {
      e.preventDefault();
      for (const file of files) void ingestFile(file, 'drop-file');
      return;
    }
    // 资源管理器拖入：`files` 为空，URI 在 uri-list（边界文档 B3）
    const uris = parseUriList(transfer.getData('text/uri-list'));
    if (uris.length === 0) return;
    e.preventDefault();
    for (const uri of uris) ingestUri(uri);
  }

  input?.addEventListener('paste', onPaste);
  dropZone?.addEventListener('dragover', onDragOver);
  dropZone?.addEventListener('dragleave', onDragLeave);
  dropZone?.addEventListener('drop', onDrop);

  // ─── 上传按钮（常驻，D27）：绑定与能力态收口在本层 ───
  const attachBtn = deps.attachBtn ?? null;
  /** 初始按「未声明视觉能力」处理：chat_providers 未到前宁可先灰后亮（见接口注释） */
  let attachVisionEnabled = false;
  function onAttachClick(): void {
    // 置灰 ≠ 点不动：点击跳设置开启（D27「隐藏 = 不可发现的错误」的姊妹语义）
    if (attachVisionEnabled) post({ type: 'image_pick_request' });
    else post({ type: 'open_settings_tab', tab: 'config' });
  }
  /** 按钮能力态的唯一改写点（chat_providers 投影值经此进 UI；挂载期也调它落初始态） */
  function setAttachEnabled(vision: boolean): void {
    attachVisionEnabled = vision;
    if (!attachBtn) return;
    // 置灰态用 class + aria-disabled 表达，不用 disabled 属性——按钮必须保持可点（跳设置）
    attachBtn.classList.toggle('is-vision-off', !vision);
    attachBtn.setAttribute('aria-disabled', String(!vision));
    attachBtn.title = vision
      ? '添加图片（也可直接粘贴）'
      : '当前模型未开启图片输入——点击前往设置开启';
  }
  attachBtn?.addEventListener('click', onAttachClick);
  // 挂载即落初始态：不依赖骨架预置 class（chat_providers 未到前按未声明处理）
  setAttachEnabled(false);

  return {
    get accepted() {
      return accepted;
    },
    get rejected() {
      return rejected;
    },
    applyIngestResult,
    applyPicked,
    setAttachEnabled,
    resolveSendable,
    clear() {
      accepted.length = 0;
      rejected.length = 0;
      render();
    },
    dispose() {
      input?.removeEventListener('paste', onPaste);
      dropZone?.removeEventListener('dragover', onDragOver);
      dropZone?.removeEventListener('dragleave', onDragLeave);
      dropZone?.removeEventListener('drop', onDrop);
      dropZone?.classList.remove('is-image-drag');
      attachBtn?.removeEventListener('click', onAttachClick);
      accepted.length = 0;
      rejected.length = 0;
      if (row) row.textContent = '';
      hidePreview();
    },
  };
}
