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
  bytesToBase64,
  createImageCapture,
  parseUriList,
  pickImageFiles,
  type ImageCaptureHandle,
} from '../helpers/imageCapture.js';
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';

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
      eventWithData(
        'paste',
        'clipboardData',
        transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(chips().length).toBe(1);
    expect(chips()[0]!.querySelector('.skill-chip__name')?.textContent).toBe('shot.png');
    expect(dom.row.hidden).toBe(false);
    // 探针期必须**可见地**标注「未接入发送」：没有它用户会以为图已经发出去了。
    // 这条断言是删除开关——发送链路接线时它会红，提醒同批删 CSS 里的 ::after 规则。
    expect(chips()[0]!.classList.contains('image-chip--probe')).toBe(true);
    expect(chips()[0]!.querySelector('.skill-chip__name')?.getAttribute('title')).toContain(
      '暂不随消息发送',
    );
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
      eventWithData(
        'paste',
        'clipboardData',
        transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }),
      ),
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
      eventWithData(
        'paste',
        'clipboardData',
        transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }),
      ),
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
      eventWithData(
        'paste',
        'clipboardData',
        transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }),
      ),
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
    const e = eventWithData(
      'paste',
      'clipboardData',
      transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }),
    );
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
      eventWithData(
        'drop',
        'dataTransfer',
        transferOf({ uriList: 'file:///a.png\nfile:///b.png' }),
      ),
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
    const plain = eventWithData('dragover', 'dataTransfer', {
      items: [],
      files: [],
      types: ['text/plain'],
    } as unknown as DataTransfer);
    dom.dropZone.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);

    const withUri = eventWithData('dragover', 'dataTransfer', {
      items: [],
      files: [],
      types: ['text/uri-list'],
    } as unknown as DataTransfer);
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
      eventWithData('dragover', 'dataTransfer', {
        items: [],
        files: [],
        types: ['text/uri-list'],
      } as unknown as DataTransfer),
    );
    expect(dom.dropZone.classList.contains('is-image-drag')).toBe(true);
    dom.dropZone.dispatchEvent(
      eventWithData('drop', 'dataTransfer', transferOf({ uriList: 'file:///a.png' })),
    );
    expect(dom.dropZone.classList.contains('is-image-drag')).toBe(false);
  });
});

