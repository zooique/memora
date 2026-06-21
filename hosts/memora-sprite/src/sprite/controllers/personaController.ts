/**
 * 角色控制器 — 角色交互
 *
 * 职责：
 *   1. 获取/切换当前角色
 *   2. 角色列表展示
 *   3. 角色匹配模式设置
 */
import type { Agent } from 'memora';

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
    return pm.list.map(p => ({
      name: p.name,
      description: p.description ?? '',
      active: p.name === activeName,
    }));
  }

  /**
   * 切换角色
   *
   * IX-03 统一错误策略后，switchPersona 找不到角色时抛 MemoraError。
   * 此处捕获异常返回 null，保持宿主门面的"失败返回 null"契约，
   * 让 IPC 层通过 switched=false 告知 UI。
   *
   * @param name 角色名称
   * @returns 切换后的角色名称，失败返回 null
   */
  switch(name: string): string | null {
    const pm = this.agent.persona;
    if (!pm) return null;
    try {
      return pm.switchPersona(name);
    } catch {
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

  /**
   * 格式化角色列表为可读文本
   *
   * @returns 格式化后的角色列表文本（含当前角色标记）
   */
  format(): string {
    const personas = this.list();
    if (personas.length === 0) {
      // 空状态引导：告知用户角色文件存放位置，避免不知道如何添加角色
      return '暂无可用角色\n\n提示：在 agent-config/personas/ 目录下创建角色配置文件（.md 格式）即可添加角色';
    }

    const lines: string[] = ['── 角色列表 ──'];
    for (const p of personas) {
      const marker = p.active ? ' *' : '';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(`  ${p.name}${marker}${desc}`);
    }
    lines.push(`\n当前角色：${this.activeName ?? '(无)'}`);
    return lines.join('\n');
  }
}
