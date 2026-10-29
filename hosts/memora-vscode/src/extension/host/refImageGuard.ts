/**
 * 「添加到对话」入口的图片识别（方案 §4.1 · G2）
 *
 * ## 为什么拦
 * 「添加到对话」的契约是**只挂路径与形态，内容由模型按需 `read_file` 读**。
 * 而内核 `read_file` 只按 `utf-8` 读、无二进制分支（方案 F18）⇒ 图片进去必然被解码
 * 损坏，且**不报错**。静默失败是最坏的失败形态：用户看到引用 chip 以为成了，模型那边
 * 拿到一堆乱码。故此处拦下并**给出路**，而不是挂一条注定读错的指针。
 *
 * ## 为什么单独成文件
 * 与 `imagePick.ts` 同一范式：零 vscode 依赖、纯函数，vitest 可直接断言，
 * 不需要宿主替身。命令层（`addToChat`）只负责读盘与提示。
 *
 * ## 判据：扩展名预筛 + 字节嗅探
 * 与 `imagePick.ts` 同一口径——**扩展名只是预筛，真伪由 `sniffImageMime` 说了算**。
 * 预筛存在的**唯一理由是省读盘开销**（只对疑似图片读文件头）；只用扩展名判会同时
 * 漏（`x.bin` 实为 png）与误（`x.png` 实为文本），两者都由嗅探兜住。
 *
 * ## 读不到的处置：放行
 * 读盘失败 ⇒ 按「非图片」放行，沿用既有行为。**不因一次读失败新增一条拒挂路径**——
 * 那会把「读盘抖动」变成「用户加不了文件」，比漏拦更坏。
 */
import { sniffImageMime } from '../../shared/imageValidation.js';
import { hasInboundImageExtension } from './imageExts.js';

/**
 * 「添加到对话」的目标是不是图片（真图才拦）
 *
 * @param fileName 目标文件名（只取扩展名做预筛，不参与真伪判定）
 * @param head 文件头部字节；预筛未命中时可为 `undefined`（直接返回 false）。
 *   嗅探门槛为 12 字节（最短合法格式 = WebP 签名），更长的片段不影响判定。
 * @returns true ⇒ 应走图片通道，**不应**挂为文件引用
 */
export function isRefTargetImage(fileName: string, head: Uint8Array | undefined): boolean {
  if (!hasInboundImageExtension(fileName)) return false;
  return head ? sniffImageMime(head) !== null : false;
}
