/**
 * 外部文本净化（**单一真理源**）
 *
 * 独立成模块的原因（不是「为了整洁」）：净化函数是**所有外部内容进上下文前的最后一道闸**，
 * 而它的消费方跨了模块边界——`toolExecutor`（工具返回）、`builtinToolHandlers`（脚本/资源正文）、
 * `skillScriptRunner`（命令结果格式化）。此前它住在 `toolExecutor.ts`，导致两个后果：
 *   ① `builtinToolHandlers` 反向 import `toolExecutor`（而 `toolExecutor` 也 import 它）——**模块循环**；
 *   ② 命令结果的**定长真源**（`RUN_SCRIPT_RESULT_MAX_LEN`）是 toolExecutor 的模块私有常量，
 *      第二个消费面（后台完成回流）看不到它 ⇒ 回流路径裸奔、无长度上限（2MB 输出可直灌上下文）。
 * 抽到零依赖的纯模块后，两个消费面共用同一份规则与同一个上限。
 *
 * 量纲纪律：本模块是**字符**层。上下文侧另有 token 入口关（`appendToolMessage` 落盘）、
 * 子进程侧另有**字节**内存护栏（`skillScriptRunner.MAX_COLLECTED_OUTPUT_BYTES`）——
 * 三者量纲与目的各异，**禁止互相对齐或合并**。
 */

/**
 * 字节缓冲的文本判定结果（**二进制嗅探的判据面**，结构化而非布尔）
 *
 * 为什么带 `reason` / `encoding` 而不是只回 true/false：
 * - 两个消费方（`read_file` 的错误文案、项目规则读盘）需要各自措辞，但**判据只允许一份**；
 * - 「是文本」也要能回答「按哪种编码读的」——UTF-16（Windows 记事本 / Excel 导出 CSV 的
 *   常见编码）里 ASCII 字符天然跟一个 NUL，若不分编码就会把 UTF-16 文本误判成二进制。
 */
export type TextBufferDecodeResult =
  | {
      readonly kind: 'text';
      readonly text: string;
      /** 实际采用解码编码（由 BOM 决定；无 BOM 一律按 UTF-8） */
      readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
    }
  | {
      readonly kind: 'binary';
      /** 非文本原因：无 BOM 含 NUL / UTF-8 非法序列 / UTF-16 非法序列 */
      readonly reason: 'nul-byte' | 'invalid-utf8' | 'invalid-utf16';
    };

/**
 * 检测文本 BOM（字节序标记）
 *
 * 顺序不可换：UTF-16LE 的 BOM 是 `FF FE`，必须先于任何「含 NUL 即二进制」的判据——
 * UTF-16 文本的 ASCII 部分每个字符都带 `0x00`，先判 NUL 必然误杀。
 *
 * @param buf 文件完整字节（只读前 3 字节）
 * @returns 识别到的编码；无 BOM 返回 null
 */
function detectTextBom(buf: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' | null {
  // 越界读出 undefined 时统一给 -1，避免与真实字节值相等
  const at = (i: number): number => buf[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xfe) return 'utf-16le';
  if (at(0) === 0xfe && at(1) === 0xff) return 'utf-16be';
  if (at(0) === 0xef && at(1) === 0xbb && at(2) === 0xbf) return 'utf-8';
  return null;
}

/**
 * 字节缓冲 → 文本判定 + 解码（**二进制嗅探的唯一真理源**）
 *
 * 判定顺序（顺序即语义，不可调换）：
 * 1. **有 BOM** ⇒ 按 BOM 声明的编码严格解码（UTF-8 / UTF-16LE / UTF-16BE）。
 *    UTF-16 文本含大量 NUL（ASCII 字符的高/低字节），绝不能先按 NUL 判二进制；
 * 2. **无 BOM** 且含 NUL 字节（0x00）⇒ 二进制（文本文件不会有裸 NUL）；
 * 3. **无 BOM** 且 `TextDecoder('utf-8', { fatal: true })` 解码失败 ⇒ 二进制。
 *    不用替换式解码：`fatal: false` 会把非法字节静默变成 U+FFFD，等于把乱码当正文
 *    （`read_file` 曾因此把 JPEG/PNG 解码成「一屏替换符 + 可打印垃圾」）。
 *
 * BOM 口径：`ignoreBOM: true` 让 BOM 作为 U+FEFF 保留在输出里，与
 * `fs.readFile(path, 'utf-8')`（`Buffer#toString('utf8')`）逐字一致——`read_file` 的
 * 既有 UTF-8 行为不得因本判据引入而改变；UTF-16 沿用同一口径（保留 BOM 字符）。
 *
 * @param buf 已读入内存的完整字节（本函数只读，不复制）
 * @returns 文本（kind='text'，含实际编码）或二进制原因（kind='binary'）
 */
