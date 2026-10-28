import { describe, it, expect } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIMES,
  parseImageSize,
  resolveImageName,
  sniffImageMime,
  validateImageCandidate,
  verifyBase64RoundTrip,
  type ImageMime,
} from '../imageValidation.js';
// G3 限额（需内核 imageTokens 换算）已按消费侧切到独立文件：本测试跑在 node 环境可引，
// 但 webview 采集链不可引——拆分理由见 imageTokenBudget.ts 文件头
import { checkImageTokenBudget } from '../imageTokenBudget.js';

/**
 * 本文件刻意**全部使用真实格式头**（逐字节拼增长/-WEBP 分三种子型 / JPEG 带陷阱段），
 * 而不是 `new Uint8Array([1,2,3])` 式的假数据：假数据对真实形态零覆盖，
 * 偏移错一位、字节序反了照样全绿（这是本项目变异验证的既定纪律）。
 */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[11] = 13; // IHDR chunk length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  b[19] = w & 0xff;
  b[18] = (w >> 8) & 0xff;
  b[17] = (w >> 16) & 0xff;
  b[16] = (w >> 24) & 0xff;
  b[23] = h & 0xff;
  b[22] = (h >> 8) & 0xff;
  b[21] = (h >> 16) & 0xff;
  b[20] = (h >> 24) & 0xff;
  return b;
}

/** JPEG：SOI → APP0 → DQT → **DHT（陷阱段）** → SOF0 */
function jpegWithDht(w: number, h: number): Uint8Array {
  const b: number[] = [];
  b.push(0xff, 0xd8); // SOI
  b.push(0xff, 0xe0, 0x00, 0x10); // APP0, len 16
  for (let i = 0; i < 14; i += 1) b.push(0x00);
  b.push(0xff, 0xdb, 0x00, 0x0f); // DQT, len 15
  for (let i = 0; i < 13; i += 1) b.push(0x00);
  b.push(0xff, 0xc4, 0x00, 0x0f); // DHT, len 15 —— 标记为 C4，必须与 SOF 区分
  for (let i = 0; i < 13; i += 1) b.push(0x00);
  b.push(0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff);
  for (let i = 0; i < 10; i += 1) b.push(0x00);
  return new Uint8Array(b);
}

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  b.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  b.set(
    [...kind].map((c) => c.charCodeAt(0)),
    12,
  );
  if (kind === 'VP8 ') {
    b[26] = w & 0xff;
    b[27] = (w >> 8) & 0xff;
    b[28] = h & 0xff;
    b[29] = (h >> 8) & 0xff;
  } else if (kind === 'VP8L') {
    // 低 14 位 = 宽 − 1，次 14 位 = 高 − 1
    const bits = (w - 1) | ((h - 1) << 14);
    b[21] = bits & 0xff;
    b[22] = (bits >> 8) & 0xff;
    b[23] = (bits >> 16) & 0xff;
    b[24] = (bits >> 24) & 0xff;
  } else {
    // 三个字节画布宽高 **减一** 后小端存放
    const cw = w - 1;
    const ch = h - 1;
    b[24] = cw & 0xff;
    b[25] = (cw >> 8) & 0xff;
    b[26] = (cw >> 16) & 0xff;
    b[27] = ch & 0xff;
    b[28] = (ch >> 8) & 0xff;
    b[29] = (ch >> 16) & 0xff;
  }
  return b;
}

function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // 'GIF89a'
  b[6] = w & 0xff;
  b[7] = (w >> 8) & 0xff;
  b[8] = h & 0xff;
  b[9] = (h >> 8) & 0xff;
  return b;
}

