/**
 * Hand back 消息解析与格式化（P2 骨架 · 2026-11-17）
 *
 * Worker 超界 → 宿主识别 → 注入助手 loop 的通道真源。
 * 格式由设计文档 B6/B9 钉死：
 *   纯文本版（B6）：`[HAND_BACK] reason: <一句话> | suggestion: <可选>`
 *   JSON 扩展（B9）：`[HAND_BACK] reason: ... | payload: {"action": "new_ticket", "type": "docs"}`
 *
 * 三原则：
 *   SSOT  — 格式 + 解析 + 格式化同文件，不分散；消费面经本文件拿结果，不各自正则
 *   自然生长 — 不新建通道（走 enqueueCommandResult）；格式固定但可扩展（payload 是 B9 预留）
 *   不带伤 — 自助模式零引用；仅托管 Worker 产出、宿主消费、助手接收
 */

/** Hand back 消息类型（解析结果 + 格式化输入共用） */
export interface HandBackMessage {
  /** 超界原因（必填，一句话） */
  reason: string;
  /** 可选建议（纯文本版） */
  suggestion?: string;
  /** 可选 JSON payload（B9 预留，结构化扩张） */
  payload?: Record<string, unknown>;
}

/** 消息头 + 字段分隔符（设计文档 B6 钉死，不许改） */
const PREFIX = '[HAND_BACK]';
const FIELD_SEP = ' | '; // 注意：两空格夹管道，不是单管道
const KEY_SEP = ': '; // 冒号+空格

/**
 * 正则判定：以 [HAND_BACK] 开头即认定为 Hand back 消息
 *
 * 不做完整字段校验——那是 parseHandBackMessage 的职责；
 * isHandBackMessage 只回答"这条是不是 Hand back 消息"，让宿主消费面能快速分流。
 */
export function isHandBackMessage(text: string): boolean {
  return text.startsWith(PREFIX);
}

/**
 * 解析 Hand back 消息文本 → HandBackMessage 结构化对象
 *
 * 解析规则（设计文档 B6/B9 同源）：
 *   1. 切掉 PREFIX 前缀
 *   2. 按 FIELD_SEP 切字段（顺序不固定）
 *   3. 每字段按 KEY_SEP 切键值，trim 后填空
 *   4. payload 字段值尝试 JSON.parse，失败当普通字符串（B9 兼容两种格式）
 *
 * @returns 结构化对象；如果文本不以 PREFIX 开头或解析全空，返回 null
 */
export function parseHandBackMessage(text: string): HandBackMessage | null {
  if (!isHandBackMessage(text)) return null;

  const body = text.slice(PREFIX.length).trim();
  if (!body) return null;

  const fields = body.split(FIELD_SEP);
  const result: Partial<HandBackMessage> = {};

  for (const field of fields) {
    const sepIdx = field.indexOf(KEY_SEP);
    if (sepIdx < 0) continue; // 没有冒号分隔的字段跳过（容错）
    const key = field.slice(0, sepIdx).trim().toLowerCase();
    const value = field.slice(sepIdx + KEY_SEP.length).trim();

    if (!key || !value) continue;

    switch (key) {
      case 'reason':
        result.reason = value;
        break;
      case 'suggestion':
        result.suggestion = value;
        break;
      case 'payload':
        // B9 扩张：尝试 JSON.parse，失败当普通字符串
        try {
          result.payload = JSON.parse(value);
        } catch {
          result.payload = { _raw: value };
        }
        break;
      default:
        // 未知字段：忽略，不报错（未来扩张）
        break;
    }
  }

  // reason 必须有，否则不是合法 Hand back 消息
  if (!result.reason) return null;

  return {
    reason: result.reason,
    ...(result.suggestion !== undefined && { suggestion: result.suggestion }),
    ...(result.payload !== undefined && { payload: result.payload }),
  };
}

/**
 * 格式化 HandBackMessage → 文本（反向）
 *
 * 格式与 parseHandBackMessage 同源：
 *   - 有 payload → 输出 payload 为 JSON 字符串
 *   - 有 suggestion → 追加 suggestion 字段
 *   - 顺序固定：reason 必有，suggestion 其次，payload 最后
 *
 * 用途：宿主把 HandBackMessage 投给助手 loop 的 enqueueCommandResult
 *       时，需要转回纯文本格式（和托管中断通知的格式化器同定位）。
 */
export function formatHandBackMessage(msg: HandBackMessage): string {
  const parts: string[] = [`reason: ${msg.reason}`];
  if (msg.suggestion) parts.push(`suggestion: ${msg.suggestion}`);
  if (msg.payload) {
    parts.push(`payload: ${JSON.stringify(msg.payload)}`);
  }
  return `${PREFIX} ${parts.join(FIELD_SEP)}`;
}