export function decodeTextBuffer(buf: Uint8Array): TextBufferDecodeResult {
  // ① BOM 优先：UTF-16 文本必然含 NUL，必须在 NUL 判据之前按编码解码
  const bomEncoding = detectTextBom(buf);
  if (bomEncoding !== null) {
    try {
      const text = new TextDecoder(bomEncoding, { fatal: true, ignoreBOM: true }).decode(buf);
      return { kind: 'text', text, encoding: bomEncoding };
    } catch {
      // 有 BOM 却解不出（字节数不完整 / 非法代理对）⇒ 损坏的文本，按二进制拒绝
      return {
        kind: 'binary',
        reason: bomEncoding === 'utf-8' ? 'invalid-utf8' : 'invalid-utf16',
      };
    }
  }
  // ② 无 BOM：NUL 字节（整段扫；文本文件不存在裸 NUL，二进制文件前段/后段都可能出现）
  if (buf.includes(0)) return { kind: 'binary', reason: 'nul-byte' };
  try {
    // ③ 无 BOM：严格 UTF-8 解码，一次完成「校验 + 产出字符串」，不额外扫第二遍
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    return { kind: 'text', text, encoding: 'utf-8' };
  } catch {
    return { kind: 'binary', reason: 'invalid-utf8' };
  }
}

/**
 * 去 ANSI 转义序列与不可打印控制字符（**不限长**）
 *
 * @param text 原始文本
 * @returns 净化后的文本
 */
export function stripControlChars(text: string): string {
  // 去 ANSI 转义序列（CSI：ESC [ 参数 + 终结符；子进程经 env 继承可能拿到
  // FORCE_COLOR 输出色码，单剥 ESC 会留 `[33m` 残渣——整个序列须剥净）
  const withoutAnsi = text.replace(/\[[0-9;?]*[a-zA-Z]/g, '');
  // 去控制字符：保留可打印字符（含 \t 制表符），其余控制字符移除
  return withoutAnsi.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/**
 * 外部工具返回净化：去控制字符 + 长度上限
 *
 * 净化规则本身抽为 `stripControlChars`（**单一真理源**），供需要「净化但不限长」的调用方复用——
 * 例如 `read_file`：它的长度由 **token 预算分段**（`sliceFileByLineBudget`）收口，不走字符上限，
 * 但仍须剥掉 ANSI/控制字符。否则它只能传一个假的上限（如 MAX_SAFE_INTEGER）来迁就本函数签名。
 *
 * @param text 外部原始文本
 * @param maxLen 最大长度（**内容预算**，不含省略标记本身）
 * @param tailChars 尾部保留字符数（默认 0 = 仅留头部；>0 时头尾各留一份，预算内部分配）
 * @returns 净化后的文本
 */
export function sanitizeExternalText(text: string, maxLen: number, tailChars = 0): string {
  const cleaned = stripControlChars(text);
  if (cleaned.length <= maxLen) return cleaned;
  if (tailChars <= 0) return `${cleaned.slice(0, maxLen)}…`;
  // 头 + 尾：不扩大总预算（头尾合计仍 = maxLen），中间如实标注省略量。
  // 尾部保留解决的是「长输出的关键信息常在尾部」——构建/测试的失败原因、
  // 堆栈末尾、FAIL 汇总行都在尾；只留头会让 LLM 系统性看不到失败原因（缺口 D）。
  const tail = Math.min(tailChars, maxLen - 1);
  const headLen = maxLen - tail;
  const omitted = cleaned.length - headLen - tail;
  return (
    `${cleaned.slice(0, headLen)}…[省略 ${omitted} 字符]…` + cleaned.slice(cleaned.length - tail)
  );
}
