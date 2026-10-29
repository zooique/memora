/**
 * 入站图片扩展名单点（IMG-9）
 *
 * fixture 全部是**逐字节拼的真实格式头**（沿用 `imageValidation` 的取向）：
 * 全 ASCII 假数据会让「真实形态」零覆盖。
 *
 * 本文件守着两条不变式——它们是「入站清单」这个单点不腐烂的唯一机械保障：
 * ① 出站写出的每个扩展名都 ∈ 入站集合（否则自己写出的文件选不回来）；
 * ② 入站集合里每个扩展名都有真实格式头能通过嗅探（否则预筛放行、嗅探判否
 *    ⇒ 图片被当文件引用挂上去，回到 G2 的静默失败）。
 */
import { describe, expect, it } from 'vitest';
import { EXT_BY_MIME } from '../projectDataDir.js';
import { INBOUND_IMAGE_EXTS, hasInboundImageExtension } from '../imageExts.js';
import { isRefTargetImage } from '../refImageGuard.js';

/** PNG：89 50 4E 47 0D 0A 1A 0A（IHDR 之前） */
function pngHead(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
}
/** JPEG：FF D8 FF E0（JFIF） */
function jpegHead(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
}
/** WebP：'RIFF' + size + 'WEBP' */
function webpHead(): Uint8Array {
  const b = new Uint8Array(12);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return b;
}
/** GIF89a */
function gifHead(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0]);
}

/**
 * 每个入站扩展名对应的**真实**格式头。
 *
 * 只登记「真有格式可嗅探」的扩展名：缺项即说明该扩展名只是被写进了清单、没有
 * 对应的嗅探能力——那正是「预筛放行、嗅探判否」的静默失败通道。
 */
const HEAD_BY_EXT: Record<string, Uint8Array> = {
  png: pngHead(),
  jpg: jpegHead(),
  jpeg: jpegHead(),
  webp: webpHead(),
  gif: gifHead(),
};

describe('imageExts · 预筛 hasInboundImageExtension', () => {
  it('四种受支持扩展名命中，大小写不敏感', () => {
    expect(hasInboundImageExtension('a.png')).toBe(true);
    expect(hasInboundImageExtension('a.jpg')).toBe(true);
    expect(hasInboundImageExtension('a.JPEG')).toBe(true);
    expect(hasInboundImageExtension('a.webp')).toBe(true);
    expect(hasInboundImageExtension('a.gif')).toBe(true);
  });

  it('非图片扩展名 / 无扩展名 / 目录名带点均不命中', () => {
    expect(hasInboundImageExtension('a.txt')).toBe(false);
    expect(hasInboundImageExtension('Makefile')).toBe(false);
    expect(hasInboundImageExtension('src')).toBe(false);
  });

  it('以点结尾（空扩展名）不命中 —— 不能把 "a." 当成隐藏格式', () => {
    expect(hasInboundImageExtension('a.')).toBe(false);
  });
});

describe('imageExts · 不变式① 出站写出的扩展名必须可被入站接受', () => {
  it('EXT_BY_MIME 的每个值都 ∈ INBOUND_IMAGE_EXTS（自写文件必须能再选回来）', () => {
    for (const ext of Object.values(EXT_BY_MIME)) {
      expect(INBOUND_IMAGE_EXTS).toContain(ext);
    }
  });
});

describe('imageExts · 不变式② 入站清单里每个扩展名都必须有可嗅探的真实格式', () => {
  it('逐个扩展名：真实格式头 ⇒ isRefTargetImage 为 true（预筛与嗅探同口）', () => {
    for (const ext of INBOUND_IMAGE_EXTS) {
      const head = HEAD_BY_EXT[ext];
      expect(head, `扩展名 ${ext} 已进清单但测试未登记真实格式头`).toBeDefined();
      expect(isRefTargetImage(`probe.${ext}`, head), `扩展名 ${ext} 预筛命中却嗅探否`).toBe(true);
    }
  });
});
