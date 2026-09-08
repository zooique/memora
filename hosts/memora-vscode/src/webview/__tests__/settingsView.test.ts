/**
 * settingsView 测试 — 设置视图选项卡切换 + 子视图挂载（2026-08-17 选项卡合并）
 *
 * 覆盖设置视图（合并 角色 / 大模型 / 记忆 三个子视图）的新增行为：
 *   - 挂载即发送三个子视图的初始消息（cfg_load / memory_load / ready）
 *   - 初始选项卡为「角色」（roles-root 可见，config/memory 隐藏）
 *   - 点击选项卡按钮切换（config-root 显示 + 按钮高亮 + aria-selected）
 *   - settings_switch_tab 消息切换（configureModel 命令路径）
 *   - id 空间隔离：各子视图数据只渲染进各自根容器（不跨根串扰）
 * 用 jsdom 环境 + 注入 mock acquireVsCodeApi，通过 createSettingsView 工厂驱动。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createSettingsView } from '../scripts/settingsView.js';
import type { MemoryItemDto } from '../../shared/protocol.js';

/** 覆盖 createSettingsView 全部查询引用 + 五个子视图骨架的最小 HTML（默认选项卡为「记忆」） */
const HTML = `
  <div class="tabs">
    <button class="tab-btn active" data-tab="memory">记忆</button>
    <button class="tab-btn" data-tab="roles">角色</button>
    <button class="tab-btn" data-tab="config">大模型</button>
    <button class="tab-btn" data-tab="skills">技能</button>
    <button class="tab-btn" data-tab="security">安全</button>
  </div>
  <div id="memory-root">
    <div class="header"><h2>记忆</h2><span id="statBar" class="stat-bar" hidden></span></div>
    <div class="search-wrap"><input id="searchInput" class="search-input" type="text" placeholder="搜索记忆…" /></div>
    <div id="list"><p class="hint">加载中…</p></div>
    <p class="footer-hint">记忆按重要度排序，点击条目查看全文。</p>
  </div>
  <div id="roles-root" hidden>
    <div class="header"><h2>角色</h2><span id="statBar" class="stat-bar" hidden></span></div>
    <div id="list"><p class="hint">加载中…</p></div>
    <p class="footer-hint">角色决定对话定位与可用能力，切换后长期生效。</p>
  </div>
  <div id="config-root" hidden>
    <div class="header"><h2>大模型配置</h2><span id="statBar" class="stat-bar" hidden></span><button id="btnAdd" class="btn">添加 API</button></div>
    <div class="cfg-bg"><label for="bgModel">后台模型（可选）</label><select id="bgModel"><option value="">同实时对话</option></select><p class="cfg-bg-hint"></p></div>
    <details id="embeddingCfg" class="embedding-cfg"><summary>向量检索（Embedding，可选）</summary><div class="embedding-fields"><div class="field"><input id="e-model" type="text" /><input id="e-baseurl" type="url" /><input id="e-apikey" type="password" /></div><div class="embedding-actions"><button id="btnSaveEmbedding"></button><button id="btnClearEmbedding"></button></div><p id="embeddingStatus" hidden></p></div></details>
    <div id="list"></div>
    <div id="modal" class="modal-mask">
      <div class="modal">
        <h3 id="modalTitle"></h3>
        <form id="cfgForm">
          <input id="f-name" /><input id="f-display" /><input id="f-model" /><input id="f-baseurl" /><input id="f-apikey" />
          <input id="f-contextwindow" type="text" />
          <div id="f-contextwindow-feedback" hidden></div>
          <div id="apikeyHint" hidden></div><div id="testResult" hidden></div>
          <button id="btnTest" type="button"></button><button id="btnCancel" type="button"></button><button id="btnSave" type="submit"></button>
        </form>
      </div>
    </div>
    <div id="toast"></div>
  </div>
  <div id="skills-root" hidden>
    <div class="header"><h2>全局技能</h2><span id="skillCount" class="stat-bar" hidden></span><div class="header-actions"><button id="btnOpenSkillsDir" class="btn btn-secondary btn-icon-text"><span class="btn-icon" data-icon="folder"></span><span>打开目录</span></button><button id="btnRefreshSkills" class="btn btn-secondary btn-icon-text"><span class="btn-icon" data-icon="refresh"></span><span>刷新</span></button></div></div>
    <div id="skillsList"><p class="hint">加载中…</p></div>
  </div>
  <div id="security-root" hidden>
    <div class="header"><h2>安全设置</h2></div>
    <div class="security-section">
      <label class="toggle-label">
        <input type="checkbox" id="confirmWritesToggle" />
        <span>写入二次确认</span>
      </label>
      <label class="toggle-label">
        <input type="checkbox" id="confirmScriptsToggle" />
        <span>脚本执行二次确认</span>
      </label>
      <p id="securityStatus" class="security-status" hidden></p>
      <select id="searchEngineSelect">
        <option value="auto">自动</option>
        <option value="bing">必应</option>
        <option value="baidu">百度</option>
        <option value="sogou">搜狗</option>
      </select>
    </div>
  </div>
`;

