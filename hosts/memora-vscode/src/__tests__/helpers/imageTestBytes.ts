/**
 * 图片类测试的字节夹具（宿主侧 node 环境共用，禁各测试文件自造第二份）。
 *
 * 与 `shared/imageValidation.test.ts` 的逐字节格式头夹具分家：那边测的是**嗅探公式
 * 本身**（陷阱段 / 三子型 / 端序都要覆盖），这边只需要「一份能通过校验链的最小合法图」，
 * 拿它驱动落盘 / 拾取链路。两边的严谨度各自匹配被测对象，勿互相攀比。
 */

/**
 * 构造最小合法 PNG（33 字节）。
 *
 * 返回类型写 `Uint8Array<ArrayBuffer>`：裸 `Uint8Array` 在 TS 5.7+ 会退化成
 * `ArrayBufferLike`，喂给 `Buffer.from` 之外的地方常被收窄报错（与 imageCapture 测试同约定）。
 */
export function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG 签名
  b.set([0, 0, 0, 13], 8); // IHDR 数据长度 = 13（大端）
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  b.set([(width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255], 16);
  b.set([(height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255], 20);
  return b;
}
