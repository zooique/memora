/**
 * 图片按路径读取端口（内核 `read_image` 执行面的宿主实现）
 *
 * 职责：把「模型给出的绝对路径」变成内核可直接挂到出站视图的 `ImageRef`。
 *   - 读盘（不落副本：字节直接进 `ImageCache`，与粘贴/拾取路径共用同一消费链）；
 *   - 走与上传同一套校验链（`validateImageCandidate`：非空 / 字节上限 / 魔数嗅探 / 尺寸）；
 *   - **第二层能力拒绝**：内核暴露面已按视觉位裁剪，但端口不假设调用方守规矩。
 *
 * 边界：路径安全（白名单/黑名单/越界）由**内核**在调用端口前用
 * `resolveSafePath` + `guardPathOrThrow` 完成——宿主端口不重复实现，也不接受
 * 「相对路径」语义（内核传入的必须是已裁决过的绝对路径）。
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { ImageReadPort, ImageRef } from '@zooique/memora';
import { MAX_IMAGE_BYTES, validateImageCandidate } from '../../shared/imageValidation.js';
import { formatMiB } from '../../shared/imageTurnLimits.js';
import type { ImageCache } from './imageCache.js';

/** 端口构造依赖（最小化：只取真正需要的能力，便于单测给替身） */
export interface ImageReadPortDeps {
  /** 图片字节缓存单例（与粘贴/拾取路径同一实例） */
  cache: Pick<ImageCache, 'ingestBytes'>;
  /**
   * 当前激活 provider 的视觉能力位（同步读配置；fail-closed）。
   * 注意这是**配置侧**位，与内核「路由后 provider」的 supportsVision 是两个独立取值：
   * 内核负责「要不要暴露工具」，这里负责「端口自己也不放行」。
   */
  getActiveVision: () => boolean;
}

/**
 * 创建 `read_image` 端口。
 *
 * 返回值语义（与内核 `ImageReadResult` 一致）：
 *   - `{ ok: true, ref }`：成功，且字节已进缓存（内核 `ImageResolver` 可同步查到 URL）；
 *   - `{ ok: false, text }`：失败原因（直接作为工具结果文本回给模型，供其自愈）。
 *     失败**不抛异常**：工具执行面把「读不到图」当正常业务结果处理，不制造未捕获异常。
 */
export function createImageReadPort(deps: ImageReadPortDeps): ImageReadPort {
  return async (absolutePath: string) => {
    // 第二层拒绝：能力位为假时直接回绝（不发 IO、不进缓存）
    if (!deps.getActiveVision()) {
      return {
        ok: false,
        text:
          'read_image 已取消：当前模型未声明支持视觉输入（supportsVision=false）。' +
          '开启方式：命令面板运行「Memora: 配置大模型」→ 编辑当前模型服务 → 勾选「支持图片输入」。' +
          '请改用文字描述或让用户直接附图。',
      };
    }

    // 读前尺寸预筛（与 ingestDiskFile 同一 fail-closed 纪律）：超大文件不进 readFile，
    // 避免模型给出一个大文件路径就把 Extension Host 内存打满。stat 失败则跳过预筛，
    // 交给下方 readFile 统一报错（不把 IO 故障伪装成「不是图片」）。
    let sizeHint: number | undefined;
    try {
      sizeHint = (await stat(absolutePath)).size;
    } catch {
      sizeHint = undefined;
    }
    const maxMiB = Math.floor(MAX_IMAGE_BYTES / 1024 / 1024);
    if (sizeHint !== undefined && sizeHint > MAX_IMAGE_BYTES) {
      // 拒绝文案必须可操作：说清超了多少、怎么缩（内核不做本地缩放，见 read_image 决策注释）
      return {
        ok: false,
        text:
          `读图失败：文件 ${formatMiB(sizeHint)} MiB，超过单张 ${maxMiB} MiB 上限 ` +
          `${formatMiB(sizeHint - MAX_IMAGE_BYTES)} MiB，未读取。` +
          `请先裁剪或压缩到 ${maxMiB} MiB 以内（降低分辨率，或转成 JPEG / WebP）后重试。`,
      };
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (err) {
      return {
        ok: false,
        text: `读图失败：无法读取文件（${err instanceof Error ? err.message : String(err)}）。`,
      };
    }

    // sha256 由宿主侧算出（文件名/扩展名只是声明，不当作事实）
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // 第 4 参刻意缺省：扩展名不可信 ⇒ 「与声明一致」环整环跳过，嗅探说了算
    const checked = validateImageCandidate(bytes, sha256, undefined, basename(absolutePath));
    if (!checked.ok) {
      // `messageKey` 是 l10n 键面（英文源键 + `{n}` 插值实参），按 imageValidation 的契约
      // 由消费侧解析：直接把键拼进中文句子会印出中英混排与未替换的 `{0}`，
      // 而这段文本会进过程块展开体与模型上下文。
      const reason = vscode.l10n.t(checked.messageKey, ...checked.messageArgs);
      return {
        ok: false,
        text: `读图失败：不是可用图片（校验第 ${checked.stage} 步未通过：${reason}）。`,
      };
    }

    const ref: ImageRef = {
      sha256,
      mime: checked.mime,
      width: checked.width,
      height: checked.height,
      bytes: bytes.length,
      name: checked.name,
    };
    // 同一 sha 重复 ingest 不会重复计字节
    deps.cache.ingestBytes(ref, bytes);
    return { ok: true, ref };
  };
}
