/**
 * 设置面板「MCP」子视图样式 — 外部工具服务器观察面
 *
 * 设计（对齐 ITCSS + tokens.ts 单一真理源，同 roles/skills 范式）：
 *   - 一律以 `#mcp-root` 前缀限定，与其他子视图样式隔离——`.header` / `.card` 等
 *     共享类名靠根容器前缀隔离，**勿写成全局选择符**（会波及别家选项卡既有视觉）；
 *   - 复用 tokens.ts 设计令牌（sp-* / font-* / surface-sidebar / line-solid）；
 *   - 视觉语言对齐安全页：surface-sidebar 卡片壳 + line-solid 行分隔 + sp-* 间距。
 *
 * 为什么补这个文件（2026-10-24）：MCP 页首版只落了 HTML 骨架 / 渲染逻辑 / 协议 /
 * 测试，**样式整层缺失**——`.header` 无 flex、`.stat-bar` 无定义、`.mcp-*` 类零规则。
 * DOM 测试只查结构不查计算样式 ⇒ 全绿也照样裸奔。子视图样式按 root 分文件是本仓
 * 既有架构（见 settingsStyles.ts 头部注释），故补独立文件而非往大文件里堆。
 */

export const mcpStyles = `
  /* ============ MCP：工具服务器子视图（#mcp-root） ============ */
  /* 垂直节奏交给容器：本页有三块页级说明文字（简介 / 空态 / 免确认纪律），
   * 原先各自 \`margin: 0\`（.security-desc 是卡片内文案的类，天生无外边距）
   * ⇒ 三块紧贴成一片、空态 CTA 黏在段落尾巴上（2026-10-24 真机截图）。
   * 统一用 gap 建立节奏，而不是给每块补 margin（后者必漏一处）。
   * **不加左右 padding**：兄弟 root（memory / roles / config / skills）都不加，页头分隔线
   * 才能满宽、切 tab 时标题不横向跳（左右对齐由页头与页级文字各自的 12px 承担）。 */
  #mcp-root {
    display: flex; flex-direction: column; gap: var(--sp-3, 8px);
    padding-bottom: var(--sp-5, 12px);
  }

  /* 页头（与 memory/config/roles 同构：flex 行 + 底部分隔线 + h2 字号） */
  #mcp-root .header {
    display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px);
    padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: var(--line-solid);
  }
  #mcp-root .header h2 { font-size: var(--font-lg, 14px); margin: 0; }
  /* 计数徽条（与兄弟 root 同款：右对齐小字；margin-left:auto 把条推到行尾） */
  #mcp-root .stat-bar { font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); margin-left: auto; }

  /* 页级文字与页头标题同基线（页头 h2 左缘 = .header 自身 12px；这里同样 12px）：
   * 之前正文贴根边缘、标题缩进 12px，左侧参差。卡片不参与——卡片与兄弟 tab 一样
   * 贴根边缘（.card 自带内边距，再缩进会让整页像被套了两层框）。 */
  #mcp-root > .security-desc,
  #mcp-root > #mcpEmpty,
  #mcp-root > #mcpOmitted,
  #mcp-root > .mcp-footer { padding-left: var(--sp-5, 12px); padding-right: var(--sp-5, 12px); }
  /* 页级说明是长段落：用「宽松正文」行高（tokens 里 --lh-relaxed 的注释就写明用途 =
   * 空态/提示/长段落），snug(1.5) 在 11px 中文上偏挤 */
  #mcp-root .security-desc { line-height: var(--lh-relaxed); }

  /* 空态：说明与 CTA 之间留一档，按钮不再咬住段落 */
  #mcp-root #mcpEmpty {
    display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-3, 8px);
  }

  /* 服务器卡片：复用 .tab-panel .card 外壳，内部改纵向堆叠（卡片基类是横向 flex） */
  #mcp-root .mcp-server { flex-direction: column; gap: var(--sp-2, 6px); }
  /* 列表末张卡片的 margin-bottom 归零：容器 gap 已给 8px，卡片基类的 8px 会叠成 16px，
   * 表现为「卡片列表与下面那段文字之间突然多一道空隙」（兄弟 tab 无容器 gap ⇒ 无此断层） */
  #mcp-root #mcpList > .card:last-child { margin-bottom: 0; }
  #mcp-root .mcp-server-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2, 6px); }
  #mcp-root .mcp-server-name { margin: 0; font-size: var(--font-md, 12px); font-weight: 600; color: var(--text-primary); }
  #mcp-root .mcp-server-count { font-size: var(--font-xs, 10px); color: var(--text-secondary); flex-shrink: 0; }

  /* 工具行：派生名 + 免确认开关两端对齐；行间上边线分隔（首行不加——贴着卡片头） */
  #mcp-root .mcp-tool-list { list-style: none; margin: 0; padding: 0; }
  #mcp-root .mcp-tool-row {
    display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px);
    padding: var(--sp-1, 4px) 0;
    border-top: var(--line-solid);
  }
  #mcp-root .mcp-tool-row:first-child { border-top: none; }
  /* 派生名（模型可见名）等宽 + 徽章底，与正文区分；对齐 skills-root .hint code 同款 */
  #mcp-root .mcp-tool-name { min-width: 0; font-size: var(--font-sm, 11px); color: var(--text-primary); }
  #mcp-root .mcp-tool-name code {
    background: var(--surface-hover, rgba(128,128,128,.2));
    padding: var(--sp-hair, 1px) var(--sp-1, 4px);
    border-radius: var(--radius-sm, 2px);
    font-size: var(--font-sm, 11px);
    font-family: var(--font-mono);
  }
  /* 改名工具标注原名：解释「为什么两处名字不一样」，次级色小字 */
  #mcp-root .mcp-tool-orig { color: var(--text-secondary); }
  #mcp-root .mcp-allow-toggle {
    display: inline-flex; align-items: center; gap: var(--sp-1, 4px); flex-shrink: 0;
    font-size: var(--font-sm, 11px); color: var(--text-secondary); cursor: pointer;
  }
  #mcp-root .mcp-allow-check { cursor: pointer; }

  /* ── 页头：标题组（h2 + 计数）与右侧动作组（导入 + 添加）并排 ── */
  #mcp-root .header-main { display: flex; align-items: baseline; gap: var(--sp-2, 6px); min-width: 0; }
  #mcp-root .header-actions { display: flex; align-items: center; gap: var(--sp-2, 6px); flex-shrink: 0; }

  /* ── 状态点 / 状态徽标（五态语义色；data-state 与 STATE_LABELS 同源） ──
   * 形状区别而不只靠颜色：实心绿=连上、实心红=失败、实心灰=待接入、空心=停用、
   * 方块=配置错（色盲可辨）。 */
  #mcp-root .mcp-dot {
    width: var(--sp-2, 6px); height: var(--sp-2, 6px); border-radius: 50%; flex-shrink: 0;
    background: var(--text-secondary);
  }
  #mcp-root .mcp-dot[data-state='running'] { background: var(--chart-green, #4caf50); }
  #mcp-root .mcp-dot[data-state='failed'] { background: var(--status-fail, #f14c4c); }
  /* 待接入：实心灰（= 默认色，显式写出来免得后人以为漏了态） */
  #mcp-root .mcp-dot[data-state='pending'] { background: var(--text-secondary); }
  #mcp-root .mcp-dot[data-state='disabled'] { background: transparent; border: 1px solid var(--text-secondary); }
  #mcp-root .mcp-dot[data-state='invalid'] {
    background: var(--feedback-warn-fg, #d7ba7d); border-radius: var(--radius-sm, 2px);
  }
  #mcp-root .mcp-server-state {
    font-size: var(--font-xs, 10px); padding: 0 var(--sp-1, 4px); border-radius: var(--radius-sm, 2px);
    color: var(--text-secondary); flex-shrink: 0;
  }
  #mcp-root .mcp-server-state[data-state='running'] { color: var(--chart-green, #4caf50); }
  #mcp-root .mcp-server-state[data-state='failed'] { color: var(--status-fail, #f14c4c); }
  #mcp-root .mcp-server-state[data-state='invalid'] { color: var(--feedback-warn-fg, #d7ba7d); }

  /* ── 命令摘要：等宽、可截断（长命令不撑破卡片） ── */
  #mcp-root .mcp-server-cmd {
    font-family: var(--font-mono); font-size: var(--font-xs, 10px); color: var(--text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto;
  }

  /* ── 失败原因：整行铺开、允许换行（错误文本是排查入口，不能截成一行） ── */
  #mcp-root .mcp-server-error {
    margin: 0; padding: var(--sp-1, 4px) var(--sp-2, 6px);
    font-family: var(--font-mono); font-size: var(--font-xs, 10px);
    color: var(--feedback-error-fg, #f48771); background: var(--feedback-error-bg, #442726);
    border-radius: var(--radius-sm, 2px); white-space: pre-wrap; word-break: break-word;
  }

  /* ── 待接入提示：中性色，与失败原因刻意不同色（没试过 ≠ 失败） ── */
  #mcp-root .mcp-server-note {
    margin: 0; font-size: var(--font-xs, 10px); color: var(--text-secondary);
  }

  /* ── 被隐藏条目（配置里有、列表里没有）：警示色但**不上错误底色** ──
   * 语义与 failed 不同：不是「跑不起来」，是「面板画不出来」。
   * 用文字色 + 小字号表达，避免与失败原因（红底等宽）混成同一类故障。 */
  #mcp-root .mcp-omitted {
    margin: 0; font-size: var(--font-xs, 10px);
    color: var(--feedback-warn-fg, #d7ba7d); line-height: var(--lh-relaxed);
  }

  /* ── 动作行 ── */
  #mcp-root .mcp-actions { display: flex; gap: var(--sp-2, 6px); flex-wrap: wrap; }

  /* ── 编辑表单 ──
   * 输入控件刻意**不重画边框/底色**：webview 里原生 input/textarea 已由 VS Code 主题
   * 驱动，自己再上一套边框等于养第二套配色（真机换主题必漂）。这里只补布局与字体。 */
  #mcp-root .mcp-form { display: flex; flex-direction: column; gap: var(--sp-2, 6px); }
  #mcp-root .mcp-field { display: flex; flex-direction: column; gap: var(--sp-1, 4px); }
  #mcp-root .mcp-label { font-size: var(--font-sm, 11px); color: var(--text-primary); }
  #mcp-root .mcp-hint { margin-left: var(--sp-2, 6px); font-size: var(--font-xs, 10px); color: var(--text-secondary); }
  #mcp-root .mcp-input {
    width: 100%; box-sizing: border-box; padding: var(--sp-1, 4px) var(--sp-2, 6px);
    font-size: var(--font-md, 12px); font-family: inherit;
  }
  #mcp-root .mcp-input[readonly] { color: var(--text-secondary); cursor: not-allowed; }
  #mcp-root .mcp-textarea { font-family: var(--font-mono); font-size: var(--font-sm, 11px); resize: vertical; }
  #mcp-root .mcp-check {
    display: inline-flex; align-items: center; gap: var(--sp-1, 4px);
    font-size: var(--font-sm, 11px); color: var(--text-secondary); cursor: pointer;
  }
  #mcp-root .mcp-warn { margin: 0; font-size: var(--font-xs, 10px); color: var(--feedback-warn-fg, #d7ba7d); }
  #mcp-root .mcp-form-error { margin: 0; font-size: var(--font-sm, 11px); color: var(--feedback-error-fg, #f48771); }
  #mcp-root .mcp-form-actions { display: flex; gap: var(--sp-2, 6px); }

  /* ── 导入卡片：与编辑表单同壳，纵向堆叠 ── */
  #mcp-root .mcp-import-card { flex-direction: column; gap: var(--sp-2, 6px); }
  /* 导入结果：逐条明细必须保留换行（一条一行），等宽弱底色与失败原因区分开
   * ——部分成功不是错误，不该穿错误底色 */
  #mcp-root .mcp-import-result {
    margin: 0; padding: var(--sp-1, 4px) var(--sp-2, 6px);
    font-size: var(--font-xs, 10px); color: var(--text-primary);
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
    border-radius: var(--radius-sm, 2px); white-space: pre-wrap; word-break: break-word;
  }

  /* ── 页脚：原生设置出口（降级为「高级」，不再是唯一门） ── */
  #mcp-root .mcp-footer { display: flex; justify-content: flex-end; padding-top: var(--sp-2, 6px); }
`;
