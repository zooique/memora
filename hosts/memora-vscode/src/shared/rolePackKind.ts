/**
 * 角色包工种分流（宿主策略面）
 *
 * 内核只承载 `kind` 判据（`RolePackMeta.kind`）与工具组面机制（`applyRolePackToolExposure`）；
 * 「谁能被选中」是宿主策略，常量与过滤判据共用本模块，三处选择面禁止各写一份字面量：
 *   ① 设置页 `roles_loaded` / 草稿页角色列表（webview）
 *   ② 聊天页 `chat_role_packs`（webview）
 *   ③ 主控 `list_role_packs`（extension host）
 *
 * 助手角色包（`kind: assistant`）不进任何选择面：它只服务助手会话的固定绑定；
 * 工作会话若选到它，`orchestrate` 组工具只注册在助手会话 ⇒ 空工具面（fail-closed，
 * 安全但无意义）。故在列表源头挡住，不靠 UI 提示补救。
 * 缺省 / `work` = 存量工作包，行为逐字不变。
 */

/** 助手会话固定角色包：独立助手角色包，非 `BUILTIN_FALLBACK_PACK` 工作包（ADR 契约不改） */
export const ASSISTANT_ROLE_PACK = 'memora宝';

/**
 * 是否进入工作会话的角色包选择面
 *
 * 白名单而非 `kind !== 'assistant'`：未来若新增工种，未知值默认不展示（fail-closed），
 * 避免新的助手类包未经同步就漏进工作会话选择面。参数直接取 `RolePackMeta.kind`。
 */
export function isWorkRolePack(kind: 'work' | 'assistant' | undefined): boolean {
  return kind === undefined || kind === 'work';
}
