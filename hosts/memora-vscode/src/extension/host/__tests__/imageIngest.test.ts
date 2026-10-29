/**
 * 图片落盘（`image_ingest` 宿主侧）单元测试
 *
 * 覆盖三态回执与写盘真值：
 *   - `ok`：真实临时目录里产出 `{sha256}.{ext}`，回执 `ref` 的 sha/mime/宽高/字节数全由宿主复算；
 *   - `rejected`：base64 损坏 / 非法字节一律不写盘，且回执带上行提案 sha256（关联键）；
 *   - `failed`：IO 故障如实上报，不伪装成 ok。
 *
 * 用真临时目录而不是 mock fs：本模块的全部价值就是「真的把字节写对地方」，
 * mock 掉 fs 等于把被测行为一起 mock 掉（且目录名 / 扩展名推导都成了空断言）。
 * 临时目录统一经 `helpers/tmpDir.ts`（模块顶层注册清理，禁止裸 mkdtempSync）。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ImageRef } from '@zooique/memora';
// tokens 断言对拍内核单点公式（IMG-8：宿主回执的 tokens 就该等于它）
import { imageTokens } from '@zooique/memora';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../../shared/protocol.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { pngBytes } from '../../../__tests__/helpers/imageTestBytes.js';
import { ingestDiskFile, ingestImage } from '../imageIngest.js';
import { resolveAttachmentsDir } from '../projectDataDir.js';

/** 回执载荷类型（从协议联合取型，与生产同源） */
type IngestResult = Extract<ExtensionToWebviewMessage, { type: 'image_ingest_result' }>;
/** 拾取回执类型（Q3 文件选择框路径，与生产同源） */
type PickedResult = Extract<ExtensionToWebviewMessage, { type: 'image_picked' }>;
/** 上行载荷类型（同上） */
type ImageIngestMessage = Extract<WebviewToExtensionMessage, { type: 'image_ingest' }>;

/**
 * 构造最小合法 PNG → 已抽至 `__tests__/helpers/imageTestBytes.ts`（宿主侧测试共用，
 * 禁各测试文件自造第二份格式头夹具）。
 */

/** 单条 `image_ingest` 载荷（sha256 一律先用真值，便于断言「宿主复算与提案一致」） */
function ingestMsg(
  bytes: Uint8Array,
  overrides: Partial<ImageIngestMessage> = {},
): ImageIngestMessage {
  return {
    type: 'image_ingest',
    base64: Buffer.from(bytes).toString('base64'),
    name: 'shot.png',
    mime: 'image/png',
    width: 640,
    height: 480,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...overrides,
  };
}

