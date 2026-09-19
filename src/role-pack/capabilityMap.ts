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
 *   - 未知能力（不在本表）：装载方跳过，不阻塞；
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
  // 任务域：task_table_* 已移出能力门控（2026-09-16 用户拍板：任务表是内核多步任务必要基建，
  // 与 compress_context 同属默认常驻，见 toolExecutor.DEFAULT_EXPOSED_TOOLS）→ 不再由 rolePack
  // 声明解锁，故**不映射**到白名单（映射=假特权：声明与否行为全同，徒增困惑）。task:plan 仅保留
  // 作中立能力字典条目（供其他实现消费，memora 侧无工具映射），同 llm:summarize 的口径。
  // 内核内部能力（无工具映射，仅声明存在；实现按自身能力实现）
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
    // 未知能力：跳过，不报错不阻塞
  }
  return [...tools];
}
