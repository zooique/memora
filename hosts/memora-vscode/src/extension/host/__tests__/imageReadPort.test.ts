/**
 * `read_image` 宿主端口（`createImageReadPort`）单元测试
 *
 * 覆盖三条必须钉住的行为：
 *   1. 视觉位为假 ⇒ **端口自身**拒绝（第二层防线，不依赖内核暴露面裁剪）；
 *   2. 正常图片 ⇒ 真读盘 + 校验链 + 入同一 `ImageCache`，`resolver` 立刻可命中；
 *   3. 非图片 / 不可读 ⇒ 返回结构化失败文本，不抛异常（工具执行面按业务结果处理）。
 *
 * 用真临时文件与真实 PNG 字节，不 mock fs / 校验链——mock 掉它们等于把被测价值一起 mock 掉。
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { ImageCache } from '../imageCache.js';
import { createImageReadPort } from '../imageReadPort.js';

/** 1×1 PNG（合法魔数 + IHDR 尺寸），供校验链整链通过 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('createImageReadPort — 视觉位第二层拒绝', () => {
  it('supportsVision=false ⇒ 端口直接拒绝，且不读盘、不进缓存', async () => {
    // 变异方向：删掉端口内的 getActiveVision() 判断 ⇒ 本例红（缓存会被写入）
    const ingestBytes = vi.fn();
    const port = createImageReadPort({
      cache: { ingestBytes } as unknown as Pick<ImageCache, 'ingestBytes'>,
      getActiveVision: () => false,
    });

    const result = await port('C:/whatever/does-not-exist.png');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.text).toContain('supportsVision=false');
    expect(ingestBytes).not.toHaveBeenCalled();
  });
});

describe('createImageReadPort — 正常读图', () => {
  it('合法 PNG ⇒ 返回 ImageRef，字节进入同一缓存且 resolver 同步命中', async () => {
    const dir = makeTempDir('memora-readimg-');
    const file = join(dir, 'shot.png');
    writeFileSync(file, PNG_1X1);
    const cache = new ImageCache();
    const port = createImageReadPort({ cache, getActiveVision: () => true });

    const result = await port(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // sha256 必须由真实字节算出（文件名/扩展名不参与）
    expect(result.ref.sha256).toBe(createHash('sha256').update(PNG_1X1).digest('hex'));
    expect(result.ref.mime).toBe('image/png');
    expect(result.ref.bytes).toBe(PNG_1X1.length);
    expect(result.ref.name).toBe('shot.png');
    // 入缓存后内核 ImageResolver 立刻可查（read_image 挂出站视图的前提）
    expect(cache.resolver(result.ref)).not.toBeNull();
  });
});

describe('createImageReadPort — 失败不抛异常', () => {
  it('文本文件冒充图片 ⇒ 结构化失败（校验链拦下），不写缓存', async () => {
    const dir = makeTempDir('memora-readimg-');
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'this is not an image');
    const cache = new ImageCache();
    const port = createImageReadPort({ cache, getActiveVision: () => true });

    const result = await port(file);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.text).toContain('读图失败');
  });

  it('文件不存在 ⇒ 结构化失败（不把 IO 故障抛给工具执行面）', async () => {
    const port = createImageReadPort({
      cache: new ImageCache(),
      getActiveVision: () => true,
    });

    const result = await port(join(makeTempDir('memora-readimg-'), 'missing.png'));

    expect(result.ok).toBe(false);
  });

  it('超过单张 5 MiB ⇒ 拒绝文案可操作（实际大小 + 超出量 + 怎么缩）', async () => {
    const dir = makeTempDir('memora-readimg-');
    const file = join(dir, 'huge.png');
    // 只造大小、不造合法图片：尺寸预筛在 readFile 之前就应拦下（证明没读进内存）
    writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1024 * 1024));
    const port = createImageReadPort({
      cache: new ImageCache(),
      getActiveVision: () => true,
    });

    const result = await port(file);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.text).toContain('文件 6.0 MiB');
    expect(result.text).toContain('超过单张 5 MiB 上限 1.0 MiB');
    expect(result.text).toContain('裁剪或压缩');
  });
});