describe('ingestImage — 成功路径', () => {
  it('写盘到 <工作区>/.memora/attachments/<sha256>.png，并以真值 ImageRef 回执', async () => {
    const dir = makeTempDir('memora-ingest-');
    const bytes = pngBytes(640, 480);
    const msg = ingestMsg(bytes);
    /** 回执收集（同步回调，生产侧就是 postMessage） */
    const results: IngestResult[] = [];

    await ingestImage(dir, msg, (r) => results.push(r));

    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r.status).toBe('ok');
    // 关联键 = 上行提案 sha256 原样回显（webview 据此把回执对回原 chip）
    expect(r.sha256).toBe(msg.sha256);
    // 真值 = 宿主复算：sha 由同一份字节算出，mime/宽高/字节数来自嗅探，name 取声明名
    expect(r.ref).toEqual({
      sha256: msg.sha256,
      mime: 'image/png',
      width: 640,
      height: 480,
      bytes: bytes.length,
      name: 'shot.png',
    });
    // tokens（IMG-8）：宿主按内核 imageTokens 单点换算随回执回传（对拍同源公式，webview 只求和）
    expect(r.tokens).toBe(imageTokens(r.ref!));

    const file = join(resolveAttachmentsDir(dir), `${msg.sha256}.png`);
    // 落盘内容必须与上行字节逐字节一致（换真不能换错文件）
    expect(readFileSync(file).equals(Buffer.from(bytes))).toBe(true);
  });

  it('同一份字节并发两次 === 同一条物理文件（幂等，不产生第二份/半截文件）', async () => {
    const dir = makeTempDir('memora-ingest-');
    const bytes = pngBytes(4, 4);
    const msg = ingestMsg(bytes);
    const results: IngestResult[] = [];

    // 并发而非串行：这正是「连粘两次」的真实时序（共用 inflight 写即幂等）
    await Promise.all([
      ingestImage(dir, msg, (r) => results.push(r)),
      ingestImage(dir, msg, (r) => results.push(r)),
    ]);

    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
    // 物理文件只有一个，且内容完整（零填充/截断都会在这里暴露）
    const files = readdirSync(resolveAttachmentsDir(dir));
    expect(files).toEqual([`${msg.sha256}.png`]);
    const written = readFileSync(join(resolveAttachmentsDir(dir), files[0]!));
    expect(written.equals(Buffer.from(bytes))).toBe(true);
  });

  it('无名图片 → 走 D29 兜底命名（name 由校验链产出，不是空串）', async () => {
    const dir = makeTempDir('memora-ingest-');
    const bytes = pngBytes(1, 1);
    const msg = ingestMsg(bytes, { name: '' });
    const results: IngestResult[] = [];

    await ingestImage(dir, msg, (r) => results.push(r));

    expect(results[0]!.ref?.name).toBe(`粘贴图片-${msg.sha256.slice(0, 6)}`);
  });

  it('注入 URL 转换器 => 回执 ok 带上 webview 可加载地址（悬停预览的唯一来源）', async () => {
    const dir = makeTempDir('memora-ingest-');
    const msg = ingestMsg(pngBytes(8, 8));
    const results: IngestResult[] = [];
    /** 转换器收到的**落盘路径**（断言它指向 attachments 下的真文件，而不是别的地址） */
    const seen: string[] = [];

    await ingestImage(
      dir,
      msg,
      (r) => results.push(r),
      (file) => {
        seen.push(file);
        return `mock-webview://${file}`;
      },
    );

    expect(results[0]!.status).toBe('ok');
    expect(seen).toEqual([join(resolveAttachmentsDir(dir), `${msg.sha256}.png`)]);
    expect(results[0]!.uri).toBe(`mock-webview://${seen[0]!}`);
  });

  it('未注入转换器（视图已销毁）=> 回执不带 uri，UI 侧如实降级为无预览', async () => {
    const dir = makeTempDir('memora-ingest-');
    const results: IngestResult[] = [];

    await ingestImage(dir, ingestMsg(pngBytes(2, 2)), (r) => results.push(r));

    expect(results[0]!.status).toBe('ok');
    // 空值必须是「字段缺省」而不是空串（空串会被 UI 当成一个可加载地址去请求）
    expect(results[0]!.uri).toBeUndefined();
  });
});

describe('ingestImage — 拒收（坏字节不写盘）', () => {
  it('base64 非法（字符集/长度不符）→ rejected，且不产生产物', async () => {
    const dir = makeTempDir('memora-ingest-');
    const results: IngestResult[] = [];

    await ingestImage(
      dir,
      // '!!!' 不在 base64 字母表内：Buffer.from 会「静默忽略」它，故必须靠往返校验拦
      {
        type: 'image_ingest',
        base64: '!!!',
        name: 'x.png',
        mime: 'image/png',
        width: 1,
        height: 1,
        sha256: 'deadbeef',
      },
      (r) => results.push(r),
    );

    expect(results[0]!.status).toBe('rejected');
    expect(results[0]!.sha256).toBe('deadbeef'); // 关联键必须回显
    expect(results[0]!.reason).toContain('base64');
    // 目录不该被创建出文件（坏字节不写盘）
    expect(() => readdirSync(resolveAttachmentsDir(dir))).toThrow();
  });

  it('字节能解码但不是图片（嗅不出 magic）→ rejected，理由面向用户', async () => {
    const dir = makeTempDir('memora-ingest-');
    const text = Buffer.from('this is definitely not an image');
    const results: IngestResult[] = [];

    await ingestImage(
      dir,
      {
        type: 'image_ingest',
        base64: text.toString('base64'),
        name: 'fake.png',
        mime: 'image/png',
        width: 1,
        height: 1,
        sha256: 'cafebabe',
      },
      (r) => results.push(r),
    );

    expect(results[0]!.status).toBe('rejected');
    expect(results[0]!.reason).toContain('不支持的图片格式');
    expect(() => readdirSync(resolveAttachmentsDir(dir))).toThrow();
  });

  it('提案 mime 与嗅探结果不符（传输损坏）→ rejected，不按提案值写盘', async () => {
    const dir = makeTempDir('memora-ingest-');
    const bytes = pngBytes(2, 2);
    const results: IngestResult[] = [];

    // 真实是 PNG，却声称 image/jpeg：只可能是链路途中被篡改，宁拒不写
    await ingestImage(dir, ingestMsg(bytes, { mime: 'image/jpeg' }), (r) => results.push(r));

    expect(results[0]!.status).toBe('rejected');
    expect(results[0]!.reason).toContain('不符');
  });
});

