/**
 * settingsPanelHtml — 设置面板 webview 静态骨架（自 settingsPanel.ts 拆出）
 *
 * **为什么拆（与 settingsSecurityHtml.ts 同款理由）**：settingsPanel 是贴 eslint
 * max-lines 上限的 TARGET 文件（**只降不升**，见根 eslint.config.mjs 的存量清单）。
 * 静态骨架是典型的线性增长域——每加一个选项卡就多一屏 HTML，留在大文件必爆线。
 * 拆出后「加一个选项卡」不再消耗 settingsPanel 的行 budgets（只加一行 tab id + 一本 body）。
 *
 * 职责边界（与 settingsSecurityHtml.ts 同）：**只提供静态 DOM 骨架，零逻辑**。交互全部由
 * settingsPanel.ts 的消息处理与 webview 侧 settingsView.ts 承担；本模块不读状态、不插值动态
 * 数据（唯一插值 = 构建期常量 {@link MEMORY_RECYCLE_RETENTION_DAYS} 与 scriptUri）。
 *
 * **tab 按钮与 root 容器不再手写**：由 {@link SETTINGS_TABS} 驱动生成，顺序与 id 同源于
 * `shared/settingsTabs.ts`。此前 5 个按钮 + 5 个 root 各写一遍，且与脚本侧 / 协议侧的 tab
 * 联合类型互不相同源（已漂移出「路由不到 security 页」的洞）。现在：新增 tab id ⇒ 缺
 * body / 缺可见名 = 编译红，编译期兜住而不是上线后点了没反应。
 */
import * as vscode from 'vscode';
import { buildHtmlHead, resolveHtmlLang } from '../helpers/htmlShell.js';
import { settingsStyles } from '../styles/settingsStyles.js';
import { MCP_BODY_HTML } from './settingsMcpHtml.js';
import { SECURITY_BODY_HTML } from './settingsSecurityHtml.js';
// 回收站清理天数是弹窗文案与按钮 title 同一句的事实来源（宿主常量，不在这里写死数字）
import { MEMORY_RECYCLE_RETENTION_DAYS } from '../../shared/constants.js';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  SETTINGS_TAB_ARIA_LABELS,
  SETTINGS_TAB_LABELS,
  settingsRootId,
  type SettingsTab,
} from '../../shared/settingsTabs.js';

/**
 * 各选项卡主体骨架（**不含外层 root 容器**——root 与 tab 按钮均由 {@link buildHtml} 统一生成）
 *
 * `Record` 穷尽性 = 机器化的「不许漏」：加了 tab id 却忘了给主体 ⇒ 编译不过。
 */
