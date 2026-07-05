/**
 * 角色控制器 — 角色交互
 *
 * 职责：
 *   1. 获取/切换当前角色
 *   2. 角色列表展示
 *   3. 角色匹配模式设置
 */
import { logger, toError } from 'memora';
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
   * 切换角色
   *
   * 统一错误策略后，switchPersona 找不到角色时抛 MemoraError。
   * 此处捕获异常返回 null，保持宿主门面的"失败返回 null"契约，
   * 让 IPC 层通过 switched=false 告知 UI。
   *
   * JSDoc 注释订正：原标注 @returns 角色名称，实际返回的是
   * PersonaManager.buildSystemPrompt 生成的角色系统提示文本。现修正注释。
   *
   * @param name 角色名称
   * @returns 切换后的角色系统提示文本，失败返回 null
   */
  switch(name: string): string | null {
    const pm = this.agent.persona;
    if (!pm) return null;
    try {
      return pm.switchPersona(name);
    } catch (err) {
      // 角色切换失败时返回 null，记录警告便于排查
      logger.warn({ err: toError(err).message, name }, '角色切换失败');
      return null;
    }
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
