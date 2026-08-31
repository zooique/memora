/**
 * 能力声明（capability）→ memora 内置工具 映射表（SSOT）
 *
 * 角色包以**中立能力命名空间**声明
 * （`file:write` / `web:search` / `llm:summarize`），不绑具体实现；
 * 各实现（memora 是 reference implementation）自行映射到自有工具。
 *
 * 本文件是 **memora 侧的唯一映射表**（SSOT）：
 *   - key：中立能力名（`域:动作`）
 *   - value：memora 内置工具名数组（对应 BUILTIN_TOOLS / WEB_SEARCH_TOOL 的 name）
 *
 * 映射规则：
 *   - 一个能力可映射到多个工具（如 `file:write` → write_file 的 owner 模式）；
 *   - 一个工具可被多个能力映射（如 llm:summarize 是内核内部能力，无工具映射）；
 *   - 未知能力（不在本表）：装载方跳过，不阻塞）。
 *
 * 注意：此表只控制**工具暴露面**（LLM 可见的工具列表），不改变 execute 路由——
 * 工具暴露 = 可被调用；工具未暴露 = LLM 无从发起调用。这是「换角色→工具集切换」
 * 范式的最小验证面（mvp-scope 验收标准 7）。
 */

/** 能力→工具映射表（只读，防外部篡改） */
const CAPABILITY_TO_TOOLS: Readonly<Record<string, readonly string[]>> = {
  // 文件域
  'file:read': ['read_file'],
  'file:write': ['write_file'],
  'file:list': ['list_dir'],
  // 网络域
  'web:search': ['web_search'],
  // 搜索→抓取闭环：web_fetch 读正文（与 web_search 成对声明，角色包按需声明）
  'web:fetch': ['web_fetch'],
  // 通用计算域（宿主注入 ICodeExecutionProvider 才真正暴露，能力声明本身只控制暴露面）
  'code:execute': ['run_code'],
  // 项目搜索域（宿主注入 IProjectSearchProvider 才真正暴露，等价 IDE 全局搜索）
  'project:search': ['search_project'],
  // 记忆域
  'memory:recall': ['search_memories'],
  // 任务域
  'task:plan': ['task_table_write', 'task_table_update'],
  // 内核内部能力（无工具映射，仅声明存在；实现按自身能力实现）
  'llm:summarize': [],
};

/**
 * 解析能力声明列表为 memora 工具白名单
 *
 * @param capabilities 角色包声明的能力列表（可空）
 * @returns 工具名白名单（去重、保序）；空数组 = 无工具可用（配合 toolMode=allow 即全禁）
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

/**
 * 判断某工具名是否为某能力白名单内
 *
 * 供测试/校验使用：验证「换角色 → 工具集切换」时工具暴露面正确。
 */
export function isToolInCapabilities(
  toolName: string,
  capabilities: readonly { capability: string }[] | undefined,
): boolean {
  return resolveCapabilityTools(capabilities).includes(toolName);
}
