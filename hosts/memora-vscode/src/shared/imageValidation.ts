/**
 * 图片采集校验链（方案-图片输入-20261027 §6.12 六步 / D18–D20 / §6.7 / G3）
 *
 * 为什么放在 `shared/`：这是**唯一一份**实现。若按常规把「webview 侧采集」与
 * 「extension 侧落盘」各写一份嗅探 / 尺寸解析，就是同一套格式头公式的第二份拷贝——
 * 将来补新格式或修正偏移时必只改一侧而另一侧漂移。放 shared ⇒ 两侧共用同一批函数。
 *
 * 为什么全部是**纯函数**：零 IO、零三方依赖（符合 §6.8 零依赖约束——`sharp` / `image-size`
 * 都被否决过），入参 `Uint8Array` / `string`、出参值对象 ⇒ 可完整机测 + 可变异验证。
 * 写盘 / IPC / 哈希这类副作用不进本文件。
 *
 * 调用顺序（任一步失败即拒绝，给可见原因，**不静默丢弃**——见 §6.12 表头）：
 *   1 字节非空 → 2 字节 ≤ 5 MiB → 3 magic bytes 嗅探 mime → 4 与声明 mime 一致
 *   → 5 base64 往返长度一致 → 6 解析像素尺寸
 */
import { imageTokens } from '@zooique/memora';

/** 四种受支持格式的 MIME（顺序即嗅探顺序，勿改——它与下面的 sniff 分支一一对应） */
export const SUPPORTED_IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type ImageMime = (typeof SUPPORTED_IMAGE_MIMES)[number];

/** 入口单图字节上限（§6.12 第 2 步 / §6.7） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 单轮图片 token 上限 = 模型上下文窗口的比例（§6.7 第四维 / G3） */
export const IMAGE_TOKEN_WINDOW_RATIO = 0.25;

export interface ImageSize {
  width: number;
  height: number;
}

export type ImageRejectStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface ImageReject {
  ok: false;
  step: ImageRejectStep;
  /** 面向用户的可读原因（必须能直接进 UI，不含绝对路径） */
  message: string;
}

export interface ImageAccept {
  ok: true;
  mime: ImageMime;
  width: number;
  height: number;
  name: string;
}

export type ImageCheckResult = ImageAccept | ImageReject;

/** 读大端 uint32（PNG 宽高为 BE） */
function be32(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
}

/** 读小端 uint16（GIF / WebP 局段） */
function le16(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8)) >>> 0;
}

/** 读小端 uint24（WebP VP8X 画布宽高） */
function le24(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) >>> 0;
}

/** 读小端 uint32（WebP VP8L 位域） */
function le32(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}

/**
 * 第 3 步：magic bytes 嗅探真实格式。
 *
 * 为什么必须嗅探而不能信扩展名 / `File.type`：两者都是**外部可伪造的声明**，
 * 嗅探是唯一由我们产出的那一半事实（D19）。返回 null 表示不认识（含 SVG / 非图片）。
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < 12) {
    // 最短合法格式（GIF 头 6 字节 / WebP 签名 12 字节）：不足 12 字节只可能是截断或损坏。
    // GIF/WEBP 判别需要到第 12 字节，故此处统一门槛；PNG/JPEG 实际需更少字节但不单列分支。
    return null;
  }
  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG：FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // WebP：RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // GIF：GIF87a / GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  return null;
}

/**
 * 第 6 步：解析像素尺寸。四种格式**各自只读文件头几十字节**，不解码整图。
 *
 * 为什么必须做：`ImageRef.width/height` 是 token 计量（§5.9）与 alt 显示的**唯一来源**，
 * 而没有任何现成 API 能白给（零依赖约束）。若此处省掉，`width/height` 就是两个死字段，
 * token 估算退化成 0（低估 ⇒ 爆窗）或 NaN（比较恒 false ⇒ 静默失效），
 * 且**没有任何现有测试会红**（无附件路径不走这条分支）。
 */
