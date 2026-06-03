/**
 * persona/ 模块入口
 *
 * 人格管理层 — 记忆管道最高优先级
 * 职责：加载 personas/*.md，解析 frontmatter，组装 system prompt 前缀
 */
export { PersonaManager } from './personaManager.js';
export type { Persona, PersonaTool } from './personaManager.js';
