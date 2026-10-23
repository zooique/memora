/**
 * MCP 调用结果 → 工具返回文本（方案 §7 P3/P6 + §10 预裁行 · 切片 3a 落地）
 *
 * 内核 `ToolHandler` 只回 `Promise<string>`（`src/agent/toolExecutor.ts` 的
 * `ToolHandler` 类型），故这里是 MCP 结果进内核的**唯一归一化点**（切片 1 的
 * `renderToolResult` 并入本模块，toolRegistry 不再自持一份）。三条纪律：
 *   1. **`isError` 不当正常文本**（P3）：抛错交执行器按工具失败处理——假成功（让
 *      模型拿错误文本当正常结果）比失败更糟。执行器侧 catch 后统一包装为 MemoraError
 *      （toolExecutor custom 分支），宿主不重复造错误类型。
 *   2. **不静默吞内容**：非文本块（image / audio / resource）丢弃但注明类型；文本为
 *      空时 `structuredContent` 降级为 JSON 文本（P6），防「空结果」被误读成工具无
 *      事可做。有文本正文时 `structuredContent` 是平行冗余形态，丢弃不注（P6 登记
 *      项的观测面 = 降级标记出现次数）。
 *   3. **per-result 预裁**（§10 退出项）：单条超 `MAX_TOOL_RESULT_CHARS` 截断并附
 *      原长说明。这是**内存与告知面**的软闸；上下文硬闸在内核 `appendToolMessage`
 *      （`SINGLE_TOOL_RESULT_MAX_TOKENS`），两者刻意不互 mirror——按字符猜 token
 *      等于造第二个估算器（散点），且内核闸触发的模型可见文案与本闸不同源。
 *
 * 结构化输出的完整支持 / 取消 / progress 仍归 §10 登记项（P6），本文件只做文本降级。
 */
import { isPlainObject } from './json.js';

/**
 * 单条结果字符数预裁上限
 *
 * 取值依据：MCP 工具可返回任意大文本（整文件、搜索结果页）。20_000 字符 ≈ 数十 KB，
 * 对正常工具结果宽裕、对异常大结果有界；超限即截断并明示原长（模型可改用分段参数
 * 重取）。硬上限仍以内核入口关为准（见模块头纪律 3）。
 */
const MAX_TOOL_RESULT_CHARS = 20_000;

/**
 * 归一化一次 MCP 调用结果
 *
 * @param result MCP `CallToolResult`（SDK 返回的联合类型，按未知值收窄）
 * @returns 进内核的文本；`isError` 时**抛错**（P3：工具失败，不是正常文本）
 * @throws `isError === true` 时抛 `Error`（文案 = 归一化后的结果文本）
 */
export function normalizeToolResult(result: unknown): string {
  const payload = isPlainObject(result) ? result : null;
  const content = payload && Array.isArray(payload['content']) ? payload['content'] : [];

  const parts: string[] = [];
  for (const item of content) {
    if (!isPlainObject(item)) continue;
    if (item['type'] === 'text' && typeof item['text'] === 'string') {
      parts.push(item['text']);
      continue;
    }
    // 非文本（image / audio / resource / 嵌入资源）：本期内核只收字符串，
    // 丢弃但注明类型，避免「返回了空文本」被误读成工具无事可做
    parts.push(`[已丢弃非文本结果：${String(item['type'])}]`);
  }

  let text = parts.join('\n');

  // structuredContent 降级（P6）：仅当文本为空时转 JSON——有正文时它是平行冗余
  // 形态（MCP 规范建议两者并存），转出来只会让同一事实出现两遍
  const structured = payload?.['structuredContent'];
  if (text.length === 0 && isPlainObject(structured) && Object.keys(structured).length > 0) {
    text = `[结构化输出已降级为文本]\n${stringify(structured)}`;
  }

  const isError = payload?.['isError'] === true;
  if (text.length === 0) {
    text = isError ? 'MCP 工具返回错误（无文本说明）' : '（MCP 工具返回空结果）';
  }

  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[结果已截断：原长 ${text.length} 字符，仅保留前 ${MAX_TOOL_RESULT_CHARS} 字符]`;
  }

  // isError 放最后：错误文案同样受预裁约束（先截断再抛，抛出的消息有界）
  if (isError) {
    throw new Error(text);
  }
  return text;
}

/**
 * 紧凑 JSON 序列化（structuredContent 降级用）
 *
 * 循环引用理论上不该出现在协议载荷里，但按未知值收窄：失败即空串，不让降级路径
 * 自己抛错（降级失败 = 把 P6 的边缘形态升级成工具失败，没必要）。
 *
 * @param value 任意 JSON 值
 */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
