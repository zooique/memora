/**
 * 外部文本净化（**单一真理源**）
 *
 * 独立成模块的原因（不是「为了整洁」）：净化函数是**所有外部内容进上下文前的最后一道闸**，
 * 而它的消费方跨了模块边界——`toolExecutor`（工具返回）、`builtinToolHandlers`（脚本/资源正文）、
 * `skillScriptRunner`（命令结果格式化）。此前它住在 `toolExecutor.ts`，导致两个后果：
 *   ① `builtinToolHandlers` 反向 import `toolExecutor`（而 `toolExecutor` 也 import 它）——**模块循环**；
 *   ② 命令结果的**定长真源**（`RUN_SCRIPT_RESULT_MAX_LEN`）是 toolExecutor 的模块私有常量，
 *      第二个消费面（后台回��通知）看不到它 ⇒ 回流路径裸奔、无长度上限（2MB 输出可直灌上下文）。
 * 抽到零依赖的纯模块后，两个消费面共用同一份规则与同一个上限。
 *
 * 量纲纪律：本模块是**字符**层。上下文侧另有 token 入口关（`appendToolMessage` 落盘）、
 * 子进程侧另有**字节**内存护栏（`skillScriptRunner.MAX_COLLECTED_OUTPUT_BYTES`）——
 * 三者量纲与目的各异，**禁止互相对齐或合并**。
 */

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
