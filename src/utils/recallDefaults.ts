/**
 * 召回默认值——单一真理源（记忆层与 agent 层共享）。
 *
 * 召回不设保底下限（无 `DEFAULT_MIN_FALLBACK`）——保底仅在「检查点恢复的温记忆召回」
 * 场景有意义，该链路不在实现内。
 */

/**
 * 召回排除 source 默认值（空数组）——设定记忆（persona/rule/skill）归角色包、
 * 记忆库不写入，不参与召回排除（memory-role-pack-boundary），此处为空默认。
 *
 * **唯一活性消费者 = `MemoryAdvisor.suggest()`**（关联推荐的 `excludeSources` 本地参数缺省值）；
 * 不存在同名配置管道 `config.recallExcludeSources`（ContextPreparer 侧）——`assembleContext`
 * 从不读取该配置（死配置），勿因「两处同名」而误以为是一根链。
 */
export const DEFAULT_RECALL_EXCLUDE_SOURCES: readonly string[] = [];