describe('第 3 步 · magic bytes 嗅探（不信扩展名、不信 File.type）', () => {
  it('四种受支持格式各得其所', () => {
    expect(sniffImageMime(png(640, 480))).toBe('image/png');
    expect(sniffImageMime(jpegWithDht(640, 480))).toBe('image/jpeg');
    expect(sniffImageMime(webp('VP8 ', 640, 480))).toBe('image/webp');
    expect(sniffImageMime(gif(640, 480))).toBe('image/gif');
  });

  it('扩展名伪装：内文是 PNG 却叫 .jpg ⇒ 以实际为准（判出不叫冒充者的那个）', () => {
    // 反过来更重要：SVG 文本顶着 .png 后缀必须被拒，否则会把脚本/矢量一路放行
    expect(
      sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')),
    ).toBe(null);
    expect(sniffImageMime(new TextEncoder().encode('这不是图片，只是一段中文文本'))).toBe(null);
  });

  it('截断到不足最小签名长度 ⇒ null（不是「猜一个」）', () => {
    expect(sniffImageMime(new Uint8Array(0))).toBe(null);
    expect(sniffImageMime(new Uint8Array(11))).toBe(null);
    // WebP 判别要看第 8–11 字节，只拼出 'RIFF' 前缀不算
    const half = new Uint8Array(12);
    half.set([0x52, 0x49, 0x46, 0x46], 0);
    expect(sniffImageMime(half)).toBe(null);
  });

  it('受支持清单与 §6.12 表口径一致（四个，含 gif）', () => {
    expect(SUPPORTED_IMAGE_MIMES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  });
});

describe('第 6 步 · 像素尺寸手写解析（第 NaN 污染的根）', () => {
  it('PNG：IHDR 大端宽高', () => {
    // 宽高不相等是刻意的——对调字节序或偏移错位都会立刻显现
    expect(parseImageSize(png(1024, 768), 'image/png')).toEqual({ width: 1024, height: 768 });
  });

  it('JPEG：**必须跳过 DHT(C4) 段**，不被其长度字段误导', () => {
    expect(parseImageSize(jpegWithDht(800, 600), 'image/jpeg')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('WebP 三子型：VP8 / VP8L / VP8X 各自偏移与减一规则', () => {
    expect(parseImageSize(webp('VP8 ', 320, 240), 'image/webp')).toEqual({
      width: 320,
      height: 240,
    });
    expect(parseImageSize(webp('VP8L', 333, 111), 'image/webp')).toEqual({
      width: 333,
      height: 111,
    });
    expect(parseImageSize(webp('VP8X', 2000, 1000), 'image/webp')).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  it('GIF：第 6–9 字节小端宽高', () => {
    expect(parseImageSize(gif(100, 200), 'image/gif')).toEqual({ width: 100, height: 200 });
  });

  it('头部被截断 ⇒ null，而不是返回 0（0 会让 token 估算低估、NaN 会让比较失效）', () => {
    expect(parseImageSize(png(10, 10).slice(0, 20), 'image/png')).toBe(null);
    expect(parseImageSize(new Uint8Array(jpegWithDht(4, 4)).slice(0, 6), 'image/jpeg')).toBe(null);
    expect(parseImageSize(gif(10, 10).slice(0, 8), 'image/gif')).toBe(null);
  });

  it('宽高为 0 的畸形图 ⇒ null（不产出会把估算压成 0 的合法尺寸）', () => {
    expect(parseImageSize(png(0, 0), 'image/png')).toBe(null);
    expect(parseImageSize(gif(0, 0), 'image/gif')).toBe(null);
  });

  it('WebP 未知子型（fourCC 不是三种之一）⇒ null', () => {
    const b = webp('VP8 ', 10, 10);
    b.set([0x41, 0x42, 0x43, 0x44], 12); // 伪 fourCC
    expect(parseImageSize(b, 'image/webp')).toBe(null);
  });
});

describe('第 5 步 · base64 往返长度校验（不解码，纯算术）', () => {
  const b64 = (n: number): string => 'A'.repeat(Math.ceil(n / 3) * 4);

  it('长度匹配 ⇒ true', () => {
    // 3 字节 → 4 字符（无 padding）；1 字节 → 4 字符（含 2 个 '='）
    expect(verifyBase64RoundTrip(3, 'AAAA')).toBe(true);
    expect(verifyBase64RoundTrip(1, 'AQ==')).toBe(true);
    expect(verifyBase64RoundTrip(2, 'AQI=')).toBe(true);
    expect(verifyBase64RoundTrip(120, b64(120))).toBe(true);
  });

  it('**截断** ⇒ false（正是该步唯一真正要抓的场景）', () => {
    expect(verifyBase64RoundTrip(120, b64(120).slice(0, -4))).toBe(false);
    expect(verifyBase64RoundTrip(121, b64(120))).toBe(false);
  });

  it('非法字符（含 URL-safe 的 -/_、中文） ⇒ false', () => {
    expect(verifyBase64RoundTrip(3, 'AA-A')).toBe(false);
    expect(verifyBase64RoundTrip(3, 'AA_A')).toBe(false);
    expect(verifyBase64RoundTrip(3, 'AA图A')).toBe(false);
  });

  it('padding 不合法（长度非 4 的倍数 / padding 在中间）⇒ false', () => {
    expect(verifyBase64RoundTrip(3, 'AAAAA')).toBe(false);
    expect(verifyBase64RoundTrip(3, 'A=AA')).toBe(false);
    expect(verifyBase64RoundTrip(3, 'AA===A')).toBe(false);
  });

  it('空串 ⇒ false', () => {
    expect(verifyBase64RoundTrip(0, '')).toBe(false);
  });
});

describe('六步链主入口 · 逐步失败针对下一步', () => {
  const sha = 'abcdef1234567890';

  it('第 1 步：空字节 ⇒ step 1', () => {
    const r = validateImageCandidate(new Uint8Array(0), sha);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.stage).toBe(1);
  });

  it('第 2 步：超过 5 MiB ⇒ step 2（边界内放行、边界外拒）', () => {
    const head = png(16, 16);
    const atLimit = new Uint8Array(MAX_IMAGE_BYTES);
    atLimit.set(head, 0);
    expect(validateImageCandidate(atLimit, sha).ok).toBe(true);
    const overLimit = new Uint8Array(MAX_IMAGE_BYTES + 1);
    overLimit.set(head, 0);
    const r = validateImageCandidate(overLimit, sha);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.stage).toBe(2);
  });

  it('第 3 步：非图片（SVG）⇒ step 3', () => {
    const r = validateImageCandidate(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">x'),
      sha,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.stage).toBe(3);
  });

  it('第 4 步：声明与实际不符 ⇒ step 4；声明缺失或一致 ⇒ 放行', () => {
    const bytes = png(20, 20);
    expect(validateImageCandidate(bytes, sha, 'image/jpeg').ok).toBe(false);
    expect(validateImageCandidate(bytes, sha, 'image/jpeg').ok === false).toBe(true);
    expect(validateImageCandidate(bytes, sha, '').ok).toBe(true);
    expect(validateImageCandidate(bytes, sha, undefined).ok).toBe(true);
    expect(validateImageCandidate(bytes, sha, 'image/png').ok).toBe(true);
  });

  it('第 6 步：尺寸解不出 ⇒ step 6（区别于格式不认：这里是认识了但读不出）', () => {
    const truncatedPng = png(30, 30).slice(0, 20);
    const r = validateImageCandidate(truncatedPng, sha);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.stage).toBe(6);
  });

  it('全通过 ⇒ 产出四值与最终名（mime 来自嗅探，不信声明）', () => {
    const r = validateImageCandidate(png(640, 480), sha, 'image/png', '截图.png');
    expect(r).toEqual({
      ok: true,
      mime: 'image/png',
      width: 640,
      height: 480,
      name: '截图.png',
    });
  });

  it('失败原因均带可读 message（**不静默丢弃**的前提：每条拒绝都要能直接进 UI）', () => {
    const cases: Array<[Uint8Array, string | undefined]> = [
      [new Uint8Array(0), undefined],
      [new Uint8Array(MAX_IMAGE_BYTES + 1), undefined],
      [new TextEncoder().encode('<svg'), undefined],
      [png(10, 10), 'image/jpeg'],
      [png(10, 10).slice(0, 20), undefined],
    ];
    for (const [bytes, declared] of cases) {
      const r = validateImageCandidate(bytes, sha, declared);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

describe('D29 · ImageRef.name 唯一生产点', () => {
  it('有声明名 ⇒ 原样使用', () => {
    expect(resolveImageName('a.png', 'abcdef1234567890')).toBe('a.png');
  });

  it('无名 / 空 / 纯空白 ⇒ 按 sha256 前 6 位兜底（缺失 name 会在 UI 与缺陷文案里落成 undefined）', () => {
    expect(resolveImageName(undefined, 'abcdef1234567890')).toBe('粘贴图片-abcdef');
    expect(resolveImageName('', 'abcdef1234567890')).toBe('粘贴图片-abcdef');
    expect(resolveImageName('   ', 'abcdef1234567890')).toBe('粘贴图片-abcdef');
  });

  it('真实平台值 `image.png` 不做特判 ⇒ 原样返回（虚拟名剔除是**入口**职责）', () => {
    // 为什么要钉这条：Chromium 给剪贴板位图合成的 name 就是 `image.png`，而它是**非空**的
    // ⇒ 本函数按「非空即原样用」走，兜底分支在粘贴路径恒不执行（IMG-4 实证：兜底曾是死码）。
    // 判据分层：#1 本函数只回答「声明值能否当名字用」；#2 「这个声明值可不可信」由入口判
    // （`imageCapture` 的粘贴路径不予采信）。若在此处加黑名单，会连带误伤真有名为
    // `image.png` 的拖入文件，并把「哪些名字算虚拟名」变成一份永远不全的清单。
    expect(resolveImageName('image.png', 'abcdef1234567890')).toBe('image.png');
  });
});

describe('G3 · 入口限额第四维（图片 token ≤ 窗口 25%）', () => {
  it('未超限 ⇒ ok，并回报实际占用的合计 token', () => {
    const r = checkImageTokenBudget({
      sizes: [{ width: 1024, height: 1024 }],
      contextWindow: 128_000,
    });
    expect(r.ok).toBe(true);
    expect(r.totalTokens).toBeGreaterThan(0);
    expect(r.limit).toBe(32_000);
  });

  it('超限 ⇒ 拒绝且文案带**具体数字**（用户据此决定减几张）', () => {
    // 8k 小窗口 × 25% = 2000 token 上限。注意：单图换算被内核上界 1568 钳住，
    // 所以**必须有两张以上**才可能爆——这正是上界存在的意义（防单图把估算带飞），
    // 也说明本维判据只能按「合计」而不是按单张峰值。
    const k4 = { width: 3840, height: 2160 };
    const r = checkImageTokenBudget({ sizes: [k4, k4], contextWindow: 8_000 });
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(2_000);
    expect(r.totalTokens).toBeGreaterThan(2_000);
    expect(r.message).toContain(String(r.totalTokens));
    expect(r.message).toContain('2000');
  });

  it('多张累加后才爆（单张不爆 ⇒ 必须按合计判，不能只判单张）', () => {
    const one = { width: 1024, height: 1024 };
    const sizes = [one, one, one, one];
    expect(checkImageTokenBudget({ sizes, contextWindow: 128_000 }).ok).toBe(true);
    // 缩到极小窗口，四张合计才超限 ⇒ 判据必须是合计而非单张峰值
    expect(checkImageTokenBudget({ sizes, contextWindow: 300 }).ok).toBe(false);
  });

  it('contextWindow 为 0 / undefined（= 不限，与内核 tokenBudget 口径一致）⇒ 不做限制', () => {
    expect(
      checkImageTokenBudget({ sizes: [{ width: 3840, height: 2160 }], contextWindow: 0 }).ok,
    ).toBe(true);
    expect(
      checkImageTokenBudget({ sizes: [{ width: 3840, height: 2160 }], contextWindow: undefined })
        .ok,
    ).toBe(true);
  });

  it('超极大图 ⇒ 换算被上界钳住（不因单图把限额判据带飞）', () => {
    // 单图上界是内核常量 1568；此处验证的是「宿主复用的是内核那一份换算」
    const r = checkImageTokenBudget({
      sizes: [{ width: 100_000, height: 100_000 }],
      contextWindow: 128_000,
    });
    expect(r.totalTokens).toBe(1568);
  });

  it('空列表 ⇒ 零占用、放行', () => {
    const r = checkImageTokenBudget({ sizes: [], contextWindow: 8_000 });
    expect(r.ok).toBe(true);
    expect(r.totalTokens).toBe(0);
  });
});

describe('四 MIME 全链路回归（一条管线走完六步，防单测各自为政）', () => {
  const cases: Array<[ImageMime, Uint8Array, number, number]> = [
    ['image/png', png(1920, 1080), 1920, 1080],
    ['image/jpeg', jpegWithDht(1280, 720), 1280, 720],
    ['image/webp', webp('VP8X', 800, 600), 800, 600],
    ['image/gif', gif(320, 240), 320, 240],
  ];
  it.each(cases)('%s → sniff + size + validate 三者口径一致', (mime, bytes, w, h) => {
    expect(sniffImageMime(bytes)).toBe(mime);
    expect(parseImageSize(bytes, mime)).toEqual({ width: w, height: h });
    expect(validateImageCandidate(bytes, 'deadbeef', mime, `x.${mime.split('/')[1]}`)).toEqual({
      ok: true,
      mime,
      width: w,
      height: h,
      name: `x.${mime.split('/')[1]}`,
    });
  });
});
