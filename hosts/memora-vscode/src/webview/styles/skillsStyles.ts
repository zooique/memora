/**
 * 技能视图样式 — 新增的全局技能管理选项卡样式（2026-08-22）
 *
 * 设计（对齐 ITCSS + tokens.ts 单一真理源）：
 *   - 以 #skills-root 前缀限定，与其他子视图样式隔离，避免串扰；
 *   - 复用 tokens.ts 中的设计令牌；
 *   - 技能卡片风格简洁清晰，展示名称、描述、关键词和触发条件。
 *   - 区分内置技能（configDir/skills/）和用户技能（userSkillsDir/）
 */

export const skillsStyles = `
  /* ============ 技能子视图（#skills-root） ============ */
  #skills-root {
    padding: var(--sp-3, 8px);
  }

  #skills-root .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--sp-3, 8px);
    gap: var(--sp-2, 6px);
  }

  #skills-root .header h2 {
    margin: 0;
    font-size: var(--font-lg, 14px);
  }

  #skills-root .header-actions {
    display: flex;
    gap: var(--sp-2, 6px);
  }

  #skills-root .header-actions .btn {
    font-size: var(--font-sm, 11px);
    padding: var(--sp-2, 6px) var(--sp-4, 10px);
  }

  #skills-root .hint {
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-sm, 11px);
    margin-bottom: var(--sp-3, 8px);
  }

  #skills-root .hint code {
    background: var(--surface-hover, rgba(128,128,128,.2));
    padding: 1px 4px;
    border-radius: var(--radius-sm, 2px);
    font-size: var(--font-sm, 11px);
  }

  #skills-root .skill-item {
    padding: var(--sp-3, 8px);
    margin-bottom: var(--sp-2, 6px);
    background: var(--surface-hover, rgba(128,128,128,.1));
    border: 1px solid var(--border-panel, rgba(128,128,128,.2));
    border-radius: var(--radius, 6px);
  }

  /* 用户技能：左侧绿色边框标识（语义令牌 --skill-user-accent，复用 status-pass 系） */
  #skills-root .skill-item.skill-user {
    border-left: 3px solid var(--skill-user-accent);
  }

  /* 内置技能：左侧蓝色边框标识（语义令牌 --skill-agent-accent = accent） */
  #skills-root .skill-item.skill-agent {
    border-left: 3px solid var(--skill-agent-accent);
  }

  #skills-root .skill-header {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    margin-bottom: var(--sp-1, 4px);
  }

  #skills-root .skill-name {
    margin: 0;
    font-size: var(--font-base, 13px);
    color: var(--text-primary, #cccccc);
  }

  /* 来源徽章 */
  #skills-root .skill-badge {
    font-size: var(--font-xs, 10px);
    font-weight: 500;
    padding: var(--sp-0, 2px) var(--sp-2, 6px);
    border-radius: var(--radius-lg, 8px);
    line-height: 1.4;
  }

  /* 内置徽章：surface-ai-avatar 底 + accent-foreground 字（与 cfg-icon 同语言） */
  #skills-root .skill-badge.badge-agent {
    color: var(--accent-foreground, #ffffff);
    background: var(--surface-ai-avatar);
  }

  /* 用户徽章：skill-user-accent 字 + 灰底 */
  #skills-root .skill-badge.badge-user {
    color: var(--skill-user-accent);
    background: var(--surface-hover, rgba(128,128,128,.2));
  }

  #skills-root .skill-trigger {
    font-size: var(--font-sm, 11px);
    color: var(--accent, #0e639c);
    background: var(--accent-subtle);
    padding: 1px 4px;
    border-radius: var(--radius-sm, 2px);
  }

  #skills-root .skill-desc {
    margin: 0 0 var(--sp-2, 6px) 0;
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    line-height: 1.4;
  }

  #skills-root .skill-keywords {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1, 4px);
  }

  #skills-root .keyword-chip {
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-hover, rgba(128,128,128,.2));
    padding: 1px 6px;
    border-radius: var(--radius-pill, 999px);
  }
`;
