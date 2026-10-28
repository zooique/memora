/**
 * 图片采集层测试 — 粘贴 / 拖入 → chip
 *
 * 测试形态说明：本文件用 **jsdom** 环境（`// @vitest-environment jsdom`），因为被测对象
 * 天然是 DOM 事件层。这里**不 mock `vscode`**（该模块不依赖它），故不受「jsdom 下
 * `vi.mock('vscode')` 失效」那条坑影响。
 *
 * 关键取舍：`readBytes` 与 `sha256` 全部**注入**而不是打真实文件 / 真 Web Crypto——
 * 这样每个用例的字节形态可精确控制（能构造超限、截断、非图片等真实边界），
 * 且测试不依赖 jsdom 是否实现了 `Blob.arrayBuffer`。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createImageCapture,
  parseUriList,
  pickImageFiles,
  type ImageCaptureHandle,
} from '../helpers/imageCapture.js';

/**
 * 构造最小合法 PNG（33 字节：8 字节签名 + IHDR 长度/类型 + 宽高 + 尾部占位）
 *
 * 返回类型必须写成 `Uint8Array<ArrayBuffer>` 而不是裸 `Uint8Array`：后者在 TS 5.7+ 里会
 * 退化成 `Uint8Array<ArrayBufferLike>`，而 `BlobPart` / `crypto.subtle.digest` 都不收
 * SharedArrayBuffer 视图 ⇒ 直接喂给 `new File([...])` 会被 tsc 打红（vitest 不查类型，抓不到）。
 */