const TAB_BODY_HTML: Record<SettingsTab, string> = {
  memory: `  <!-- 记忆子视图（memory 选项卡，默认首页） -->
    <div class="header">
      <h2>记忆</h2>
      <span id="statBar" class="stat-bar" hidden></span>
    </div>
    <div class="search-wrap">
      <input id="searchInput" class="search-input" type="text" placeholder="搜索记忆…" aria-label="搜索记忆" />
    </div>
    <div id="list">
      <p class="loading-hint">加载中…</p>
    </div>

    <!-- 回收站：软删除记忆的可恢复暂存区 -->
    <details id="recycle" class="recycle" role="region" aria-label="回收站">
      <summary>回收站</summary>
      <div id="recycleList"><p class="hint">回收站为空。</p></div>
    </details>
    <p id="memHint" class="mem-hint" hidden></p>

    <!-- 记忆治理区：统计卡 + 加权/清理操作 -->
    <div id="governance" class="governance" role="region" aria-label="记忆治理">
      <div class="governance-stats">
        <div class="governance-stat">
          <span id="govActive" class="gov-num">0</span>
          <span class="gov-label">活跃</span>
        </div>
        <div class="governance-stat">
          <span id="govDeleted" class="gov-num">0</span>
          <span class="gov-label">回收站</span>
        </div>
        <div class="governance-stat">
          <span id="govSuperseded" class="gov-num">0</span>
          <span class="gov-label">已被取代</span>
        </div>
      </div>
      <div class="governance-actions">
        <button id="btnCleanup" class="btn btn-danger" title="永久删除 ${MEMORY_RECYCLE_RETENTION_DAYS} 天前的软删除记忆（不可撤销）">清理过期</button>
      </div>
      <p id="govDetail" class="governance-detail" hidden></p>
    </div>

    <!-- 会话归档模式：内核 archiveMode 投影（full=自动归档 / manual=仅手动；设置即热更新，繁忙顺延） -->
    <div id="archiveMode" class="archive-mode" role="region" aria-label="会话归档">
      <div class="archive-mode-item">
        <label class="security-label" for="archiveModeSelect">会话归档模式</label>
        <select id="archiveModeSelect" class="security-select" aria-label="会话归档模式">
          <option value="full">自动归档</option>
          <option value="manual">仅手动归档</option>
        </select>
      </div>
      <p class="security-desc">自动归档：切换 / 分叉离开会话时自动生成会话摘要与主题（历史列表的检索数据）；仅手动归档：只在手动触发时生成。<strong>轮次摘要不受影响</strong>（总是生成，对话记忆照常沉淀）。对话进行中切换时，内核拒绝热改——偏好保存后到当前对话结束生效。</p>
    </div>

    <p class="footer-hint">记忆按重要度排序，点击条目查看全文。</p>`,
  roles: `  <!-- 角色子视图（roles 选项卡） -->
    <div class="header">
      <h2>角色</h2>
      <span id="statBar" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnOpenRolePacksDir" class="btn btn-secondary btn-icon-solo" title="打开用户角色包目录">
          <span class="btn-icon" data-icon="folder"></span>
        </button>
        <button id="btnRefreshRolePacks" class="btn btn-secondary btn-icon-solo" title="刷新角色包列表（重扫用户角色包目录）">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
    </div>
    <div id="list">
      <p class="loading-hint">加载中…</p>
    </div>
    <p class="footer-hint">「设为当前」仅切换默认角色；「带入对话」还会跳到对话并预填一句过渡语（不自动发送，可编辑后再发）。</p>`,
  config: `  <!-- 大模型配置子视图（config 选项卡） -->
    <div class="header">
      <h2>大模型配置</h2>
      <span id="statBar" class="stat-bar" hidden></span>
      <button id="btnAdd" class="btn">添加 API</button>
    </div>
    <!-- 模型通道分区：后台 + 检索归入显式分区，与 Provider 列表的 group-title 语言一致 -->
    <div class="group-title">模型通道</div>
    <!-- 后台模型通道（多 Provider 路由）：后台任务（摘要/归档/润色）独立轻量模型 -->
    <div class="cfg-bg">
      <label for="bgModel" class="cfg-bg-label">后台模型（可选）</label>
      <select id="bgModel" class="cfg-bg-select" aria-label="后台模型，用于后台任务（摘要/归档/润色）">
        <option value="">同实时对话</option>
      </select>
      <p class="cfg-bg-hint">后台任务（轮次摘要 / 会话归档 / 文本润色 / 语义去重）走此模型，可选用轻量快模型节省成本。</p>
    </div>
    <div id="list">
      <p class="loading-hint">加载中…</p>
    </div>
    <!-- 新增/编辑弹窗 -->
    <div id="modal" class="modal-mask">
      <div class="modal">
        <h3 id="modalTitle">添加 API</h3>
        <form id="cfgForm">
          <div class="field">
            <label for="f-name">别名（唯一，仅英文数字.-_）</label>
            <input id="f-name" name="name" type="text" placeholder="如 deepseek" autocomplete="off" />
          </div>
          <div class="field">
            <label for="f-display">显示名称</label>
            <input id="f-display" name="displayName" type="text" placeholder="如 DeepSeek" autocomplete="off" />
          </div>
          <div class="field">
            <label for="f-model">模型</label>
            <input id="f-model" name="model" type="text" placeholder="如 deepseek-chat" autocomplete="off" />
          </div>
          <div class="field">
            <label for="f-baseurl">API Base URL</label>
            <input id="f-baseurl" name="baseUrl" type="url" placeholder="https://api.xiaomimimo.com/v1" autocomplete="url" />
          </div>
          <div class="field">
            <label for="f-apikey">API Key（编辑时留空保持不变）</label>
            <input id="f-apikey" name="apiKey" type="password" placeholder="sk-…" autocomplete="new-password" />
            <div id="apikeyHint" class="key-hint" hidden></div>
          </div>
          <div class="field">
            <label for="f-providertype">来源类型</label>
            <select id="f-providertype" name="provider">
              <option value="cloud">云端 API（DeepSeek / 豆包 / 通义等）</option>
              <option value="local">本地运行时（Ollama / LM Studio）</option>
            </select>
            <div class="key-hint">云端服务商默认启用原生工具调用；本地运行时是否支持工具调用由下方显式声明（无法从地址推断）。</div>
          </div>
          <div id="toolcalling-field" class="field" hidden>
            <label class="checkbox-label" for="f-toolcalling">
              <input id="f-toolcalling" name="supportsToolCalling" type="checkbox" checked />
              <span>支持原生工具调用（OpenAI Function Calling）</span>
            </label>
            <div class="key-hint">勾选：本地模型可调用工具（联网搜索 / 读写文件 / 建记忆等）；取消：仅文本对话，工具通道自动收起并告知模型不可用。</div>
          </div>
          <!-- 视觉能力位：与工具能力位不同，**不随来源类型显隐**——
               同一个 OpenAI 兼容接口下 gpt-4o 看得见图、deepseek-chat 看不懂，云端/本地都无法推断，
               故恒由用户显式声明，且默认不勾选（失败必闭：宁可被明确拒收，不可被静默丢图）。 -->
          <div id="vision-field" class="field">
            <label class="checkbox-label" for="f-vision">
              <input id="f-vision" name="supportsVision" type="checkbox" />
              <span>支持图片输入（多模态视觉理解）</span>
            </label>
            <div class="key-hint">勾选：该模型能看懂图片（如 GPT-4o / Claude 3.5 / Gemini 等视觉模型）。未勾选时发送图片会被明确拒收，不会被静默丢弃；<strong>请勿在不确定的情况下勾选</strong>——误标为「看得见」而实际看不懂，AI 会答非所问且你无法归因。</div>
          </div>
          <div class="field">
            <label for="f-contextwindow">上下文窗口上限（K）</label>
            <input id="f-contextwindow" name="contextWindow" type="text" inputmode="decimal" placeholder="如 128（留空用默认窗口）" autocomplete="off" />
            <div class="key-hint">填千单位（K），如 128 表示 128K = 128,000 tokens；支持小数（如 1.5）；留空使用内核默认窗口（以内核常量为真源，此处不写死数字）。</div>
            <div id="f-contextwindow-feedback" class="key-hint" hidden></div>
          </div>
          <div class="field">
            <label for="f-maxtokens">输出上限（K）</label>
            <input id="f-maxtokens" name="maxTokens" type="text" inputmode="decimal" placeholder="如 64（留空用服务端默认）" autocomplete="off" />
            <div class="key-hint">模型单次回复的最大输出 token 数（含思考占用），如 64 = 64,000 tokens（K = ×1000，与上下文上限同口径）；留空 = 不传 max_tokens、由服务端默认。<span class="hint-warn-icon" data-icon="warning" role="img" aria-label="注意"></span>推理模型思考与正文共享输出预算，留空极易触发空响应，建议必填（mimo v2.6 建议 32–64K）；填后仍截断可再调大（超模型上限由服务端报错，不会静默生效）。</div>
            <div id="f-maxtokens-feedback" class="key-hint" hidden></div>
          </div>
          <div id="testResult" class="test-result" hidden></div>
          <div class="modal-actions">
            <button id="btnTest" type="button" class="btn btn-secondary">测试连接</button>
            <button id="btnCancel" type="button" class="btn btn-secondary">取消</button>
            <button id="btnSave" type="submit" class="btn">保存</button>
          </div>
        </form>
      </div>
    </div>`,
  skills: `  <!-- 技能子视图（skills 选项卡） -->
    <div class="header">
      <h2>全局技能</h2>
      <span id="skillCount" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnOpenSkillsDir" class="btn btn-secondary btn-icon-solo" title="打开用户技能目录">
          <span class="btn-icon" data-icon="folder"></span>
        </button>
        <button id="btnRefreshSkills" class="btn btn-secondary btn-icon-solo" title="刷新技能列表">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
    </div>
    <div class="hint">全局技能是所有角色包共享的能力。支持单文件 <code>.md</code> 和文件夹 <code>SKILL.md</code> 两种格式。</div>
    <div id="skillsList">
      <p class="loading-hint">加载中…</p>
    </div>
    <p class="footer-hint">用户技能目录：<code>VS Code 全局存储 / skills /</code></p>`,
  mcp: MCP_BODY_HTML,
  security: SECURITY_BODY_HTML,
};

