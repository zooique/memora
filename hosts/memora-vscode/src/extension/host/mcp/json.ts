/**
 * MCP 模块共用的 JSON 形状谓词
 *
 * MCP 协议载荷（工具声明 / 调用结果 / 分页响应）都是「任意 JSON」，宿主只能按未知值
 * 收窄判别，故这一个谓词被 toolRegistry 与 resultNormalizer 共用——单点定义，
 * 禁止各写一份（判据散点 = 两处判别口径可各自漂移）。
 */

/** 参数 schema / 结果载荷的松散形状（MCP 侧只能按未知值收窄） */
export type JsonSchema = Record<string, unknown>;

/**
 * 判断是否为普通对象（非 null、非数组）
 *
 * @param value 任意值
 */
export function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
