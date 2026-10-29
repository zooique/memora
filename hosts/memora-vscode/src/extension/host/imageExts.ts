/**
 * 入站图片扩展名单点（IMG-9）
 *
 * ## 为什么需要它
 * 「哪些扩展名算图片」此前有两份：`imagePick` 的选择框过滤器写死
 * `png / jpg / jpeg / webp / gif`，`refImageGuard` 的预筛取 `EXT_BY_MIME` 的**值**
 * 再补一个 `jpeg`。两处各自演进 ⇒ 选择框能选、右键却不拦（或反之），
 * 且**没有任何测试会红**。
 *
 * ## 与 `EXT_BY_MIME` 的关系（勿混为一谈）
 * `EXT_BY_MIME` 是**出站写出**表：一个 mime 只对应一个规范扩展名（jpeg → `jpg`）。
 * 入站可接受面比它宽一格——`jpeg` 同样是常见写法，必须接受。故本集合 =
 * 出站值 ∪ 同义写法，**不新建第二张 mime 映射表**：真源始终是嗅探出的 mime，
 * 扩展名只承担预筛（省读盘开销）。
 *
 * ## 两条不变式（由 `imageExts.test.ts` 机检，删测试即失去保护）
 * ① 出站写出的每个扩展名都必须 ∈ 入站集合——否则自己写出的文件选不回来；
 * ② 入站集合里每个扩展名都必须有真实格式头能通过 `sniffImageMime`——否则预筛放行、
 *    嗅探判否 ⇒ 图片被当文件引用挂上去，回到 G2 的静默失败。
 */
import { EXT_BY_MIME } from './projectDataDir.js';

/**
 * 入站可接受扩展名（不含点，全小写）
 *
 * 顺序 = 出站表顺序 + 末尾同义写法；该顺序只影响原生选择框里的展示次序，
 * 不承载语义（判据是集合成员关系）。
 *
 * 新增格式：改 `EXT_BY_MIME` 即自动进入本集合。**仅当出现同义写法**（如 `jpeg`）
 * 才在此追加，并同步 `imageExts.test.ts` 的两条不变式。
 */
export const INBOUND_IMAGE_EXTS: readonly string[] = [...Object.values(EXT_BY_MIME), 'jpeg'];

/**
 * 扩展名预筛（**不是判据**）：大小写不敏感，只看最后一个点之后的部分
 *
 * 唯一用途：让调用方**只对疑似图片读文件头**，避免对每个右键目标都读盘。
 * 真伪由 `sniffImageMime` 判定（见 `refImageGuard.isRefTargetImage`）。
 */
export function hasInboundImageExtension(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return INBOUND_IMAGE_EXTS.includes(fileName.slice(dot + 1).toLowerCase());
}
