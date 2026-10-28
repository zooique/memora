/**
 * 「添加到对话」入口的图片识别（G2）
 *
 * fixture 全部是**逐字节拼的真实格式头**（沿用 `imageValidation` 的取向）：
 * 全 ASCII 假数据会让「真实形态」零覆盖——变异验证的前提是真形态被真断言咬住。
 */
import { describe, expect, it } from 'vitest';
import { hasImageExtension, isRefTargetImage } from '../refImageGuard.js';

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

describe('refImageGuard · 预筛 hasImageExtension', () => {
  it('四种受支持扩展名命中，大小写不敏感', () => {
    expect(hasImageExtension('a.png')).toBe(true);
    expect(hasImageExtension('a.jpg')).toBe(true);
    expect(hasImageExtension('a.JPEG')).toBe(true);
    expect(hasImageExtension('a.webp')).toBe(true);
    expect(hasImageExtension('a.gif')).toBe(true);
  });

  it('非图片扩展名 / 无扩展名 / 目录名带点均不命中', () => {
    expect(hasImageExtension('a.txt')).toBe(false);
    expect(hasImageExtension('Makefile')).toBe(false);
    expect(hasImageExtension('src')).toBe(false);
  });
});

describe('refImageGuard · 判定 isRefTargetImage', () => {
  it('四种真图各自的真实头 ⇒ 拦（true）', () => {
    expect(isRefTargetImage('a.png', pngHead())).toBe(true);
    expect(isRefTargetImage('a.jpg', jpegHead())).toBe(true);
    expect(isRefTargetImage('a.webp', webpHead())).toBe(true);
    expect(isRefTargetImage('a.gif', gifHead())).toBe(true);
  });

  it('扩展名骗人（.png 实为文本）⇒ 不拦（嗅探兜住误报）', () => {
    const text = new Uint8Array(Buffer.from('# 这是一段 markdown 正文', 'utf-8'));
    expect(isRefTargetImage('readme.png', text)).toBe(false);
  });

  it('扩展名不配（.bin 实为 png）⇒ 不拦 —— 预筛的已知漏网，如实登记不美化', () => {
    expect(isRefTargetImage('dump.bin', pngHead())).toBe(false);
  });

  it('读不到头（undefined）⇒ 不拦（不因读盘失败新增拒挂路径）', () => {
    expect(isRefTargetImage('a.png', undefined)).toBe(false);
  });

  it('头不足 12 字节 ⇒ 不拦（截断/损坏不判为图）', () => {
    expect(isRefTargetImage('a.png', pngHead().subarray(0, 8))).toBe(false);
  });

  it('空文件头（0 字节）⇒ 不拦', () => {
    expect(isRefTargetImage('a.png', new Uint8Array(0))).toBe(false);
  });
});