export function parseImageSize(bytes: Uint8Array, mime: ImageMime): ImageSize | null {
  switch (mime) {
    case 'image/png': {
      // IHDR 宽高：第 16–19 字节宽、20–23 字节高（大端 uint32）
      if (bytes.length < 24) return null;
      const width = be32(bytes, 16);
      const height = be32(bytes, 20);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    case 'image/jpeg': {
      // 遍历 SOF0–SOF15 段；跳过非 0xFF 起始（数据损坏）直至找到 SOF
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        // 独立标记（无长度字段）：SOI / EOI / TEM / RSTn，直接步进到下一个标记
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        // SOF0–SOF15（C0–CF），排除 DHT(C4) / JPG(C8) / DAC(CC) 这三个不带尺寸的 Cf 类标记
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
          const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
          return width > 0 && height > 0 ? { width, height } : null;
        }
        // 其余段：读两字节长度并跳过（长度含自身两字节）
        const segLen = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
        if (segLen < 2) return null;
        offset += 2 + segLen;
      }
      return null;
    }
    case 'image/webp': {
      if (bytes.length < 30) return null;
      const fourCC = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
      if (fourCC === 'VP8 ') {
        // 有损：第 26/28 字节起各 2 字节小端，低 14 位是宽高
        const width = le16(bytes, 26) & 0x3fff;
        const height = le16(bytes, 28) & 0x3fff;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (fourCC === 'VP8L') {
        // 无损：第 21 字节起 32 位位域，低 14 位宽 −1、次 14 位高 −1
        const bits = le32(bytes, 21);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >>> 14) & 0x3fff) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (fourCC === 'VP8X') {
        // 扩展型：第 24/27 字节起各 3 字节小端画布宽高，实际像素需减一
        const width = le24(bytes, 24) + 1;
        const height = le24(bytes, 27) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      return null;
    }
    case 'image/gif': {
      // 逻辑屏宽高：第 6–7 字节宽、8–9 字节高（小端 uint16）
      if (bytes.length < 10) return null;
      const width = le16(bytes, 6);
      const height = le16(bytes, 8);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    default:
      return null;
  }
}

/**
 * 第 5 步：base64 **往返长度**校验——不解回字节，用纯算术反推原始长度。
 *
 * 为什么可以不算解码：base64 是固定比率编码，`去掉 padding 后的字符数 × 3 ÷ 4 取整`
 * 恒等于原始字节数。故「长度一致」这件事不需要 Buffer/atob，两侧环境都能跑。
 * 为什么必须有这一步（§6.12）：只校验长度挡不住非法字符、只校验字符挡不住截断，
 * **两个都做才算闭合**——跳过后症状是「偶尔发出的图在服务端变成半张」，极难复现。
 */
export function verifyBase64RoundTrip(originalByteLength: number, base64: string): boolean {
  if (base64.length === 0) return false;
  // ① 字符集 + padding：只可能结尾有 0–2 个 '='，其余必须是 base64 字母表
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return false;
  // ② 带 padding 的总长必须是 4 的倍数，否则不是合法 base64 分组
  if (base64.length % 4 !== 0) return false;
  const stripped = base64.replace(/=+$/, '');
  const decoded = Math.floor((stripped.length * 3) / 4);
  // ③ 长度必须等于原字节数（截断会在此暴露）
  return decoded === originalByteLength;
}

/**
 * `ImageRef.name` 的唯一生产点（D29）。
 *
 * 为什么无名时必须生成而不是留空：`name` 在 `ImageRef` 里是**必填**，而 UI 与缺陷态文案
 * 都要用；留空会在两处落成 undefined。取 sha256 前 6 位保证可定位到文件。
 */
export function resolveImageName(declaredName: string | undefined, sha256: string): string {
  const trimmed = declaredName?.trim();
  return trimmed && trimmed.length > 0
    ? trimmed
    : `粘贴图片-${sha256.slice(0, 6)}`;
}

function reject(step: ImageRejectStep, message: string): ImageReject {
  return { ok: false, step, message };
}

/**
 * 六步校验链的**主入口**（不含第 5 步——第 5 步要在拿到接收侧 base64 之后调
 * `verifyBase64RoundTrip`，见该函数的注释）。
 *
 * @param bytes 原始字节（webview 侧 `File` → `Uint8Array`）
 * @param declaredMime 外部声明的 MIME（浏览器 `File.type`；可能为空串 ⇒ 跳过第 4 步）
 * @param declaredName 用户可见的文件名（用于 D29 兜底命名）
 */
export function validateImageCandidate(
  bytes: Uint8Array,
  sha256: string,
  declaredMime?: string,
  declaredName?: string,
): ImageCheckResult {
  // 第 1 步：字节非空
  if (bytes.length === 0) return reject(1, '图片内容为空');

  // 第 2 步：单图字节上限
  if (bytes.length > MAX_IMAGE_BYTES) {
    return reject(
      2,
      `单张图片不能超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MiB`,
    );
  }

  // 第 3 步：嗅探真实格式
  const mime = sniffImageMime(bytes);
  if (!mime) return reject(3, '不支持的图片格式（仅支持 PNG / JPEG / WebP / GIF）');

  // 第 4 步：与声明一致（声明缺失时不判——`File.type` 为空是常见且合法的）
  if (declaredMime && declaredMime !== mime) {
    return reject(4, `文件格式与声明不符（声明 ${declaredMime}，实际 ${mime}）`);
  }

  // 第 6 步：像素尺寸（第 5 步由调用方在拿到 base64 后补）
  const size = parseImageSize(bytes, mime);
  if (!size) return reject(6, '无法解析图片尺寸，文件可能已损坏');

  return {
    ok: true,
    mime,
    width: size.width,
    height: size.height,
    name: resolveImageName(declaredName, sha256),
  };
}

export interface ImageTokenBudgetInput {
  /** 已通过校验的候选图（含宽高） */
  sizes: ReadonlyArray<ImageSize>;
  /** 该模型配置的上下文窗口 token 数（0 / undefined = 不限，与内核预算口径一致） */
  contextWindow: number | undefined;
}

export interface ImageTokenBudgetResult {
  ok: boolean;
  totalTokens: number;
  limit: number;
  message: string;
}

/**
 * G3 入口限额第四维：单轮图片 token 合计 ≤ 模型 `contextWindow` 的 25%。
 *
 * 为什么必须补这一维（§6.7 / G3）：张数 / 单图字节 / 总字节三个维度都**看不见** token ——
 * 一张 4K 图 ≈2125 token，5 张 ≈10.6k，而 `contextWindow` 可低到 8k ⇒ 这是唯一
 * 「真机上真会爆」的一条。换算必须走**内核单点** `imageTokens`，不得在此重写公式。
 *
 * `contextWindow` 为 0 / undefined（= 不限，与内核 tokenBudget 口径一致）时不做限制。
 */
export function checkImageTokenBudget(input: ImageTokenBudgetInput): ImageTokenBudgetResult {
  const tokens = input.sizes.map((s) => imageTokens(s));
  const totalTokens = tokens.reduce((a, b) => a + b, 0);
  const window = input.contextWindow ?? 0;
  if (window <= 0) {
    return { ok: true, totalTokens, limit: Number.POSITIVE_INFINITY, message: '' };
  }
  const limit = Math.floor(window * IMAGE_TOKEN_WINDOW_RATIO);
  return totalTokens > limit
    ? {
        ok: false,
        totalTokens,
        limit,
        message: `本轮图片约占 ${totalTokens} token，超过该模型上限 ${limit} token（${Math.round(
          IMAGE_TOKEN_WINDOW_RATIO * 100,
        )}% 窗口），请减少图片数量或换用更小的图`,
      }
    : { ok: true, totalTokens, limit, message: '' };
}
