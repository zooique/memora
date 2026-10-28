/**
 * 图片字节缓存（`ImageCache`）单元测试
 *
 * 范式同 `imageIngest.test.ts`：**真临时目录**验证「预读 → resolver 同步命中」闭环，
 * 不 mock fs——本模块的全部价值就是「真的把已落盘的字节读回来」，mock 掉 fs 等于
 * 把被测行为一起 mock 掉（扩展名推导、长度校验都成了空断言）。
 *
 * 覆盖方案 §5.4.1 的四条判据：
 *   1. 只预读窗口内（`LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS`，与内核图片衰减同源）；
 *   2. LRU 封顶（条目数 / 总字节，D25）；
 *   3. 预读失败不阻断（缺文件 / 长度不符 / 未知 mime / loadView 抛错）；
 *   4. 不改内核契约（`resolver` 同步纯查表，未命中返回 `null`）。
 * 另含 D20 三值交叉校验（sha 键 + mime + bytes）的**消费侧**一段。
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ImageRef, ISessionViewLoader, Round, SessionView } from '@zooique/memora';
import { LOOP_CONSTANTS } from '@zooique/memora';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';
import type { ImageMime } from '../../../shared/imageValidation.js';
import { resolveAttachmentFilePath, resolveAttachmentsDir } from '../projectDataDir.js';
import { ImageCache } from '../imageCache.js';

/**
 * 造一段确定性的「伪图片」字节
 *
 * 本模块**不嗅探图片格式**（那在校验链 / `imageIngest` 一侧），只比「文件名 / 扩展名 /
 * 长度」，故字节内容只需互不相同即可，不需要合法 PNG 头。
 */
function fakeBytes(tag: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(tag.length);
  for (let i = 0; i < tag.length; i++) bytes[i] = tag.charCodeAt(i) & 0xff;
  return bytes;
}

/** 构造一个 `ImageRef`：sha256 由真实字节算出（与生产侧同源），bytes = 实际长度 */
function refOf(bytes: Uint8Array, mime: ImageMime = 'image/png'): ImageRef {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime,
    width: 1,
    height: 1,
    bytes: bytes.length,
    name: 'shot.png',
  };
}

/**
 * 把字节写到生产同款的落盘位置：`<根>/.memora/attachments/{sha256}.{ext}`
 *
 * 这里断言点在于「写盘与读盘共用同一份路径推导」——两侧任一另写一份扩展名映射，
 * 本用例就会命中不了（写出的文件名读不回来）。
 *
 * @param mime 走 `ImageMime` 入参重载（返回 `string`）——用例只落盘受支持的类型，
 *   未知 mime 的用例刻意不落盘（那条路径在 `resolveAttachmentFilePath` 就返回 undefined）
 */
function writeAttachment(
  projectPath: string,
  ref: ImageRef,
  bytes: Uint8Array,
  mime: ImageMime = 'image/png',
): void {
  mkdirSync(resolveAttachmentsDir(projectPath), { recursive: true });
  writeFileSync(resolveAttachmentFilePath(projectPath, ref.sha256, mime), bytes);
}

/** 构造一条只关心「user 附件」的 Round（预读只消费 `userMessage.attachments`，其余字段给最小值） */
function roundWith(id: string, attachments: ImageRef[]): Round {
  return {
    id,
    userMessage: { id: `${id}-user`, role: 'user', content: '[图片]', timestamp: 't', attachments },
    status: 'complete',
    createdAt: 't',
    refCount: 1,
  };
}

/** 会话视图加载器替身：只实现 `loadView`（预读只依赖这一个方法），其余字段丢弃 */
function loaderOf(rounds: Round[]): Pick<ISessionViewLoader, 'loadView'> {
  return { loadView: () => ({ rounds }) as unknown as SessionView };
}

