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

  /** 切换角色 */
  switch(name: string): string | null {
    const pm = this.agent.persona;
    if (!pm) return null;
    return pm.switchPersona(name);
  }

  /** 设置角色匹配模式 */
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

  /** 格式化角色列表为可读文本 */
  format(): string {
    const personas = this.list();
    if (personas.length === 0) return '暂无可用角色';

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