describe('ingestImage — IO 故障', () => {
  it('目标目录不可创建 → failed，并带可读原因（不假装成功）', async () => {
    // 拿一个「文件」当工作区根：<file>/.memora/attachments 的 mkdir 必然 ENOTDIR
    const root = makeTempDir('memora-ingest-');
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const results: IngestResult[] = [];

    await ingestImage(blocker, ingestMsg(pngBytes(8, 8)), (r) => results.push(r));

    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.reason).toContain('保存失败');
  });
});

describe('ingestDiskFile — 文件选择框拾取（Q3）', () => {
  /** 把字节写成真实磁盘文件，返回其绝对路径（拾取路径的输入形态 = Uri.fsPath） */
  function stageFile(dir: string, name: string, bytes: Uint8Array): string {
    const file = join(dir, name);
    writeFileSync(file, bytes);
    return file;
  }

  it('合法 PNG → 读盘嗅探复算真值，写盘 {sha256}.png，回执 ok（无提案阶段，ref 即真相）', async () => {
    const root = makeTempDir('memora-pick-');
    const bytes = pngBytes(64, 32);
    const staged = stageFile(root, 'photo.png', bytes);
    const results: PickedResult[] = [];

    await ingestDiskFile(root, staged, (r) => results.push(r));

    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r.status).toBe('ok');
    // name = 拾取文件 basename（D29 在本路径的生产点）
    expect(r.name).toBe('photo.png');
    expect(r.ref).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mime: 'image/png',
      width: 64,
      height: 32,
      bytes: bytes.length,
      name: 'photo.png',
    });
    // tokens（IMG-8）：语义同 image_ingest_result.tokens（对拍内核单点公式）
    expect(r.tokens).toBe(imageTokens(r.ref!));
    const written = join(resolveAttachmentsDir(root), `${r.ref!.sha256}.png`);
    expect(readFileSync(written).equals(Buffer.from(bytes))).toBe(true);
  });

  it('扩展名不可信：PNG 内容命名成 .jpg → 嗅探说了算，落盘 {sha256}.png（不落 .jpg）', async () => {
    const root = makeTempDir('memora-pick-');
    const bytes = pngBytes(4, 4);
    const staged = stageFile(root, 'looks-like-jpg.jpg', bytes);
    const results: PickedResult[] = [];

    await ingestDiskFile(root, staged, (r) => results.push(r));

    // 本路径不传声明 mime ⇒ 「与声明一致」环整环跳过（信扩展名就会在说话）
    expect(results[0]!.status).toBe('ok');
    expect(results[0]!.ref!.mime).toBe('image/png');
    expect(readdirSync(resolveAttachmentsDir(root))).toEqual([`${results[0]!.ref!.sha256}.png`]);
  });

  it('不是图片（嗅不出 magic）→ rejected 转**可见**拒收项，坏字节不写盘', async () => {
    const root = makeTempDir('memora-pick-');
    const staged = stageFile(root, 'fake.png', Buffer.from('plain text, not an image'));
    const results: PickedResult[] = [];

    await ingestDiskFile(root, staged, (r) => results.push(r));

    expect(results[0]!.status).toBe('rejected');
    expect(results[0]!.name).toBe('fake.png');
    expect(results[0]!.reason).toContain('不支持的图片格式');
    expect(() => readdirSync(resolveAttachmentsDir(root))).toThrow();
  });

  it('读盘失败（文件不存在）→ failed（IO 可重试），理由带「读取失败」', async () => {
    const root = makeTempDir('memora-pick-');
    const results: PickedResult[] = [];

    await ingestDiskFile(root, join(root, 'gone.png'), (r) => results.push(r));

    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.name).toBe('gone.png');
    expect(results[0]!.reason).toContain('读取失败');
  });

  it('注入 URL 转换器 → ok 回执带 webview 地址；转换器收到的是落盘路径', async () => {
    const root = makeTempDir('memora-pick-');
    const bytes = pngBytes(2, 2);
    const staged = stageFile(root, 'tiny.png', bytes);
    const results: PickedResult[] = [];

    await ingestDiskFile(
      root,
      staged,
      (r) => results.push(r),
      (file) => `mock-webview://${file}`,
    );

    expect(results[0]!.status).toBe('ok');
    expect(results[0]!.uri).toBe(
      `mock-webview://${join(resolveAttachmentsDir(root), `${results[0]!.ref!.sha256}.png`)}`,
    );
  });
});

