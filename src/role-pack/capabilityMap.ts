/**
 * 能力声明（capability）→ memora 特权工具 映射表（SSOT）
 *
 * 角色包以**中立能力命名空间**声明（`web:search` / `code:execute` / `task:plan`），
 * 不绑具体实现；各实现（memora 是 reference implementation）自行映射到自有工具。
 *
 * 语义（tool-exposure-model 探索草稿：默认常驻 vs 角色启动）：
 * capabilities = 角色包声明的**超越默认边界的特权**，而非逐项打开本地能力——
 * 本地只读/项目内/内核基建工具（read_file/search_memories/技能域等）默认常驻、
 * 不受本表控制（见 toolExecutor.DEFAULT_EXPOSED_TOOLS）。
 *
 * 映射规则：
 *   - 一个能力可映射到多个工具；一个工具可被多个能力映射；
 *   - 未知能力（不在本表）：解析时跳过（不产出工具），由校验器在装载阶段给出 warning 诊断
 *     （见 `isRegisteredCapability` 与 `validator.ts` 的 UNREGISTERED_CAPABILITY）；
 *   - 本表只控制**特权工具暴露面**（LLM 可见的工具列表），不改变 execute 路由——
 *     工具暴露 = 可被调用；工具未暴露 = LLM 无从发起调用。
 *     「换角色 → 特权工具集切换」是 mvp-scope 验收标准 7 的范式最小验证。
 */

/** 能力→工具映射表（只读，防外部篡改） */
const CAPABILITY_TO_TOOLS: Readonly<Record<string, readonly string[]>> = {
  // 网络域（判据 A：外部网络副作用，越出项目边界）
  'web:search': ['web_search'],
  // 搜索→抓取闭环：web_fetch 读正文（与 web_search 成对声明，角色包按需声明）
  'web:fetch': ['web_fetch'],
  // 通用计算域：LLM 现写任意代码（判据 A+B：无轨迹）。宿主注入 ICodeExecutionProvider 才真正暴露
  'code:execute': ['run_code'],
  // 任务域：task_table_* 不在能力门控内（任务表是内核多步任务必要基建，
  // 与 compress_context 同属默认常驻，见 toolExecutor.DEFAULT_EXPOSED_TOOLS）→ 不由 rolePack
  // 声明解锁，故**不映射**到白名单：声明它不解锁任何工具（这一半是「假特权」）。
  // ⚠️ 但「不解锁」≠「声明无副作用」：capabilities 一旦写成数组（哪怕只含本键），白名单就从
  // 省略态的 `null`（全开）收窄为「常驻集 + 已登记能力映射出的工具」，其他特权工具随之丢失
  // （三态判定见 `agent.applyRolePackToolExposure`；未登记的 `task:plan` 另由 validator 报
  // UNREGISTERED_CAPABILITY warning）。
  // ⚠️ 本表**不保留** `task:plan` 条目（连空数组都不写）：在本函数内「键不存在」与「空数组」
  // 产出工具完全等价（均不产出工具），差异只在诊断与上述白名单收窄，故不为它占位。能力名合法性由 validator 的 CAPABILITY_PATTERN
  // （开放正则 `域:动作`）单点校验——内核**没有**集中式「中立能力字典」表。
  // 内核内部能力（无工具映射，仅声明存在；实现按自身能力实现）：已登记、声明后不解锁任何工具，
  // 但同属「声明即收窄白名单」——已登记只免掉 warning，不免掉收窄副作用。
  'llm:summarize': [],
};

/**
 * 解析能力声明列表为 memora 特权工具白名单
 *
 * @param capabilities 角色包声明的能力列表（可空）
 * @returns 工具名白名单（去重、保序）；空数组 = 无特权工具（常驻豁免集仍全部可用）
 */
export function resolveCapabilityTools(
  capabilities: readonly { capability: string }[] | undefined,
): string[] {
  if (!capabilities || capabilities.length === 0) return [];
  const tools = new Set<string>();
  for (const { capability } of capabilities) {
    const mapped = CAPABILITY_TO_TOOLS[capability];
    if (mapped) {
      for (const tool of mapped) tools.add(tool);
    }
    // 未知能力：解析层跳过（不产出工具）；可见性诊断由校验期负责，避免解析层产生副作用
  }
  return [...tools];
}

/**
 * 判断能力名是否已在本表登记（「已登记」= 有映射条目，空数组条目也算登记）
 *
 * **为什么单独导出**：登记真相源只有本文件的 `CAPABILITY_TO_TOOLS` 一张表；
 * 校验器需要判断「格式合法但未登记」时只来问这一个函数，不复制第二份能力名清单。
 *
 * @param capability 中立能力名（`域:动作`）
 * @returns 是否已登记（`llm:summarize` 这类空映射条目返回 true）
 */
export function isRegisteredCapability(capability: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_TO_TOOLS, capability);
}
