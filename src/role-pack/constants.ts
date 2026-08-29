/**
 * 角色包内核常量
 *
 * BUILTIN_FALLBACK_PACK：内核兜底契约包名（名字即契约，改名须走 ADR）。
 * 该包随内核分发（role-packs/<BUILTIN_FALLBACK_PACK>/），宿主构建期同步 + existsSync 硬校验
 * （缺失即构建失败）；运行时缺失 → 无 persona 继续运行 + warning（降级优先 §7，不装配失败）。
 * 覆盖：宿主可经 AgentOptions.builtinFallbackRole 覆盖（覆盖值须存在，否则回退本常量）。
 */
export const BUILTIN_FALLBACK_PACK = 'memora助手';