/** 选项卡按钮栏（顺序、默认高亮、`aria-selected` 全部由 tab 表派生） */
function buildTabButtons(): string {
  return SETTINGS_TABS.map((tab) => {
    const active = tab === DEFAULT_SETTINGS_TAB;
    return `    <button class="tab-btn${active ? ' active' : ''}" data-tab="${tab}" role="tab" aria-selected="${String(active)}">${SETTINGS_TAB_LABELS[tab]}</button>`;
  }).join('\n');
}

/** 子视图根容器 + 主体（默认首页不 `hidden`，其余默认隐藏；id 由 {@link settingsRootId} 派生） */
function buildTabPanels(): string {
  return SETTINGS_TABS.map((tab) => {
    const hidden = tab === DEFAULT_SETTINGS_TAB ? '' : ' hidden';
    return `  <div id="${settingsRootId(tab)}" class="tab-panel" role="tabpanel" aria-label="${SETTINGS_TAB_ARIA_LABELS[tab]}"${hidden}>\n${TAB_BODY_HTML[tab]}\n  </div>`;
  }).join('\n\n');
}

/**
 * 构造设置面板 webview 的完整 HTML
 *
 * @param scriptUri 外部脚本 settingsView.js 的 asWebviewUri（CSP script-src cspSource 加载）
 * @param cspSource webview 本地资源源（webview.cspSource，供 CSP 放行外部脚本）
 */
export function buildHtml(scriptUri: vscode.Uri, cspSource: string): string {
  return `${buildHtmlHead({
    lang: resolveHtmlLang(vscode.env?.language),
    cspSource,
    styles: settingsStyles,
  })}
<body>
  <div class="tabs" role="tablist" aria-label="设置选项卡">
${buildTabButtons()}
  </div>

${buildTabPanels()}

  <script src="${scriptUri}"></script>
</body>
</html>`;
}
