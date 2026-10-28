/**
 * 图片采集层 — 粘贴 / 拖入 → 一条 chip
 *
 * 职责边界（刻意划死，勿扩张）：
 *   - **只做采集，不落盘、不碰内核**：落盘与 sha256 裁定归宿主（`ImageRef` 真源在会话
 *     存储侧），本文件产出的 `sha256` 只是**提案值**（用于 D29 兜底命名与同轮去重的粗筛），
 *     最终以宿主重算为准。
 *   - **上行通道已立项、未接线**（2026-10-28 Q1 拍板反转原 K1 期「发送时随 `input`
 *     字段交付」口径）：真机实测隐藏侧栏即销毁 webview 上下文（未发送图全丢，边界文档
 *     §7 第 7 条）⇒ 定案**采集即写盘**，协议经治理评估扩位 +2 新增 `image_ingest` /
 *     `image_ingest_result` 两条通道（定义见 `shared/protocol.ts`）。本文件当前仍只做采集，
 *     上行接线在 IMG-2 落盘链子块完成（拍板记录 = 台账 IMG-2 第 6 子块）。
 *
 * 为什么走依赖注入而不是直接摸全局（对齐 `helpers/toast.ts` 的既有惯例）：
 *   chatView 的测试在 jsdom 里重建 DOM，模块级自执行会把监听器绑到上一轮的旧节点上。
 *   全部 DOM 入口由调用方传入 ⇒ 每次 mount 重新绑定、`dispose()` 一次收干净。
 *
 * 三条路径的能力差（真机结论见边界文档 §4）：
 *   | 来源 | 拿到什么 | 能否当场校验 |
 *   | 粘贴 / 从系统文件管理器拖入 | `File`（可读字节） | 能（六步校验全跑） |
 *   | 从 VS Code 资源管理器拖入 | 只有 `text/uri-list` 字符串 | **不能**——webview 读不到工作区
 *     文件（`localResourceRoots` 只放行 `dist/webview`）⇒ 只登记 URI，读盘与校验推迟到宿主 |
 */

import { type ImageCheckResult, validateImageCandidate } from '../../shared/imageValidation.js';
import { syncRowEdges } from './chipRow.js';
import { getIconSvg } from '../scripts/icons.js';

/** 采集成功的候选图。字段与内核 `ImageRef` 对齐，但 `sha256` 是**提案值**（见文件头）。 */
export interface CapturedImage {
  source: 'paste' | 'drop-file' | 'drop-uri';
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
}

export interface ImageCaptureHandle {
  /** 当前候选（发送时刻的取值单点） */
  readonly accepted: readonly CapturedImage[];
  readonly rejected: readonly RejectedImage[];
  clear(): void;
  dispose(): void;
}

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

export function createImageCapture(deps: ImageCaptureDeps): ImageCaptureHandle {
  const { doc, input, dropZone, row } = deps;
  const sha256 = deps.sha256 ?? defaultSha256;
  const readBytes = deps.readBytes ?? defaultReadBytes;

  const accepted: CapturedImage[] = [];
  const rejected: RejectedImage[] = [];

  function render(): void {
    if (!row) return;
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
    chip.className = 'skill-chip image-chip image-chip--probe';
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
    if (item.source === 'drop-uri') parts.push('来自资源管理器，发送时由宿主读取内容');
    /**
     * 采集与「随消息发送」是两段路：本层只做到 chip。发送链路（把候选并进 `input` 消息、
     * 宿主落盘、`supportsVision` 门禁）尚未接线。
     *
     * **这句提示不是装饰**：没有它，用户看到 chip 就会以为图已经跟着发出去了，
     * 而模型实际没收到——那正是「静默丢」最坏的一种形态（用户以为自己做到了）。
     * 接线完成前必须留着，且与台账 IMG-2 的未做项一一对应。
     */
    parts.push('探针版：已采集，暂不随消息发送');
    return parts.join(' · ') || item.name;
  }

  /** 单个 `File` → 校验 → 收入或拒收。任何异常都转成可见的拒绝项，不向上抛。 */
  async function ingestFile(file: File, source: 'paste' | 'drop-file'): Promise<void> {
    const declaredName = file.name || '';
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
        accepted.push({
          source,
          name: result.name,
          byteLength: bytes.length,
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

  return {
    get accepted() {
      return accepted;
    },
    get rejected() {
      return rejected;
    },
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
      accepted.length = 0;
      rejected.length = 0;
      if (row) row.textContent = '';
    },
  };
}