describe('ImageCache — 预读 → resolver 命中', () => {
  it('预读后 resolver 同步返回 data URL，且 base64 解码回原字节', () => {
    const dir = makeTempDir('memora-imgcache-');
    const bytes = fakeBytes('hit-payload');
    const ref = refOf(bytes);
    writeAttachment(dir, ref, bytes);
    const cache = new ImageCache();

    cache.preload(ref, dir);

    const resolved = cache.resolver(ref);
    expect(resolved).not.toBeNull();
    // 形态必须是模型可取形态（data URL），不是 webview 资源地址——两类 URI 契约不同
    const url = (resolved as { url: string }).url;
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const encoded = url.slice('data:image/png;base64,'.length);
    expect(Buffer.from(encoded, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });

  it('未预读 → 返回 null（不凭空造 URL，交给内核降级占位）', () => {
    const cache = new ImageCache();
    expect(cache.resolver(refOf(fakeBytes('never-preloaded')))).toBeNull();
  });

  it('同一 ref 重复预读不重复计字节（幂等，不把自己挤出字节闸）', () => {
    const dir = makeTempDir('memora-imgcache-');
    const bytes = fakeBytes('idempotent');
    const ref = refOf(bytes);
    writeAttachment(dir, ref, bytes);
    // 字节闸恰好等于单条大小：若重复预读误加 totalBytes，唯一一条会被自己淘汰掉
    const cache = new ImageCache({ maxEntries: 32, maxTotalBytes: bytes.length });

    cache.preload(ref, dir);
    cache.preload(ref, dir);

    expect(cache.resolver(ref)).not.toBeNull();
  });
});

describe('ImageCache — D20 三值交叉校验（消费侧）', () => {
  it('同 sha 但 mime 不符 → 视为未命中（宁可降级，不可发错图）', () => {
    const dir = makeTempDir('memora-imgcache-');
    const bytes = fakeBytes('mime-mismatch');
    const ref = refOf(bytes);
    writeAttachment(dir, ref, bytes);
    const cache = new ImageCache();
    cache.preload(ref, dir);

    expect(cache.resolver({ ...ref, mime: 'image/jpeg' })).toBeNull();
  });

  it('同 sha 但 bytes 不符（历史里长度被改过）→ 视为未命中', () => {
    const dir = makeTempDir('memora-imgcache-');
    const bytes = fakeBytes('bytes-mismatch');
    const ref = refOf(bytes);
    writeAttachment(dir, ref, bytes);
    const cache = new ImageCache();
    cache.preload(ref, dir);

    expect(cache.resolver({ ...ref, bytes: ref.bytes + 1 })).toBeNull();
  });
});

describe('ImageCache — 预读失败不阻断（判据 3）', () => {
  it('附件文件不存在（被用户删掉）→ 跳过该条，不抛错', () => {
    const dir = makeTempDir('memora-imgcache-');
    const ref = refOf(fakeBytes('file-missing'));
    const cache = new ImageCache();

    expect(() => cache.preload(ref, dir)).not.toThrow();
    expect(cache.resolver(ref)).toBeNull();
  });

  it('磁盘长度与 ref.bytes 不符（文件被截断/替换）→ 不缓存', () => {
    const dir = makeTempDir('memora-imgcache-');
    const original = fakeBytes('truncated-original');
    const ref = refOf(original);
    // 用同名文件覆盖成更短的内容：扩展名与 sha 都在，只有长度对不上
    writeAttachment(dir, ref, original.subarray(0, original.length - 3));
    const cache = new ImageCache();

    cache.preload(ref, dir);
    expect(cache.resolver(ref)).toBeNull();
  });

  it('未知 mime（旧数据）→ 无对应扩展名，跳过且不抛错', () => {
    const dir = makeTempDir('memora-imgcache-');
    const bytes = fakeBytes('unknown-mime');
    const ref = refOf(bytes);
    // 只写 png 文件，却拿 bmp 的 ref 来预读：路径推导直接返回 undefined
    writeAttachment(dir, ref, bytes);
    const cache = new ImageCache();

    cache.preload({ ...ref, mime: 'image/bmp' }, dir);
    expect(cache.resolver({ ...ref, mime: 'image/bmp' })).toBeNull();
  });

  it('loadView 抛错（会话不存在）→ 静默返回，不打断会话加载', () => {
    const dir = makeTempDir('memora-imgcache-');
    const cache = new ImageCache();
    const throwingLoader = {
      loadView: () => {
        throw new Error('session not found');
      },
    } as unknown as Pick<ISessionViewLoader, 'loadView'>;

    expect(() => cache.preloadSession(throwingLoader, dir, '2026-10-28-none')).not.toThrow();
  });

  it('未注入 loader（legacy 无 viewLoader）→ 静默返回', () => {
    const dir = makeTempDir('memora-imgcache-');
    const cache = new ImageCache();
    expect(() => cache.preloadSession(undefined, dir, '2026-10-28-s1')).not.toThrow();
  });
});

describe('ImageCache — 窗口切片（判据 1）', () => {
  it('只预读最近 RETAIN_IMAGE_ROUNDS 轮，窗口外的 ref 不命中', () => {
    const dir = makeTempDir('memora-imgcache-');
    // 用常量而非字面量 4：内核调窗口，本用例跟着走（硬编码会让两边静默分叉）
    const retain = LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS;
    const refs: ImageRef[] = [];
    const rounds: Round[] = [];
    for (let i = 0; i < retain + 2; i++) {
      const bytes = fakeBytes(`round-${i}`);
      const ref = refOf(bytes);
      writeAttachment(dir, ref, bytes);
      refs.push(ref);
      rounds.push(roundWith(`round-${i}`, [ref]));
    }
    const cache = new ImageCache();

    cache.preloadSession(loaderOf(rounds), dir, '2026-10-28-s1');

    // 窗口外（前 2 轮）：内核本就不会序列化它们的图，预读它们纯占内存
    expect(cache.resolver(refs[0]!)).toBeNull();
    expect(cache.resolver(refs[1]!)).toBeNull();
    // 窗口内（末 retain 轮）：全部命中
    for (const ref of refs.slice(2)) expect(cache.resolver(ref)).not.toBeNull();
  });

  it('历史轮数少于窗口 → 全部都在窗口内，全部预读', () => {
    const dir = makeTempDir('memora-imgcache-');
    const bytes = fakeBytes('short-history');
    const ref = refOf(bytes);
    writeAttachment(dir, ref, bytes);
    const cache = new ImageCache();

    cache.preloadSession(loaderOf([roundWith('round-1', [ref])]), dir, '2026-10-28-s1');

    expect(cache.resolver(ref)).not.toBeNull();
  });

  it('无附件的轮次 → 跳过（不产生任何缓存条目）', () => {
    const dir = makeTempDir('memora-imgcache-');
    const cache = new ImageCache();
    const rounds: Round[] = [roundWith('round-1', [])];

    expect(() => cache.preloadSession(loaderOf(rounds), dir, '2026-10-28-s1')).not.toThrow();
  });
});

describe('ImageCache — LRU 封顶（判据 2 / D25）', () => {
  it('条目数超上限 → 淘汰最久未用', () => {
    const dir = makeTempDir('memora-imgcache-');
    const refs = ['lru-a', 'lru-b', 'lru-c'].map((tag) => {
      const bytes = fakeBytes(tag);
      const ref = refOf(bytes);
      writeAttachment(dir, ref, bytes);
      return ref;
    });
    const cache = new ImageCache({ maxEntries: 2, maxTotalBytes: 1024 * 1024 });

    cache.preload(refs[0]!, dir);
    cache.preload(refs[1]!, dir);
    // 命中 A 刷新位次：此时队首变成 B
    expect(cache.resolver(refs[0]!)).not.toBeNull();
    cache.preload(refs[2]!, dir);

    expect(cache.resolver(refs[1]!)).toBeNull(); // 最久未用者被淘汰
    expect(cache.resolver(refs[0]!)).not.toBeNull();
    expect(cache.resolver(refs[2]!)).not.toBeNull();
  });

  it('总字节超上限 → 淘汰直到回落到阈值内', () => {
    const dir = makeTempDir('memora-imgcache-');
    const first = fakeBytes('bytes-1st');
    const second = fakeBytes('bytes-2nd');
    const refFirst = refOf(first);
    const refSecond = refOf(second);
    writeAttachment(dir, refFirst, first);
    writeAttachment(dir, refSecond, second);
    // 字节闸只够放一条：第二条写入必须把第一条挤出去
    const cache = new ImageCache({ maxEntries: 32, maxTotalBytes: first.length });

    cache.preload(refFirst, dir);
    cache.preload(refSecond, dir);

    expect(cache.resolver(refFirst)).toBeNull();
    expect(cache.resolver(refSecond)).not.toBeNull();
  });
});