describe('createImageCapture — 上行与落盘回执（IMG-2）', () => {
  let handle: ImageCaptureHandle | null = null;
  let dom: ReturnType<typeof mountDom>;
  /** 上行消息收集（生产侧 = vscode.postMessage，此处只收不发） */
  const sent: WebviewToExtensionMessage[] = [];
  /** 瞬态提示收集（生产侧 = 活动抽屉） */
  const notices: string[] = [];

  beforeEach(() => {
    dom = mountDom();
    sent.length = 0;
    notices.length = 0;
  });

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  /** 造一个「采集即上行」的实例（注入 readBytes/sha256/post/notice，零真实 IO） */
  function mountWithUplink(bytes: Uint8Array<ArrayBuffer>): void {
    handle = createImageCapture({
      doc: document,
      ...dom,
      readBytes: async () => bytes,
      sha256: async () => SHA,
      post: (msg) => sent.push(msg),
      notice: (text) => notices.push(text),
    });
  }

  /** 触发一次粘贴并等采集的异步链跑完（readBytes → sha256 → 校验 → post） */
  async function pastePng(name = 'shot.png'): Promise<void> {
    const file = new File([pngBytes(8, 8)], name, { type: 'image/png' });
    dom.input.dispatchEvent(
      eventWithData(
        'paste',
        'clipboardData',
        transferOf({ items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }),
      ),
    );
    // 异步链共三跳（读字节 / 摘要 / 校验），多等几拍比猜跳数稳
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('校验通过 => 立刻上行 image_ingest（采集即写盘，不等发送）', async () => {
    const bytes = pngBytes(8, 8);
    mountWithUplink(bytes);
    await pastePng();

    expect(sent.length).toBe(1);
    const msg = sent[0]!;
    expect(msg.type).toBe('image_ingest');
    if (msg.type !== 'image_ingest') return; // 类型收窄（测试里显式判一次，便于下方断言读字段）
    expect(msg.sha256).toBe(SHA);
    expect(msg.mime).toBe('image/png');
    expect(msg.width).toBe(8);
    expect(msg.height).toBe(8);
    expect(msg.name).toBe('shot.png');
    // base64 必须能原样解回字节（通道上唯一的字节形态，编解码任一错都会在图变半张时暴露）
    expect(Buffer.from(msg.base64, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });

  it('回执 ok => chip 提案值换成宿主真值（ref 落进候选，供发送链路消费）', async () => {
    mountWithUplink(pngBytes(8, 8));
    await pastePng();

    // 宿主复算的真值：改名 + 改尺寸（模拟提案与真值不同，验证「以回执为准」）
    handle!.applyIngestResult({
      type: 'image_ingest_result',
      status: 'ok',
      sha256: SHA,
      ref: {
        sha256: SHA,
        mime: 'image/png',
        width: 1024,
        height: 768,
        bytes: 4096,
        name: '真名.png',
      },
    });

    expect(handle!.accepted[0]!.ref).toEqual({
      sha256: SHA,
      mime: 'image/png',
      width: 1024,
      height: 768,
      bytes: 4096,
      name: '真名.png',
    });
    expect(chips().length).toBe(1);
    expect(chips()[0]!.querySelector('.skill-chip__name')?.textContent).toBe('真名.png');
    // 落盘终态要能在 title 里看到（否则用户分不清「已保存」与「只在内存里」）
    expect(chips()[0]!.querySelector('.skill-chip__name')?.getAttribute('title')).toContain(
      '已保存',
    );
  });

  it('回执 rejected => 转**可见**拒收 chip（含宿主理由），不静默删', async () => {
    mountWithUplink(pngBytes(8, 8));
    await pastePng();

    handle!.applyIngestResult({
      type: 'image_ingest_result',
      status: 'rejected',
      sha256: SHA,
      reason: '图片数据传输不完整（base64 校验失败）',
    });

    expect(handle!.accepted.length).toBe(0);
    expect(handle!.rejected.length).toBe(1);
    expect(handle!.rejected[0]!.reason).toContain('base64');
    expect(chips()[0]!.classList.contains('image-chip--rejected')).toBe(true);
  });

  it('用户已 × 掉的芯片收到迟到回执 => 不复活（幽灵 chip 比丢回执更坏）', async () => {
    mountWithUplink(pngBytes(8, 8));
    await pastePng();
    (chips()[0]!.querySelector('.skill-chip__remove') as HTMLElement).click();

    handle!.applyIngestResult({
      type: 'image_ingest_result',
      status: 'ok',
      sha256: SHA,
      ref: { sha256: SHA, mime: 'image/png', width: 8, height: 8, bytes: 33, name: 'shot.png' },
    });

    expect(handle!.accepted.length).toBe(0);
    expect(chips().length).toBe(0);
  });

  it('同轮重复粘贴同一张图 => 只留一条 chip，并提示「已添加」（G4）', async () => {
    mountWithUplink(pngBytes(8, 8));
    await pastePng();
    await pastePng('again.png');

    expect(handle!.accepted.length).toBe(1);
    expect(chips().length).toBe(1);
    expect(notices).toContain('该图片已添加');
    // 去重走的是「已上行过一次」的候选，不再发第二条上行（省一次字节传输）
    expect(sent.length).toBe(1);
  });
});

describe('bytesToBase64（上行编码）', () => {
  it('往返保真，且不因大字节数组触达 apply 实参上限', () => {
    // 5 MiB 量级（= 入口上限）是本函数必须扛住的真实尺寸：逐参展开写法在这里必 RangeError
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 997) big[i] = i & 0xff;
    const encoded = bytesToBase64(big);
    expect(encoded.length).toBe(Math.ceil(big.length / 3) * 4);
    expect(Buffer.from(encoded, 'base64').equals(Buffer.from(big))).toBe(true);
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
