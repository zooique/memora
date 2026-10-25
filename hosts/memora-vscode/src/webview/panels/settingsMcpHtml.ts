/**
 * 设置面板「MCP」选项卡 HTML 主体片段
 *
 * 为什么独立成文件（与 settingsSecurityHtml.ts 同款理由）：settingsPanel 是贴 eslint
 * max-lines 上限、只降不升的 TARGET 文件，而选项卡骨架是线性增长域；MCP 页还要随功能
 * 迭代长条目，留在大文件必爆线。
 *
 * 职责边界（同上）：**只提供静态 DOM 骨架，零逻辑、零插值变量**。列表渲染、表单与交互由
 * `scripts/mcpView.ts` 承担（数据经 `mcp_status` 消息下行），配置写入由
 * `panels/mcpServerOps.ts` 承担。
 *
 * **只使用全页面可用的 class**（`security-desc` / `loading-hint` / `btn` 等全局基线）：
 * `.hint` / `.empty-state` / `.footer-hint` 的选择符只挂在 roles/memory/config 三个 root 上
 * （CSS 注释明写 skills 是刻意不并入）⇒ MCP 页复用它们会渲染成裸文本。本页自有样式统一
 * 收在 `styles/mcpStyles.ts`（`#mcp-root` 前缀）。
 *
 * root 容器（`<div id="mcp-root">`）不由本片段自带——与其余选项卡一样由 settingsPanelHtml
 * 按 tab 表统一生成。
 */

/** MCP 选项卡主体（服务器状态 + 增删改停启 + 免确认点选 + 原生设置出口） */
export const MCP_BODY_HTML = `
    <div class="header">
      <div class="header-main">
        <h2>MCP 工具服务器</h2>
        <span id="mcpCount" class="stat-bar" hidden></span>
      </div>
      <div class="header-actions">
        <button id="mcpImportBtn" class="btn btn-secondary mcp-import-btn" type="button">从 JSON 导入</button>
        <button id="mcpAddBtn" class="btn btn-secondary mcp-add-btn" type="button">添加服务器</button>
      </div>
    </div>
    <p class="security-desc">MCP（Model Context Protocol）服务器给对话提供外部工具，工具名形如 <code>mcp__服务器名__工具名</code>。配置写在<strong>用户级</strong>设置里（随人、不随项目）——本页直接编辑它，不另存副本。</p>
    <div id="mcpList">
      <p class="loading-hint">加载中…</p>
    </div>
    <div id="mcpEmpty" hidden>
      <p class="security-desc" id="mcpEmptyDefault">还没有配置任何 MCP 服务器。添加一台后，它的工具会以 <code>mcp__服务器名__工具名</code> 出现在模型工具列表里；调用前默认每次都要你确认。</p>
      <p class="security-desc" id="mcpEmptyHidden" hidden>配置里有条目，但没有一条能显示成卡片（缺名称，或与前一条重名）。改好后会自动出现在这里；也可以直接删掉重加。具体是哪几条见下面那行提示。</p>
      <button class="btn btn-secondary mcp-add-btn" type="button">添加第一台服务器</button>
    </div>
    <p id="mcpOmitted" class="mcp-omitted" hidden></p>
    <p class="security-desc">免确认只是不弹窗，<strong>每次调用仍写审计</strong>。支持两级：单个工具勾选（只放行该工具），或整台服务器的「整台免确认」（放行这台的全部工具）。没有「一次放行所有服务器」的开关——每台都要单独授权。删除服务器不会连带清掉它的免确认记录（重新添加同名服务器时自动恢复）。</p>
    <div class="mcp-footer">
      <button class="btn btn-ghost open-setting-btn" type="button" data-setting-key="memora.mcpServers">高级：在 settings.json 中编辑</button>
    </div>
`;
