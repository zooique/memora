/**
 * 设置面板「安全」选项卡 HTML 片段
 *
 * 为什么独立成文件（自 settingsPanel.ts 拆出）：settingsPanel 是贴 eslint max-lines
 * 上限的 TARGET 文件（只降不升），而安全页每加一个配置项入口就多一段静态 HTML，
 * 是典型的线性增长域，留在大文件必爆线（同 hostDiagnostics.ts / injectionBodies.ts 先例）。
 *
 * 职责边界：本模块只提供静态 DOM 骨架，零逻辑。交互（开关读写、路径增删、引擎测试、
 * open_setting 导航）全部由 settingsPanel.ts 的 handleMessage 与 webview 侧子视图承担。
 * 片段内不得出现插值变量——一旦需要动态数据，说明它该留在 settingsPanel 或走消息通道。
 */

/** 安全子视图（security 选项卡：写入审批 / 路径白名单 / 搜索引擎 / 调试与提示入口） */
export const SECURITY_ROOT_HTML = `
  <!-- 安全子视图（security 选项卡：写入审批） -->
  <div id="security-root" role="tabpanel" aria-label="安全" hidden>
    <div class="header">
      <h2>安全</h2>
    </div>
    <div class="security-section">
      <div class="security-item">
        <div class="security-item-header">
          <label for="confirmWritesToggle" class="security-label">写入二次确认</label>
          <label class="toggle-switch">
            <input id="confirmWritesToggle" type="checkbox" role="switch" aria-label="写入二次确认开关" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="security-desc">开启后，AI 写文件前会弹出审批卡，需确认放行。默认关闭（owner 模式自动批准）。</p>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label for="confirmScriptsToggle" class="security-label">执行二次确认</label>
          <label class="toggle-switch">
            <input id="confirmScriptsToggle" type="checkbox" role="switch" aria-label="脚本与命令执行二次确认开关" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="security-desc">开启后，AI 运行脚本/代码（run_project_script / run_code）或执行普通 shell 命令（run_command）前会弹出审批卡，需确认放行。默认关闭（自动放行）。仅控制「是否询问」，不影响能力本身（这些能力始终开放）。<strong>注意：git 写操作（commit / push / reset / rebase / merge）与 npm publish 不受本开关影响，每次都会询问、且无法豁免</strong>——它们属于不可逆操作。</p>
      </div>
      <div id="securityStatus" class="security-status" hidden></div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">允许路径白名单</label>
        </div>
        <p class="security-desc">项目目录始终允许访问。可添加项目之外的可信目录（如个人笔记、文档），Agent 即可读写；增删即时生效，重启后仍保留。敏感文件（.env/.ssh 等）黑名单仍强制拦截。</p>
        <ul id="allowedPathsList" class="allowed-paths-list"></ul>
        <div class="allowed-paths-add">
          <input id="allowedPathsInput" type="text" class="allowed-paths-input" placeholder="输入目录绝对路径，如 D:/我的笔记" aria-label="新增允许路径" />
          <button id="allowedPathsAdd" class="btn btn-secondary" type="button">添加</button>
        </div>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label" for="searchEngineSelect">网页搜索引擎</label>
        </div>
        <p class="security-desc">「联网搜索」工具使用的内部搜索后端。自动 = Bing 优先降级 DuckDuckGo；中文场景推荐切「百度/搜狗」提升命中质量。也可选用下方自定义引擎。修改后需重载窗口生效。</p>
        <select id="searchEngineSelect" class="security-select" aria-label="网页搜索引擎"></select>
        <p class="security-desc">自定义引擎需返回结构化结果：OpenSearch RSS / Atom，或 JSON（<code>{results:[{title,url,…}]}</code>）。普通网页（一堆 HTML）与需登录的平台不支持。点「编辑」填写后先「测试」再「保存」。</p>
        <div id="customSearchEngines" class="custom-search-engines"></div>
        <button id="addCustomEngineBtn" class="btn btn-secondary ce-add-btn" type="button">+ 添加自定义搜索引擎</button>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">脚本解释器（node 路径）</label>
          <button class="btn btn-secondary open-setting-btn" type="button" data-setting-key="memora.scriptNodePath">在设置中调整</button>
        </div>
        <p class="security-desc">技能脚本与项目脚本使用的 node 解释器。留空时走系统 PATH；若脚本报「spawn node ENOENT」（找不到 node），在此填写 node 可执行文件的绝对路径。修改后需重载窗口生效。</p>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">活动指标（调试）</label>
          <button class="btn btn-secondary open-setting-btn" type="button" data-setting-key="memora.showMetrics">在设置中调整</button>
        </div>
        <p class="security-desc">活动抽屉里的 LLM 调用次数 / token / 安全审计 / 指纹等调试信息。默认隐藏；开启后从下一轮对话起在抽屉展示。</p>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">提醒提示音</label>
          <button class="btn btn-secondary open-setting-btn" type="button" data-setting-key="memora.attentionSound">在设置中调整</button>
        </div>
        <p class="security-desc">对话面板不在前台时，审批卡推出 / AI 提问等待 / 一轮完成会播放系统提示音。默认开启；关闭后完全静音，面板内徽章与未读不受影响。</p>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">恢复初始状态</label>
        </div>
        <p class="security-desc">一键清空插件的<strong>全部用户级数据</strong>：用户技能、用户角色包、大模型配置（含 API Key）、激活角色包、角色包组、安全开关与用户级设置，恢复到第一次使用插件的状态。<strong>项目数据完整保留</strong>：当前项目的记忆、会话记录（.memora/）与项目设置不动——它们已经是项目的一部分。清理完成后将自动重载窗口，进行中的对话会中断。</p>
        <button id="resetUserDataBtn" class="btn btn-danger security-reset-btn" type="button">清空用户级数据…</button>
        <span id="resetUserDataHint" class="security-status security-reset-hint" hidden></span>
      </div>
    </div>
  </div>
`;