/** 挂载 createSettingsView 并返回 postMessage mock */
function mountSettingsView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  createSettingsView({
    acquireVsCodeApi: () => ({ postMessage }),
    window: window as unknown as Window,
  });
  return { postMessage };
}

describe('settingsView 选项卡切换（2026-08-17 合并角色/大模型/记忆）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即发送三个子视图的初始消息（cfg_load / memory_load / ready）', () => {
    const { postMessage } = mountSettingsView();
    // 挂载顺序 config → memory → roles（roles 的 ready 在末尾，host 据此整体就绪）
    expect(postMessage).toHaveBeenCalledWith({ type: 'cfg_load' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'memory_load' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('初始选项卡为「记忆」（默认首页）：memory-root 可见，roles/config 隐藏', () => {
    mountSettingsView();
    expect((document.getElementById('memory-root') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('roles-root') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('config-root') as HTMLElement).hidden).toBe(true);
  });

  it('点击选项卡按钮切换：config-root 显示、memory 隐藏、按钮高亮', () => {
    mountSettingsView();
    const configBtn = document.querySelector('.tab-btn[data-tab="config"]') as HTMLButtonElement;
    configBtn.click();
    expect((document.getElementById('config-root') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('memory-root') as HTMLElement).hidden).toBe(true);
    expect(configBtn.classList.contains('active')).toBe(true);
    expect(configBtn.getAttribute('aria-selected')).toBe('true');
    // 原激活按钮（记忆）取消高亮
    expect(
      document.querySelector('.tab-btn[data-tab="memory"]')?.classList.contains('active'),
    ).toBe(false);
  });

  it('settings_switch_tab 消息切换选项卡（configureModel 命令路径）', () => {
    mountSettingsView();
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'settings_switch_tab', tab: 'roles' } }),
    );
    expect((document.getElementById('roles-root') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('memory-root') as HTMLElement).hidden).toBe(true);
    expect(
      document.querySelector('.tab-btn[data-tab="roles"]')?.classList.contains('active'),
    ).toBe(true);
  });

  it('id 空间隔离：各子视图数据只渲染进各自根容器（不跨根串扰）', () => {
    mountSettingsView();
    // 角色数据 → 只进 roles-root
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'roles_loaded',
          packs: [{ name: 'doc-review', displayName: '文档打磨', capabilities: [] }],
          activeName: 'doc-review',
          teams: [],
          maxTeamMembers: 4,
        },
      }),
    );
    expect(document.querySelector('#roles-root .card')).not.toBeNull();
    expect(document.querySelector('#roles-root .card-name')?.textContent).toContain('文档打磨');
    // 大模型数据 → 只进 config-root（roles-root 不受影响）
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'cfg_loaded',
          providers: [
            {
              name: 'deepseek',
              displayName: 'DeepSeek',
              model: 'deepseek-chat',
              baseUrl: 'https://api.example.com/v1',
              apiKey: '',
              provider: 'remote',
            },
          ],
          activeName: 'deepseek',
        },
      }),
    );
    expect(document.querySelector('#config-root .card')).not.toBeNull();
    expect(document.querySelector('#config-root .card-name')?.textContent).toContain('DeepSeek');
    // roles-root 卡片未被 config 数据污染
    expect(document.querySelector('#roles-root .card-name')?.textContent).toContain('文档打磨');
    // 记忆数据 → 只进 memory-root
    const mem: MemoryItemDto = {
      id: 'round-summary:设计决策',
      name: '设计决策',
      source: 'round-summary',
      score: 0.9,
      content: '确认合并选项卡。',
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'memory_loaded', stats: { total: 1, bySource: { 'round-summary': 1 } }, memories: [mem] },
      }),
    );
    expect(document.querySelector('#memory-root .mem-card')).not.toBeNull();
    expect(document.querySelector('#memory-root .mem-card-name')?.textContent).toContain('设计决策');
  });

  it('网页搜索引擎下拉（方案 A）：变更发 search_engine_set，host 回推 search_engine_status 回显', () => {
    const { postMessage } = mountSettingsView();
    // 初始为 auto（无 host 推送时不强制）
    const select = document.getElementById('searchEngineSelect') as HTMLSelectElement;
    // 切换 → 通知 host
    select.value = 'baidu';
    select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'search_engine_set', engine: 'baidu' });
    // host 回推当前选择 → 下拉回显
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'search_engine_status', engine: 'sogou' } }),
    );
    expect(select.value).toBe('sogou');
  });
});