function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8); // IHDR 数据长度 = 13（大端）
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  b.set([(width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255], 16);
  b.set([(height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255], 20);
  return b;
}

/** 把任意 shaped 对象塞进事件的只读字段（jsdom 的 ClipboardEvent/DragEvent 构造器不吃这些） */
function eventWithData(
  type: string,
  field: 'clipboardData' | 'dataTransfer',
  value: unknown,
): Event {
  const e = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(e, field, { value, writable: false });
  return e;
}

/** 最小 DataTransfer 形状：只实现被测代码实际读的字段 */
function transferOf(opts: {
  items?: { kind: string; type: string; getAsFile: () => File | null }[];
  files?: File[];
  uriList?: string;
}): DataTransfer {
  const files = opts.files ?? [];
  return {
    items: opts.items ?? [],
    files: Object.assign(files, { item: (i: number) => files[i] ?? null }),
    types: [
      ...(files.length > 0 || (opts.items?.length ?? 0) > 0 ? ['Files'] : []),
      ...(opts.uriList !== undefined ? ['text/uri-list'] : []),
    ],
    getData: (fmt: string) => (fmt === 'text/uri-list' ? (opts.uriList ?? '') : ''),
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function mountDom(): {
  input: HTMLTextAreaElement;
  dropZone: HTMLElement;
  row: HTMLElement;
} {
  document.body.innerHTML = `
    <div id="inputWrap">
      <div id="imageChips" class="skill-chip-row" hidden></div>
      <textarea id="input"></textarea>
    </div>`;
  return {
    input: document.getElementById('input') as HTMLTextAreaElement,
    dropZone: document.getElementById('inputWrap') as HTMLElement,
    row: document.getElementById('imageChips') as HTMLElement,
  };
}

const SHA = 'a1b2c3d4e5f6a7b8';

function chips(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#imageChips .image-chip'));
}

describe('parseUriList（RFC 2483 子集）', () => {
  it('CRLF 与 LF 混排都能切分', () => {
    expect(parseUriList('file:///a.png\r\nfile:///b.png\n')).toEqual([
      'file:///a.png',
      'file:///b.png',
    ]);
  });

  it('跳过 # 注释行与空行（VS Code 拖拽载荷里两者都可能出现）', () => {
    expect(parseUriList('# 注释\n\nfile:///a.png\n   \n')).toEqual(['file:///a.png']);
  });

  it('空串 => 空数组，而不是「含一个空串的数组」', () => {
    expect(parseUriList('')).toEqual([]);
  });
});

describe('pickImageFiles', () => {
  it('items 里有 image/* 的 file 才收，跳过文本项', () => {
    const png = new File([pngBytes(2, 3)], 'a.png', { type: 'image/png' });
    const t = transferOf({
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => png },
      ],
    });
    expect(pickImageFiles(t)).toEqual([png]);
  });

  it('items 为空时回退读 files（平台差异，边界文档 B3 同族现象）', () => {
    const png = new File([pngBytes(1, 1)], 'b.png', { type: 'image/png' });
    expect(pickImageFiles(transferOf({ items: [], files: [png] }))).toEqual([png]);
  });

  it('非图片文件一律不收（声明类型不是 image/*）', () => {
    const txt = new File(['hello'], 'a.txt', { type: 'text/plain' });
    expect(pickImageFiles(transferOf({ items: [], files: [txt] }))).toEqual([]);
  });

  it('null transfer => 空数组（粘贴事件可能没有 clipboardData）', () => {
    expect(pickImageFiles(null)).toEqual([]);
  });
});

describe('createImageCapture — 粘贴', () => {
  let handle: ImageCaptureHandle | null = null;
  let dom: ReturnType<typeof mountDom>;

  beforeEach(() => {
    dom = mountDom();
  });

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it('粘贴合法 PNG => 生成 chip，显示文件名，行取消 hidden', async () => {
    const bytes = pngBytes(640, 480);
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => bytes,
      sha256: async () => SHA,
    });
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    dom.input.dispatchEvent(
      eventWithData('paste', 'clipboardData', transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] })),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(chips().length).toBe(1);
    expect(chips()[0]!.querySelector('.skill-chip__name')?.textContent).toBe('shot.png');
    expect(dom.row.hidden).toBe(false);
    expect(handle.accepted.length).toBe(1);
    // 提案摘要与尺寸必须落进候选（发送时刻要用它们，且不是渲染期再算）
    expect(handle.accepted[0]!.sha256).toBe(SHA);
    expect(handle.accepted[0]!.width).toBe(640);
    expect(handle.accepted[0]!.height).toBe(480);
  });

  it('无文件名 => 走 D29 兜底命名「粘贴图片-<sha 前 6>」', async () => {
    const bytes = pngBytes(10, 10);
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => bytes,
      sha256: async () => SHA,
    });
    const file = new File([bytes], '', { type: 'image/png' });
    dom.input.dispatchEvent(
      eventWithData('paste', 'clipboardData', transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] })),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.accepted[0]!.name).toBe(`粘贴图片-${SHA.slice(0, 6)}`);
  });

  it('超限图片 => **可见的拒收 chip**（不静默丢）', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(pngBytes(1, 1).subarray(0, 33), 0);
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => big,
      sha256: async () => SHA,
    });
    const file = new File([big], 'huge.png', { type: 'image/png' });
    dom.input.dispatchEvent(
      eventWithData('paste', 'clipboardData', transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] })),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.accepted.length).toBe(0);
    expect(handle.rejected.length).toBe(1);
    const chip = chips()[0]!;
    expect(chip.classList.contains('image-chip--rejected')).toBe(true);
    // 原因必须写进 title 才能被用户看到
    expect(chip.querySelector('.skill-chip__name')?.getAttribute('title')).toContain('5 MiB');
  });

  it('读字节抛错 => 转成可见拒收项，不向上冒泡', async () => {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => {
        throw new Error('内核不支持');
      },
      sha256: async () => SHA,
    });
    const file = new File(['x'], 'broken.png', { type: 'image/png' });
    dom.input.dispatchEvent(
      eventWithData('paste', 'clipboardData', transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] })),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.rejected.length).toBe(1);
    expect(handle.rejected[0]!.reason).toContain('内核不支持');
    expect(chips()[0]!.classList.contains('image-chip--rejected')).toBe(true);
  });

  it('纯文本粘贴 => 不被拦截、不产生 chip（劫持文本粘贴才是 bug）', () => {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => new Uint8Array(),
      sha256: async () => SHA,
    });
    const e = eventWithData('paste', 'clipboardData', transferOf({ items: [] }));
    dom.input.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
    expect(chips().length).toBe(0);
    expect(dom.row.hidden).toBe(true);
  });

  it('富文本里的图片（只有 text/html 没有 file）=> 明确提示不解析（G5）', () => {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => new Uint8Array(),
      sha256: async () => SHA,
    });
    const clipboard = {
      items: [],
      files: [],
      types: [],
      getData: (fmt: string) => (fmt === 'text/html' ? '<p><img src="x.png"></p>' : ''),
    } as unknown as DataTransfer;
    dom.input.dispatchEvent(eventWithData('paste', 'clipboardData', clipboard));

    expect(handle.rejected.length).toBe(1);
    expect(handle.rejected[0]!.reason).toContain('不解析');
  });

  it('合法图片 => paste 必须 preventDefault（否则图片名会同时落进 textarea）', async () => {
    const bytes = pngBytes(1, 1);
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => bytes,
      sha256: async () => SHA,
    });
    const file = new File([bytes], 'a.png', { type: 'image/png' });
    const e = eventWithData('paste', 'clipboardData', transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }));
    dom.input.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('createImageCapture — 拖入', () => {
  let handle: ImageCaptureHandle | null = null;
  let dom: ReturnType<typeof mountDom>;

  beforeEach(() => {
    dom = mountDom();
  });

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it('资源管理器拖入（只有 uri-list）=> 只登记 URI，不读字节', () => {
    let readCalled = false;
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => {
        readCalled = true;
        return new Uint8Array();
      },
      sha256: async () => SHA,
    });
    dom.dropZone.dispatchEvent(
      eventWithData('drop', 'dataTransfer', transferOf({ uriList: 'file:///c%3A/ws/pic.png' })),
    );

    expect(readCalled).toBe(false);
    expect(handle.accepted.length).toBe(1);
    expect(handle.accepted[0]!.source).toBe('drop-uri');
    expect(handle.accepted[0]!.uri).toBe('file:///c%3A/ws/pic.png');
    expect(handle.accepted[0]!.name).toBe('pic.png');
  });

  it('多条 uri-list => 每条一个 chip', () => {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => new Uint8Array(),
      sha256: async () => SHA,
    });
    dom.dropZone.dispatchEvent(
      eventWithData('drop', 'dataTransfer', transferOf({ uriList: 'file:///a.png\nfile:///b.png' })),
    );

    expect(handle.accepted.length).toBe(2);
    expect(chips().length).toBe(2);
  });

  it('dragover 只在带 Files / uri-list 时抢占（拖别的不许 preventDefault）', () => {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => new Uint8Array(),
      sha256: async () => SHA,
    });
    const plain = eventWithData('dragover', 'dataTransfer', { items: [], files: [], types: ['text/plain'] } as unknown as DataTransfer);
    dom.dropZone.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);

    const withUri = eventWithData('dragover', 'dataTransfer', { items: [], files: [], types: ['text/uri-list'] } as unknown as DataTransfer);
    dom.dropZone.dispatchEvent(withUri);
    expect(withUri.defaultPrevented).toBe(true);
    expect(dom.dropZone.classList.contains('is-image-drag')).toBe(true);
  });

  it('drop 后落点提示类必须撤掉（否则虚框常驻）', () => {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => new Uint8Array(),
      sha256: async () => SHA,
    });
    dom.dropZone.dispatchEvent(
      eventWithData('dragover', 'dataTransfer', { items: [], files: [], types: ['text/uri-list'] } as unknown as DataTransfer),
    );
    expect(dom.dropZone.classList.contains('is-image-drag')).toBe(true);
    dom.dropZone.dispatchEvent(
      eventWithData('drop', 'dataTransfer', transferOf({ uriList: 'file:///a.png' })),
    );
    expect(dom.dropZone.classList.contains('is-image-drag')).toBe(false);
  });
});

