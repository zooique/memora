/**
 * 角色控制器 — 角色交互
 *
 * 职责：
 *   1. 获取当前角色
 *   2. 角色列表展示
 *   3. 角色匹配模式设置
 *
 * 角色切换（switchPersona）由 Agent.switchPersona 公共方法提供，
 * 统一走事件链路（refreshPersonaPrefix + emit personaSwitched），
 * 本控制器不参与切换流程，避免双路径切换导致的事件发散。
 */
import type { Agent, Persona } from 'memora';

/** 角色信息 */
export interface PersonaInfo {
  name: string;
  description: string;
  active: boolean;
}

/**
 * 角色控制器
 */
export class PersonaController {
  private agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  /** 获取当前角色名称 */
  get activeName(): string | null {
    return this.agent.persona?.activeName ?? null;
  }

  /** 获取角色列表 */
  list(): PersonaInfo[] {
    const pm = this.agent.persona;
    if (!pm) return [];
    const activeName = pm.activeName;
    return pm.list.map((p: Persona) => ({
      name: p.name,
      description: p.description ?? '',
      active: p.name === activeName,
    }));
  }

  /**
   * 设置角色匹配模式
   *
   * @param mode 匹配模式（'auto' 自动匹配 / 'manual' 手动固定）
   * @returns 是否设置成功
   */
  setMode(mode: 'auto' | 'manual'): boolean {
    const pm = this.agent.persona;
    if (!pm) return false;
    pm.setMode(mode);
    return true;
  }

  /** 获取当前角色匹配模式 */
  get currentMode(): string {
    return this.agent.persona?.currentMode ?? 'auto';
  }

}