describe('脚本执行二次确认开关（security_scripts_toggle，2026-09-08）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('security_status 推送双开关初始状态（confirmWrites + confirmScripts 各自回显）', () => {
    mountSettingsView();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'security_status', confirmWrites: true, confirmScripts: true },
      }),
    );
    expect((document.getElementById('confirmWritesToggle') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('confirmScriptsToggle') as HTMLInputElement).checked).toBe(true);
    const statusEl = document.getElementById('securityStatus') as HTMLElement;
    expect(statusEl.textContent).toContain('写文件前审批');
    expect(statusEl.textContent).toContain('脚本执行前审批');
  });

  it('切换脚本确认开关 → 发送 security_scripts_toggle + 更新状态文案', () => {
    const { postMessage } = mountSettingsView();
    const scriptsToggle = document.getElementById('confirmScriptsToggle') as HTMLInputElement;
    scriptsToggle.checked = true;
    scriptsToggle.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'security_scripts_toggle', enabled: true });
    expect((document.getElementById('securityStatus') as HTMLElement).textContent).toContain('运行脚本/代码前将弹出审批卡');
  });

  it('host 单独回推 confirmScripts=false 只改脚本开关、不影响写开关', () => {
    mountSettingsView();
    // 先置双开
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'security_status', confirmWrites: true, confirmScripts: true },
      }),
    );
    // 再单独关脚本确认
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'security_status', confirmWrites: true, confirmScripts: false },
      }),
    );
    expect((document.getElementById('confirmWritesToggle') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('confirmScriptsToggle') as HTMLInputElement).checked).toBe(false);
  });
});

describe('技能分页（2026-09-08 通用分页组件，全量前端切片）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** 构造技能 DTO（定宽名保证 localeCompare 排序符合数值序，避免 skill-10 < skill-2 错位） */
  function makeSkill(i: number): { name: string; description: string; layer: 'builtin' } {
    return { name: `skill-${String(i).padStart(2, '0')}`, description: `技能 ${i} 描述`, layer: 'builtin' };
  }

  /** 分发 skills_loaded */
  function dispatchSkills(skills: unknown[]): void {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'skills_loaded', skills } }),
    );
  }

  it('skills_loaded 15 个 → 第 1 页渲染 10 张卡片 + 分页条「第 1 / 2 页（共 15 条）」', () => {
    mountSettingsView();
    dispatchSkills(Array.from({ length: 15 }, (_, i) => makeSkill(i)));
    const items = document.querySelectorAll('.skill-item');
    expect(items).toHaveLength(10); // SKILL_PAGE_SIZE=10
    expect(items[0]?.querySelector('.skill-name')?.textContent).toBe('skill-00');
    const bar = document.querySelector('#skills-root .pager-bar') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.pager-info')?.textContent).toBe('第 1 / 2 页（共 15 条）');
  });

  it('点击「下一页」→ 前端切片渲染第 2 页（5 张，纯本地无 IPC 请求）', () => {
    mountSettingsView();
    dispatchSkills(Array.from({ length: 15 }, (_, i) => makeSkill(i)));
    const nextBtn = document.querySelectorAll<HTMLButtonElement>('#skills-root .pager-btn')[1]!;
    nextBtn.click();
    const items = document.querySelectorAll('.skill-item');
    expect(items).toHaveLength(5);
    expect(items[0]?.querySelector('.skill-name')?.textContent).toBe('skill-10');
    expect(document.querySelector('#skills-root .pager-info')?.textContent).toBe('第 2 / 2 页（共 15 条）');
  });

  it('技能数 ≤ 10 → 分页条自动隐藏（小数据量无分页 UI）', () => {
    mountSettingsView();
    dispatchSkills(Array.from({ length: 6 }, (_, i) => makeSkill(i)));
    expect((document.querySelector('#skills-root .pager-bar') as HTMLElement).hidden).toBe(true);
    expect(document.querySelectorAll('.skill-item')).toHaveLength(6);
  });
});
