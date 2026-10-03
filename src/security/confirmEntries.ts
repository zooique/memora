/**
 * 执行面 → 确认入口 登记表（CMD-1-BYPASS，2026-10-03）
 *
 * 背景（实锤）：`classifyCommand`（deny / always-ask）的唯一调用点是 `SecurityGuard.confirmCommandRun`，
 * 而 `confirmCommandRun` 的唯一调用点又是 `toolExecutor` 的 `run_command` 分支 ⇒ 命令内容裁决只锁
 * **一个**执行面。其余执行面（run_code / run_project_script / run_skill_script）走 `confirmScriptRun`，
 * **只判权限档位、不看执行内容**。
 *
 * 登记表 = 把「每个执行面走哪个确认入口」从「散在四个 case 分支里的隐式默认值」变成**显式单一真源**：
 * 新增执行面时**必须**在此登记，否则守卫测试（confirmEntry.test.ts 的穷举性断言）即红。
 *
 * 真源关系（禁再独立枚举工具名）：「哪些工具是执行面」由 `builtinTools` 的 `diskWrite === 'opaque'`
 * 派生（`OPAQUE_WRITE_TOOL_NAMES`）⇒ 本表**只登记入口**，不复制第二份工具清单。
 *
 * - `command`：走 `confirmCommandRun`（内容裁决 DENY/always-ask + 确认档位）
 * - `script` ：走 `confirmScriptRun`（仅权限档位，不看执行内容）
 * - `none`  ：**内核不经任何确认闸**——非执行面（`register_work` 只往 `memoraDir` 写作品索引 JSON，
 *   既不执行也不碰项目文件，实锤：kernel 侧 `registerWork` 回调链零 `confirm*` 调用）。
 *   登记它是为了让「opaque 面一个都不漏」可机器核对；它**不是**确认入口，禁被路由进确认闸。
 */

/** 确认入口档位（`none` = 非确认入口，仅作「已核对」登记） */
export type ConfirmEntry = 'command' | 'script' | 'none';

/** 真正构成确认闸的档位（`none` 排除在外）——路由函数入参类型，编译期挡住非确认面被路由进来 */
export type ConfirmingEntry = Exclude<ConfirmEntry, 'none'>;

/** 执行面 → 确认入口（SSOT；键集必须与 opaque 派生集双向相等，由守卫测试钉死） */
export const CONFIRM_ENTRY_BY_TOOL: Readonly<Record<string, ConfirmEntry>> = {
  run_command: 'command',
  run_code: 'script',
  run_project_script: 'script',
  run_skill_script: 'script',
  /** 作品投影登记：只写 memoraDir 内索引 JSON，内核零确认（非执行面） */
  register_work: 'none',
};

/**
 * 取某工具的确认入口；未登记即抛错（fail-closed：漏登记比登记错更危险，因为它不显眼）。
 *
 * @param tool 工具名
 * @returns 该工具的确认入口
 */
export function requireConfirmEntry(tool: string): ConfirmEntry {
  const entry = CONFIRM_ENTRY_BY_TOOL[tool];
  if (!entry) {
    throw new Error(
      `工具「${tool}」未登记确认入口（CONFIRM_ENTRY_BY_TOOL）——新增执行面须在此登记，见 confirmEntries.ts 头注释`,
    );
  }
  return entry;
}

/**
 * 取某工具的**确认**入口；登记为 `none` 的非执行面在此抛错（fail-closed）。
 *
 * 抛错发生在**取登记处**而非路由处 ⇒ 路由函数保持穷尽分支（无僵尸分支），
 * 且「非执行面被误接进确认闸」在编译期（入参类型）+ 运行期（此处）双重拦死。
 *
 * @param tool 工具名
 * @returns 该工具的确认入口（不含 `none`）
 */
export function requireConfirmingEntry(tool: string): ConfirmingEntry {
  const entry = requireConfirmEntry(tool);
  if (entry === 'none') {
    throw new Error(
      `工具「${tool}」登记为 none（非确认入口），不得经内核确认闸路由——如需确认，请先改登记口径`,
    );
  }
  return entry;
}
