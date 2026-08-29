/**
 * 角色包内核常量
 *
 * BUILTIN_FALLBACK_PACK：内核兜底契约包名（名字即契约，改名须走 ADR）。
 * 该包随内核分发（role-packs/<BUILTIN_FALLBACK_PACK>/），宿主构建期同步 + existsSync 硬校验
 * （缺失即构建失败）；运行时缺失 → 无 persona 继续运行 + warning（降级优先 §7，不装配失败）。
 * 覆盖：宿主可经 AgentOptions.builtinFallbackRole 覆盖（覆盖值须存在，否则回退本常量）。
 */
export const BUILTIN_FALLBACK_PACK = 'memora助手';

/**
 * 小组会议组员数量上限（② 组队规格，2026-08-30）：组员 ≤ 4（5 人组 = 队长 1 + 组员 4）。
 *
 * SSOT 单一来源：内核校验 warning + 会议消费端截断共用；宿主（UI 勾选层 / 保存校验）经
 * `@zooique/memora` import 本常量，webview 侧由宿主随 roles_loaded 下发（浏览器沙箱不可直连内核）。
 * 严禁在宿主另写字面量——并列定义即腐化。
 *
 * 超限时：装载只 warning（不阻塞、不裁切存储），**会议消费端截断至前 4 名**
 * （`RolePackManager.activeTeamMembers` 收口，超出部分不参与会议）。
 */
export const MAX_TEAM_MEMBERS = 4;
