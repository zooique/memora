/**
 * 技能视图样式 — 全局技能管理选项卡样式
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

  /* 纯图标按钮（打开目录/刷新，无文字标签）：
     紧凑方块（padding --sp-2 覆盖 .btn 的左右 12px），图标 flex 居中，hover 提示走 title */
  #skills-root .btn-icon-solo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-2, 6px);
  }
  #skills-root .btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: currentColor;
  }
  #skills-root .btn-icon svg {
    display: block;
  }

  #skills-root .hint {
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-sm, 11px);
    margin-bottom: var(--sp-3, 8px);
  }

  /* 空态提示内联图标（SVG）：
   * .hint 为左对齐说明文字，图标以 inline 内联、vertical-align 与文字基线对齐 */
  #skills-root .hint-icon { vertical-align: -2px; }

  #skills-root .hint code {
    background: var(--surface-hover, rgba(128,128,128,.2));
    padding: 1px 4px;
    border-radius: var(--radius-sm, 2px);
    font-size: var(--font-sm, 11px);
  }

  #skills-root .skill-item {
    padding: var(--sp-3, 8px);
    margin-bottom: var(--sp-2, 6px);
    /* 统一卡片外壳语言——surface-sidebar，与角色卡/Provider 卡/记忆卡对齐；
       边框不透明度 0.4，与 A 类卡片（角色/Provider/记忆）完全对齐 */
    background: var(--surface-sidebar);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
  }

  /* 禁用集「未找到需要禁用的技能」提示（非阻断弱化样式；
     复用既有 warn 语义令牌 --feedback-warn-*（chatStyles 澄清提示 same-form：前景+背景+border），
     不造新令牌——CSS 令牌单一真源（tokens.ts），禁硬编码） */
  #skills-root .skill-unmatched-tip {
    margin: 0 0 var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px);
    color: var(--feedback-warn-fg);
    background: var(--feedback-warn-bg);
    border-left: 3px solid var(--feedback-warn-accent);
    border-radius: var(--radius-sm, 2px);
  }

  /* 用户技能：左侧绿色边框标识（语义令牌 --skill-user-accent，复用 status-pass 系） */
  #skills-root .skill-item.skill-user {
    border-left: 3px solid var(--skill-user-accent);
  }

  /* 内置技能：左侧蓝色边框标识（语义令牌 --skill-agent-accent = accent） */
  #skills-root .skill-item.skill-agent {
    border-left: 3px solid var(--skill-agent-accent);
  }

  /* 角色包技能：左侧紫色边框标识（语义令牌 --skill-rolepack-accent，技能三分类） */
  #skills-root .skill-item.skill-rolepack {
    border-left: 3px solid var(--skill-rolepack-accent);
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

  /* 角色包徽章：skill-rolepack-accent 字 + 灰底（技能三分类） */
  #skills-root .skill-badge.badge-rolepack {
    color: var(--skill-rolepack-accent);
    background: var(--surface-hover, rgba(128,128,128,.2));
  }

  #skills-root .skill-desc {
    margin: 0 0 var(--sp-2, 6px) 0;
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    line-height: 1.4;
  }

  /* 写→验→用：健康徽章 + 问题列表（error=未生效 / warn=可优化） */
  #skills-root .health-badge {
    font-size: var(--font-xs, 10px);
    font-weight: 600;
    padding: 2px 6px;
    border-radius: var(--radius-pill, 999px);
    flex-shrink: 0;
  }
  #skills-root .health-badge.health-error {
    color: var(--accent-foreground, #ffffff);
    background: var(--skill-health-error);
  }
  #skills-root .health-badge.health-warn {
    color: var(--skill-health-warn);
    background: var(--surface-hover, rgba(128,128,128,.2));
  }
  /* 配置形态启停：已禁用徽章。语义 = 对模型不存在，仅 UI 对照显示
     （不隐藏条目，否则用户无法确认启停是否生效）。复用 health-warn 色 token：
     不取红（避免与「未生效」错误态混淆），不取纯灰（灰易被当成装饰忽略） */
  #skills-root .disabled-badge {
    font-size: var(--font-xs, 10px);
    font-weight: 600;
    padding: 2px 6px;
    border-radius: var(--radius-pill, 999px);
    flex-shrink: 0;
    color: var(--skill-health-warn);
    background: var(--surface-hover, rgba(128,128,128,.2));
  }

  /* 启停延长线开关：全局池技能卡片上的真实禁用开关。复用 settingsStyles
     .toggle-switch/-slider 的既有形态语言（40×22 轨道 + 16px 圆点 + focus-visible 描边），
     仅按 #skills-root 作用域重命名防串扰；配色全走既有 tokens（--border-panel 轨道 /
     --accent 开启 / --accent-foreground 圆点 / --border-focus 键盘焦点），**不开新令牌**
     （CSS 令牌单一真源，tokensClosure.test.ts 常驻守卫） */
  #skills-root .skill-disable-toggle {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
    flex-shrink: 0;
    margin-left: auto; /* 推至卡片头部右侧（徽章区左侧），与「查看正文」按钮同侧 */
  }
  #skills-root .skill-disable-toggle input { opacity: 0; width: 0; height: 0; }
  #skills-root .skill-disable-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background-color: var(--border-panel, rgba(128,128,128,.4));
    transition: .2s;
    border-radius: 22px;
  }
  #skills-root .skill-disable-slider:before {
    position: absolute;
    content: '';
    height: 16px;
    width: 16px;
    left: 3px;
    bottom: 3px;
    background-color: var(--accent-foreground, #ffffff);
    transition: .2s;
    border-radius: 50%;
  }
  #skills-root .skill-disable-toggle input:checked + .skill-disable-slider {
    background-color: var(--accent, #0e639c);
  }
  #skills-root .skill-disable-toggle input:checked + .skill-disable-slider:before {
    transform: translateX(18px);
  }
  #skills-root .skill-disable-toggle input:focus-visible + .skill-disable-slider {
    outline: 2px solid var(--border-focus, #0e639c);
    outline-offset: 2px;
  }

  /* 角色包技能的「随角色启停」说明：角色包技能对禁用清单免疫，
     卡片不渲染开关、以弱化说明文字代替——语义 = 与角色融为一体、随角色启停 */
  #skills-root .skill-rolepack-hint {
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    flex-shrink: 0;
    margin-left: auto; /* 与开关同侧占位，保持头部右侧元素居中对齐 */
  }
  #skills-root .skill-problems {
    list-style: none;
    margin: 0 0 var(--sp-2, 6px);
    padding: 0;
  }
  #skills-root .skill-problems li {
    font-size: var(--font-sm, 11px);
    margin-bottom: 2px;
    line-height: 1.4;
  }
  #skills-root .skill-problems .prob-error { color: var(--skill-health-error); }
  #skills-root .skill-problems .prob-warning { color: var(--skill-health-warn); }
`;