describe('warmCache — 落盘后字节缓存预热（真机验收断点A）', () => {
  it('ingestImage ok：warmCache 收到与回执 ref 全等的真值，且先于 ok 回执（回执到达即缓存已热）', async () => {
    const dir = makeTempDir('memora-ingest-');
    const bytes = pngBytes(8, 8);
    const msg = ingestMsg(bytes);
    const results: IngestResult[] = [];
    /** 预热收到的 ref（事后与回执 ref 比对，不在回调内断言——回调先于回执发生） */
    const warmed: ImageRef[] = [];
    /** 调用序记录：断言「预热先于回执」这一时序契约 */
    const order: string[] = [];

    await ingestImage(
      dir,
      msg,
      (r) => {
        order.push('post');
        results.push(r);
      },
      undefined,
      (ref) => {
        order.push('warm');
        warmed.push(ref);
      },
    );

    expect(results[0]!.status).toBe('ok');
    // 真值断言：预热者拿到的就是宿主复算的那份 ref（不是提案、不是残缺拷贝）
    expect(warmed[0]).toEqual(results[0]!.ref);
    expect(order).toEqual(['warm', 'post']);
  });

  it('ingestImage rejected/failed：不预热（坏字节没写盘、IO 失败没产物，无可缓存者）', async () => {
    const dir = makeTempDir('memora-ingest-');
    const warm: unknown[] = [];

    // 坏字节（嗅不出 magic）→ rejected
    await ingestImage(
      dir,
      {
        type: 'image_ingest',
        base64: Buffer.from('not an image').toString('base64'),
        name: 'x.png',
        mime: 'image/png',
        width: 1,
        height: 1,
        sha256: 'cafebabe',
      },
      () => {},
      undefined,
      (ref) => warm.push(ref),
    );
    // IO 故障（工作区根本身是个文件：<root>/blocker/.memora/... 必 ENOTDIR）→ failed
    const root = makeTempDir('memora-ingest-');
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    await ingestImage(
      blocker,
      ingestMsg(pngBytes(4, 4)),
      () => {},
      undefined,
      (ref) => warm.push(ref),
    );

    expect(warm).toEqual([]);
  });

  it('ingestDiskFile ok：warmCache 收到真值 ref 且先于回执；rejected 不预热（与粘贴路径同一判据）', async () => {
    const root = makeTempDir('memora-pick-');
    const bytes = pngBytes(4, 4);
    const staged = join(root, 'photo.png');
    writeFileSync(staged, bytes);
    const results: PickedResult[] = [];
    const warmed: ImageRef[] = [];
    const order: string[] = [];

    await ingestDiskFile(
      root,
      staged,
      (r) => {
        order.push('post');
        results.push(r);
      },
      undefined,
      (ref) => {
        order.push('warm');
        warmed.push(ref);
      },
    );

    expect(results[0]!.status).toBe('ok');
    expect(warmed[0]).toEqual(results[0]!.ref);
    expect(order).toEqual(['warm', 'post']);

    // rejected：坏字节没写盘，不预热
    const warm2: unknown[] = [];
    const fake = join(root, 'fake.png');
    writeFileSync(fake, Buffer.from('plain text'));
    await ingestDiskFile(
      root,
      fake,
      () => {},
      undefined,
      (ref) => warm2.push(ref),
    );
    expect(warm2).toEqual([]);
  });
});