describe('createImageCapture — 移除与销毁', () => {
  let handle: ImageCaptureHandle | null = null;
  let dom: ReturnType<typeof mountDom>;

  beforeEach(() => {
    dom = mountDom();
  });

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it('点 × 移除 => chip 消失、行重新 hidden', () => {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => new Uint8Array(),
      sha256: async () => SHA,
    });
    dom.dropZone.dispatchEvent(
      eventWithData('drop', 'dataTransfer', transferOf({ uriList: 'file:///a.png' })),
    );
    expect(dom.row.hidden).toBe(false);

    (chips()[0]!.querySelector('.skill-chip__remove') as HTMLElement).click();

    expect(chips().length).toBe(0);
    expect(dom.row.hidden).toBe(true);
    expect(handle.accepted.length).toBe(0);
  });

  it('dispose => 监听器摘除（后续事件不再改变状态）+ 行清空', () => {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => new Uint8Array(),
      sha256: async () => SHA,
    });
    dom.dropZone.dispatchEvent(
      eventWithData('drop', 'dataTransfer', transferOf({ uriList: 'file:///a.png' })),
    );
    const disposed = handle;
    disposed.dispose();

    dom.dropZone.dispatchEvent(
      eventWithData('drop', 'dataTransfer', transferOf({ uriList: 'file:///b.png' })),
    );

    expect(disposed.accepted.length).toBe(0);
    expect(chips().length).toBe(0);
  });
});
