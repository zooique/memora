/**
 * settingsView 测试 — 设置视图选项卡切换 + 子视图挂载（选项卡合并）
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSettingsView } from '../scripts/settingsView.js';
import type { CustomSearchEngineConfig, MemoryItemDto } from '../../shared/protocol.js';
// MCP 子视图骨架**直接取产线同一份常量**（不再手抄一份夹具镜像）：手抄镜像会随产线演进
// 静默失同步，而失同步的表现是「测试全绿、真机少一块」——正是这类夹具要防的东西。
import { MCP_BODY_HTML } from '../panels/settingsMcpHtml.js';
import { settingsRootId } from '../../shared/settingsTabs.js';

/** MCP 面板容器（root id 由 tab 表派生，不写死字符串） */
const MCP_FIXTURE = `<div id="${settingsRootId('mcp')}" hidden>${MCP_BODY_HTML}</div>`;

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
    <div id="archiveMode" class="archive-mode">
      <select id="archiveModeSelect">
        <option value="full">自动归档</option>
        <option value="manual">仅手动归档</option>
      </select>
    </div>
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
    <div id="list"></div>
    <div id="modal" class="modal-mask">
      <div class="modal">
        <h3 id="modalTitle"></h3>
        <form id="cfgForm">
          <input id="f-name" /><input id="f-display" /><input id="f-model" /><input id="f-baseurl" /><input id="f-apikey" />
          <select id="f-providertype"><option value="cloud">云端</option><option value="local">本地</option></select>
          <div id="toolcalling-field"><label class="checkbox-label" for="f-toolcalling"><input id="f-toolcalling" type="checkbox" /></label></div>
          <input id="f-contextwindow" type="text" />
          <div id="f-contextwindow-feedback" hidden></div>
          <input id="f-maxtokens" type="text" />
          <div id="f-maxtokens-feedback" hidden></div>
          <div id="apikeyHint" hidden></div><div id="testResult" hidden></div>
          <button id="btnTest" type="button"></button><button id="btnCancel" type="button"></button><button id="btnSave" type="submit"></button>
        </form>
      </div>
    </div>
  </div>
  <div id="skills-root" hidden>
    <div class="header"><h2>全局技能</h2><span id="skillCount" class="stat-bar" hidden></span><div class="header-actions"><button id="btnOpenSkillsDir" class="btn btn-secondary btn-icon-solo" title="打开用户技能目录"><span class="btn-icon" data-icon="folder"></span></button><button id="btnRefreshSkills" class="btn btn-secondary btn-icon-solo" title="刷新技能列表"><span class="btn-icon" data-icon="refresh"></span></button></div></div>
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
      <button class="btn btn-secondary open-setting-btn" type="button" data-setting-key="memora.showMetrics">在设置中调整</button>
    </div>
  </div>
  ${MCP_FIXTURE}
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

  it('设置项导航按钮：点击发送 open_setting（配置读写真源在原生设置，设置页只导航）', () => {
    const { postMessage } = mountSettingsView();
    const btn = document.querySelector('.open-setting-btn') as HTMLButtonElement;
    btn.click();
    // 键名来自 data-setting-key，新增同类按钮零 JS 改动（统一绑定）
    expect(postMessage).toHaveBeenCalledWith({
      type: 'open_setting',
      key: 'memora.showMetrics',
    });
    // 只投递一次：绑定若同时存在于容器层与子视图（双重绑定），这里会变 2（host 重复开设置）
    expect(
      postMessage.mock.calls.filter((c) => (c[0] as { type?: string }).type === 'open_setting'),
    ).toHaveLength(1);
  });

  it('settings_switch_tab 消息切换选项卡（configureModel 命令路径）', () => {
    mountSettingsView();
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'settings_switch_tab', tab: 'roles' } }),
    );
    expect((document.getElementById('roles-root') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('memory-root') as HTMLElement).hidden).toBe(true);
    expect(document.querySelector('.tab-btn[data-tab="roles"]')?.classList.contains('active')).toBe(
      true,
    );
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
      content: '确认合并选项卡。',
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'memory_loaded',
          stats: { total: 1, bySource: { 'round-summary': 1 } },
          memories: [mem],
        },
      }),
    );
    expect(document.querySelector('#memory-root .mem-card')).not.toBeNull();
    // 正文预览为主位（name 撤位）：用 content 断言渲染进的是这条记忆
    expect(document.querySelector('#memory-root .mem-card-preview')?.textContent).toContain(
      '确认合并选项卡。',
    );
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

  it('会话归档模式下拉：变更发 archive_mode_set，host 回推 archive_mode_status 回显', () => {
    const { postMessage } = mountSettingsView();
    const select = document.getElementById('archiveModeSelect') as HTMLSelectElement;
    // 切换 → 通知 host（持久化 + 热更新 + 回推全在 host 侧）
    select.value = 'manual';
    select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'archive_mode_set', mode: 'manual' });
    // host 回推持久值 → 下拉回显（ busy 顺延语义由 notice 说明，不伪造已生效）
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'archive_mode_status', mode: 'full' } }),
    );
    expect(select.value).toBe('full');
  });
});

describe('脚本执行二次确认开关（security_toggle target=confirmScripts，2026-10-24 协议治理合并）', () => {
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
    expect((document.getElementById('confirmScriptsToggle') as HTMLInputElement).checked).toBe(
      true,
    );
    const statusEl = document.getElementById('securityStatus') as HTMLElement;
    expect(statusEl.textContent).toContain('写文件前审批');
    // 2026-10-03：开关语义已含 run_command（普通命令），文案随之改判——
    // 原「脚本执行前审批」漏了命令执行这一档，对用户是安全承诺失实
    expect(statusEl.textContent).toContain('脚本/命令执行前审批');
  });

  it('切换脚本确认开关 → 发送 security_toggle(target=confirmScripts) + 更新状态文案', () => {
    const { postMessage } = mountSettingsView();
    const scriptsToggle = document.getElementById('confirmScriptsToggle') as HTMLInputElement;
    scriptsToggle.checked = true;
    scriptsToggle.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'security_toggle',
      target: 'confirmScripts',
      enabled: true,
    });
    expect((document.getElementById('securityStatus') as HTMLElement).textContent).toContain(
      '运行脚本/代码前将弹出审批卡',
    );
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
    expect((document.getElementById('confirmScriptsToggle') as HTMLInputElement).checked).toBe(
      false,
    );
  });
});

describe('技能分页（2026-09-08 通用分页组件，全量前端切片）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** 构造技能 DTO（定宽名保证 localeCompare 排序符合数值序，避免 skill-10 < skill-2 错位） */
  function makeSkill(i: number): { name: string; description: string; layer: 'builtin' } {
    return {
      name: `skill-${String(i).padStart(2, '0')}`,
      description: `技能 ${i} 描述`,
      layer: 'builtin',
    };
  }

  /** 分发 skills_loaded */
  function dispatchSkills(skills: unknown[]): void {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'skills_loaded', skills } }));
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
    expect(document.querySelector('#skills-root .pager-info')?.textContent).toBe(
      '第 2 / 2 页（共 15 条）',
    );
  });

  it('已禁用徽章（S4 启停）：disabled=true 渲染「已禁用」且**条目保留**，未禁用不渲染', () => {
    mountSettingsView();
    dispatchSkills([
      { name: 'skill-on', description: '启用中的技能', layer: 'builtin' },
      { name: 'skill-off', description: '已禁用的技能', layer: 'builtin', disabled: true },
    ]);
    // 5 处注释声称「宿主 UI 标注已禁用徽章」而实现为零 →
    // 用户无法确认启停是否生效。本用例锁住徽章存在 + 条目不被隐藏（两条都要）。
    const off = document.querySelector('.skill-item[data-skill-name="skill-off"]');
    const on = document.querySelector('.skill-item[data-skill-name="skill-on"]');
    expect(off).not.toBeNull(); // 不隐藏：静默消失会让人误判「启停没做」
    expect(off?.querySelector('.disabled-badge')?.textContent).toBe('已禁用');
    expect(on?.querySelector('.disabled-badge')).toBeNull();
  });

  it('技能数 ≤ 10 → 分页条自动隐藏（小数据量无分页 UI）', () => {
    mountSettingsView();
    dispatchSkills(Array.from({ length: 6 }, (_, i) => makeSkill(i)));
    expect((document.querySelector('#skills-root .pager-bar') as HTMLElement).hidden).toBe(true);
    expect(document.querySelectorAll('.skill-item')).toHaveLength(6);
  });

  it('D 未匹配提示：unmatchedDisabled 有值 → 渲染「未找到需要禁用的技能」提示行', () => {
    mountSettingsView();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'skills_loaded',
          skills: [makeSkill(0)],
          unmatchedDisabled: ['typo-skill', 'ghost-skill'],
        },
      }),
    );
    const tip = document.querySelector('#skills-root .skill-unmatched-tip');
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toContain('未找到需要禁用的技能');
    expect(tip?.textContent).toContain('typo-skill、ghost-skill');
  });

  it('D 未匹配提示：空/undefined → 不渲染提示行（不打扰正常清单）', () => {
    mountSettingsView();
    dispatchSkills([makeSkill(0)]);
    expect(document.querySelector('#skills-root .skill-unmatched-tip')).toBeNull();
  });
});

describe('技能禁用延长线开关（S4 E，2026-09-22）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** 分发 skills_loaded（三源任意层） */
  function dispatchSkills(skills: unknown[]): void {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'skills_loaded', skills } }));
  }

  it('builtin/user 技能卡片渲染真实开关；disabled=true → checked（与「已禁用」徽章同态对照）', () => {
    mountSettingsView();
    dispatchSkills([
      { name: 's1', description: '启用中的内置技能', layer: 'builtin' },
      { name: 's2', description: '已禁用的用户技能', layer: 'user', disabled: true },
    ]);
    const s1Toggle = document.querySelector(
      '.skill-item[data-skill-name="s1"] .skill-disable-check',
    ) as HTMLInputElement | null;
    const s2Toggle = document.querySelector(
      '.skill-item[data-skill-name="s2"] .skill-disable-check',
    ) as HTMLInputElement | null;
    expect(s1Toggle).not.toBeNull();
    expect(s1Toggle?.checked).toBe(false);
    expect(s2Toggle).not.toBeNull();
    expect(s2Toggle?.checked).toBe(true);
  });

  it('rolepack 技能不渲染开关、渲染「随角色启停」说明（对禁用清单免疫，2026-09-22 定案）', () => {
    mountSettingsView();
    dispatchSkills([{ name: 'rp', description: '角色包技能', layer: 'rolepack' }]);
    const rpItem = document.querySelector('.skill-item[data-skill-name="rp"]') as HTMLElement;
    expect(rpItem.querySelector('.skill-disable-check')).toBeNull();
    expect(rpItem.querySelector('.skill-rolepack-hint')?.textContent).toContain('随角色启停');
  });

  it('点击开关 → 发送 toggle_skill_disabled；不做本地乐观翻转（「已禁用」徽章不上屏，等回推）', () => {
    const { postMessage } = mountSettingsView();
    dispatchSkills([{ name: 's1', description: '技能', layer: 'builtin' }]);
    const toggle = document.querySelector(
      '.skill-item[data-skill-name="s1"] .skill-disable-check',
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    toggle.click(); // 原生 click 翻转 checked 并触发 change（change 冒泡被 listEl 委托捕获）
    expect(postMessage).toHaveBeenCalledWith({
      type: 'toggle_skill_disabled',
      name: 's1',
      disabled: true,
    });
    // 未本地乐观更新：点击后「已禁用」徽章不得立即出现（以 host skills_loaded 回推渲染为准）
    expect(toggle.closest('.skill-item')?.querySelector('.disabled-badge')).toBeNull();
  });
});

describe('settingsView 全局通知 toast（settingsPanel→notice 断链补全，2026-09-19）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('notice(info) → 渲染 #settings-toast 并显示文案与 .show', () => {
    mountSettingsView();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'notice', level: 'info', message: '已切换网页搜索引擎' },
      }),
    );
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.textContent).toBe('已切换网页搜索引擎');
    expect(toast.classList.contains('show')).toBe(true);
    expect(toast.classList.contains('error')).toBe(false);
  });

  it('notice(error) 标红 + 2500ms 后自动隐藏（重触发需 clearTimeout 重置）', () => {
    mountSettingsView();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'notice', level: 'error', message: '角色包不存在：x' },
      }),
    );
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast.classList.contains('error')).toBe(true);
    vi.advanceTimersByTime(2500);
    expect(toast.classList.contains('show')).toBe(false);
  });

  it('textContent 渲染防注入（XXS：`<img onerror>` 不进 DOM）', () => {
    mountSettingsView();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'notice', level: 'info', message: '<img src=x onerror=alert(1)>' },
      }),
    );
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast.querySelector('img')).toBeNull();
    expect(toast.textContent).toContain('<img');
  });

  it('CSS 源码守卫（UI-TOAST-1 三面收口）：z 层对齐 z-bar + error 变体令牌 + config 平行形态已删', () => {
    // jsdom 无布局引擎证不了「盖不盖模态」——层序契约用源码守卫钉住（同 chatStyles 的
    // toast 浮层守卫口径）：抓「规则被删 / 令牌被换 / 平行形态复活」三类回归。
    const styles = readFileSync(join(__dirname, '..', 'styles', 'settingsStyles.ts'), 'utf8');
    const configStyles = readFileSync(join(__dirname, '..', 'styles', 'configStyles.ts'), 'utf8');
    const panelHtml = readFileSync(join(__dirname, '..', 'panels', 'settingsPanelHtml.ts'), 'utf8');
    const tokens = readFileSync(join(__dirname, '..', 'styles', 'tokens.ts'), 'utf8');
    // ① z 层：toast 站「输入区与 toast」档（低于全屏遮罩 --z-overlay ⇒ 模态在场不盖遮罩）
    expect(styles).toMatch(/\.settings-toast \{[^}]*z-index: var\(--z-bar\)/);
    expect(styles).not.toMatch(/\.settings-toast \{[^}]*z-index: var\(--z-overlay\)/);
    // ② error 变体令牌在位（与 chat 活动条 error 态同族）
    expect(styles).toMatch(/\.settings-toast\.error \{[^}]*var\(--feedback-error-toast-bg\)/);
    // ③ config 平行形态（#toast + ok/err/visible + --toast-ok-bg）不得复活
    expect(configStyles).not.toContain('#config-root #toast');
    expect(panelHtml).not.toContain('id="toast"');
    expect(tokens).not.toContain('--toast-ok-bg');
  });
});

/**
 * 技能正文翻页重渲染防注入
 *
 * 背景：renderSkillItems 走 innerHTML 拼接，其中「已缓存正文」分支（contentMap 命中）
 * 是唯一把外部可控文本（用户技能目录下的 .md 正文）原样注入 innerHTML 的路径；
 * 同一份正文在首次加载（skill_content 消息）与点击展开时都走 textContent，唯翻页重渲染例外。
 * 危害等级受限于 webview CSP（default-src 'none' → 脚本不可执行），但 style-src 仍
 * 'unsafe-inline'，未转义注入可造成 DOM 结构破坏与 UI 伪装，故按「同一数据两个汇点」
 * 的不一致收口为必测项。
 */
describe('技能正文翻页重渲染防注入（HOST-S16）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 分发 skills_loaded（15 条 → 触发分页，为「翻页重渲染」提供入口） */
  function dispatchSkills(skills: unknown[]): void {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'skills_loaded', skills } }));
  }

  it('翻页回第 1 页：已缓存正文原样转义落 DOM（不产生 <b>/<img> 元素）', () => {
    mountSettingsView();
    dispatchSkills(
      Array.from({ length: 15 }, (_, i) => ({
        name: `skill-${String(i).padStart(2, '0')}`,
        description: `技能 ${i}`,
        layer: 'builtin',
      })),
    );
    // 首次加载正文（走 textContent 安全路径）→ 写入 contentMap 缓存
    const payload = '<b>粗体</b><img src=x onerror=alert(1)>';
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'skill_content', skillName: 'skill-00', content: payload },
      }),
    );
    // 翻到第 2 页再回第 1 页 → 触发 renderSkillItems 重渲染（命中缓存 → innerHTML 分支）
    const btns = document.querySelectorAll<HTMLButtonElement>('#skills-root .pager-btn');
    btns[1]!.click();
    btns[0]!.click();

    const contentEl = document.querySelector('.skill-item .skill-content') as HTMLElement;
    expect(contentEl.querySelector('b')).toBeNull();
    expect(contentEl.querySelector('img')).toBeNull();
    expect(contentEl.textContent).toBe(payload);
  });
});

describe('自定义搜索引擎（host/searchEngines 单一嫁接点，2026-10-13）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const EXTENDED_HTML = `
    <div class="tabs">
      <button class="tab-btn" data-tab="security">安全</button>
    </div>
    <div id="security-root">
      <select id="searchEngineSelect"></select>
      <div id="customSearchEngines"></div>
      <button id="addCustomEngineBtn" type="button">添加</button>
    </div>
  `;

  const MY_SITE: CustomSearchEngineConfig = {
    name: 'MySite',
    urlTemplate: 'https://mysite.com/s?q={query}',
    parseStrategy: 'jsonApi',
  };

  function mountExtended(): { postMessage: ReturnType<typeof vi.fn> } {
    document.body.innerHTML = EXTENDED_HTML;
    const postMessage = vi.fn();
    createSettingsView({
      acquireVsCodeApi: () => ({ postMessage }),
      window: window as unknown as Window,
    });
    return { postMessage };
  }

  function pushStatus(engines: CustomSearchEngineConfig[]): void {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'custom_search_engines_status', engines } }),
    );
  }
  function clickOne(sel: string): void {
    (document.querySelector(sel) as HTMLButtonElement).click();
  }
  /** 修改展开表单的输入并派发 input（模拟真实键入，触发草稿回写） */
  function fillDraft(name: string, url: string): void {
    const card = document.querySelector<HTMLElement>('.custom-engine.expanded')!;
    const nameInput = card.querySelector<HTMLInputElement>('.ce-name')!;
    const urlInput = card.querySelector<HTMLInputElement>('.ce-url')!;
    nameInput.value = name;
    nameInput.dispatchEvent(new Event('input'));
    urlInput.value = url;
    urlInput.dispatchEvent(new Event('input'));
  }

  it('custom_search_engines_status 重建下拉（预设 + 自定义）并渲染紧凑清单行', () => {
    mountExtended();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'custom_search_engines_status',
          engines: [
            {
              name: 'MySite',
              urlTemplate: 'https://mysite.com/s?q={query}',
              parseStrategy: 'jsonApi',
            },
          ],
        },
      }),
    );
    const select = document.getElementById('searchEngineSelect') as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => o.value);
    expect(opts).toContain('auto');
    expect(opts).toContain('bing');
    expect(opts).toContain('duckduckgo'); // 锁死：预设含 duckduckgo（旧 enum 漏列，宿主枚举比内核窄的带伤）
    expect(opts).toContain('MySite'); // 自定义名进入下拉
    // 收起态：每引擎一行、无编辑表单 ⇒ 不再线性膨胀
    expect(document.querySelectorAll('#customSearchEngines .custom-engine')).toHaveLength(1);
    expect(document.querySelectorAll('#customSearchEngines .ce-editor')).toHaveLength(0);
  });

  it('点击「+ 添加」→ 只落本地草稿并展开表单，不发消息（修复 host「（空）配置无效」误报）', () => {
    const { postMessage } = mountExtended();
    clickOne('#addCustomEngineBtn');
    // 关键：空白草稿行不再被提交，故不会触发 host 校验失败（旧实现每次点击都报错）
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'custom_search_engines_set' }),
    );
    expect(document.querySelectorAll('.custom-engine.expanded')).toHaveLength(1);
  });

  it('编辑已有引擎 → 点「保存」才提交一次 custom_search_engines_set（显式保存）', () => {
    const { postMessage } = mountExtended();
    pushStatus([MY_SITE]);
    postMessage.mockClear(); // 清掉 mount 期的 ready 等初始消息
    clickOne('.ce-edit'); // 展开
    // 展开与逐字段编辑均不发消息 ⇒ 中间态不会触发探针/报错
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'custom_search_engines_set' }),
    );
    fillDraft('MySite2', 'https://mysite.com/s?q={query}&v=2');
    clickOne('.ce-save');
    expect(postMessage).toHaveBeenCalledTimes(1); // 一次保存 = 一轮探针
    expect(postMessage).toHaveBeenCalledWith({
      type: 'custom_search_engines_set',
      engines: [
        {
          name: 'MySite2',
          urlTemplate: 'https://mysite.com/s?q={query}&v=2',
          parseStrategy: 'jsonApi',
        },
      ],
    });
  });

  it('保存被 host 拒绝（回推状态与提交不一致）→ 草稿保留，改完可重试', () => {
    const { postMessage } = mountExtended();
    pushStatus([MY_SITE]);
    clickOne('.ce-edit');
    fillDraft('MySite2', 'https://mysite.com/s?q={query}&v=2');
    clickOne('.ce-save');
    postMessage.mockClear();
    pushStatus([MY_SITE]); // host 拒绝：回推的仍是持久化时的旧清单
    expect(document.querySelectorAll('.custom-engine.expanded')).toHaveLength(1);
    expect(
      document.querySelector<HTMLInputElement>('.custom-engine.expanded .ce-name')?.value,
    ).toBe('MySite2');
  });

  it('自定义引擎下拉切换 → 发 search_engine_set（去硬编码守卫，自定义名可推送）', () => {
    const { postMessage } = mountExtended();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'custom_search_engines_status',
          engines: [
            {
              name: 'MySite',
              urlTemplate: 'https://mysite.com/s?q={query}',
              parseStrategy: 'jsonApi',
            },
          ],
        },
      }),
    );
    const select = document.getElementById('searchEngineSelect') as HTMLSelectElement;
    select.value = 'MySite';
    select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'search_engine_set', engine: 'MySite' });
  });

  it('展开后点「测试」→ 回推 custom_search_engine_test（携带当前表单配置）', () => {
    const { postMessage } = mountExtended();
    pushStatus([MY_SITE]);
    clickOne('.ce-edit'); // 收起态无表单，展开后才出现「测试」
    clickOne('.ce-test');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'custom_search_engine_test',
      engine: MY_SITE,
    });
  });

  it('custom_search_engine_test_result → 回显到展开的编辑区并点亮状态点', () => {
    mountExtended();
    pushStatus([MY_SITE]);
    clickOne('.ce-edit');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'custom_search_engine_test_result',
          result: { engineName: 'MySite', ok: true, count: 3 },
        },
      }),
    );
    const status = document.querySelector<HTMLElement>('.custom-engine.expanded .ce-test-status');
    expect(status?.textContent).toContain('验证通过');
    expect(status?.className).toContain('ok');
    expect(document.querySelector('.custom-engine.expanded .ce-dot')?.className).toContain('ok');
  });

  it('custom_search_engine_test_result → 渲染 sample 样例（防协议字段悬空变僵尸）', () => {
    mountExtended();
    pushStatus([MY_SITE]);
    clickOne('.ce-edit');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'custom_search_engine_test_result',
          result: {
            engineName: 'MySite',
            ok: true,
            count: 2,
            sample: [
              { title: '结果一', url: 'https://a.test/1' },
              { title: '结果二', url: 'https://b.test/2' },
            ],
          },
        },
      }),
    );
    const items = document.querySelectorAll<HTMLElement>('.custom-engine.expanded .ce-sample li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('结果一 · https://a.test/1');
  });

  it('点「取消」→ 丢弃草稿回到收起态（持久化清单不受影响）', () => {
    const { postMessage } = mountExtended();
    pushStatus([MY_SITE]);
    clickOne('#addCustomEngineBtn'); // 新增本地草稿行
    expect(document.querySelectorAll('.custom-engine')).toHaveLength(2);
    clickOne('.ce-cancel');
    expect(document.querySelectorAll('.custom-engine')).toHaveLength(1);
    expect(document.querySelectorAll('.custom-engine.expanded')).toHaveLength(0);
    // 取消不产生任何持久化请求（ready 除外）
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'custom_search_engines_set' }),
    );
  });
});

describe('MCP 选项卡（五态观察面 + 增删改停启，2026-10-24 交互重构）', () => {
  /** 推一次 host 状态给 webview（omitted 缺省 = 全部可见，与真实派生在无隐藏时一致） */
  function pushStatus(
    servers: unknown[],
    omitted: { configured: number; missingName: number; duplicate: number } = {
      configured: servers.length,
      missingName: 0,
      duplicate: 0,
    },
    ack?: unknown,
  ): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'mcp_status', servers, omitted, ...(ack ? { ack } : {}) },
      }),
    );
  }

  /** 一台在跑的 server（含两个工具：一个已免确认、一个派生名与原名不同） */
  const RUNNING = {
    name: 'fs',
    command: 'npx',
    args: ['-y', 'server-filesystem'],
    enabled: true,
    state: 'running',
    toolCount: 2,
    tools: [
      {
        originalName: 'read-file',
        derivedName: 'mcp__fs__read_file',
        allowKey: 'mcp__fs__read-file',
        allowlisted: true,
      },
      {
        originalName: 'write_file',
        derivedName: 'mcp__fs__write_file',
        allowKey: 'mcp__fs__write_file',
        allowlisted: false,
      },
    ],
  };

  /** 点击第一个匹配元素 */
  function clickOne(selector: string): void {
    const el = document.querySelector<HTMLElement>(selector);
    expect(el).not.toBeNull();
    el!.click();
  }

  /** 返回 MCP 根容器 */
  function mcpRoot(): HTMLElement {
    return document.getElementById('mcp-root') as HTMLElement;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载不发拉取消息（纯推送渲染：首屏数据走 host ready 握手统一推送）', () => {
    const { postMessage } = mountSettingsView();
    // 2026-10-24 协议治理：mcp_status_load 通道并入 ready 推送（协议计数触阈值）。
    // 断链守护：若有人把「拉取」加回来，此断言红——拉取模式会让面板在 host 未就绪时
    // 发出无人应答的消息，且白占一条协议通道。
    const mcpPosts = postMessage.mock.calls.filter((c) =>
      String((c[0] as { type?: string }).type).startsWith('mcp_'),
    );
    expect(mcpPosts).toEqual([]);
  });

  it('运行态：计数徽条 / 状态点 / 免确认勾选态 / 改名工具标出原名', () => {
    mountSettingsView();
    pushStatus([RUNNING]);
    expect((document.getElementById('mcpCount') as HTMLElement).textContent).toBe(
      '1 台 · 1 已连接 · 2 个工具',
    );
    expect(mcpRoot().querySelector('.mcp-dot')?.getAttribute('data-state')).toBe('running');
    expect(mcpRoot().querySelectorAll('.mcp-tool-row')).toHaveLength(2);
    // 免确认态由 host 下发，UI 不自行推断
    const boxes = Array.from(mcpRoot().querySelectorAll<HTMLInputElement>('.mcp-allow-check'));
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(mcpRoot().querySelector('.mcp-tool-orig')?.textContent).toContain('read-file');
    // 命令摘要 = command + args（不含 env）
    expect(mcpRoot().querySelector('.mcp-server-cmd')?.textContent).toBe(
      'npx -y server-filesystem',
    );
  });

  it('失败态：错误原文可见、卡片不消失（首版只看运行态 ⇒ 坏的那台被整条抹掉）', () => {
    mountSettingsView();
    pushStatus([
      {
        name: 'github',
        command: 'github-mcp',
        enabled: true,
        state: 'failed',
        toolCount: 0,
        tools: [],
        error: 'spawn github-mcp ENOENT',
      },
    ]);
    // 断链守护：卡片必须还在，且错误文本原样透出（这是排查「为什么工具没出现」的唯一入口）
    expect(mcpRoot().querySelectorAll('.mcp-server')).toHaveLength(1);
    expect(mcpRoot().querySelector('.mcp-server-error')?.textContent).toBe(
      'spawn github-mcp ENOENT',
    );
    expect(mcpRoot().querySelector('.mcp-server-state')?.textContent).toBe('启动失败');
    // 失败态也给了恢复路径（重启），否则「配置没变就永远起不来」
    expect(mcpRoot().querySelector('[data-act="restart"]')).not.toBeNull();
  });

  it('停用 / 配置不完整：各自成态，不冒充「失败」', () => {
    mountSettingsView();
    pushStatus([
      { name: 'off', command: 'x', enabled: false, state: 'disabled', toolCount: 0, tools: [] },
      {
        name: 'bad',
        command: '',
        enabled: true,
        state: 'invalid',
        toolCount: 0,
        tools: [],
        problem: '缺少 command',
      },
    ]);
    const states = Array.from(mcpRoot().querySelectorAll('.mcp-server-state')).map(
      (el) => el.textContent,
    );
    expect(states).toEqual(['已停用', '配置不完整']);
    // 停用态给「启用」，非法态只给「编辑」（配置没救之前重启无意义）
    const cards = mcpRoot().querySelectorAll<HTMLElement>('.mcp-server');
    expect(cards[0]?.querySelector('[data-act="toggle"]')?.textContent).toBe('启用');
    expect(cards[0]?.querySelector('[data-act="restart"]')).toBeNull();
    expect(cards[1]?.querySelector('[data-act="toggle"]')).toBeNull();
    expect(cards[1]?.querySelector('.mcp-server-error')?.textContent).toBe('缺少 command');
  });

  it('空数组 = 空态 + 添加入口（空态不再是一段「去别处改」的说明书）', () => {
    mountSettingsView();
    pushStatus([]);
    expect((document.getElementById('mcpEmpty') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('mcpList') as HTMLElement).hidden).toBe(true);
    expect(document.querySelectorAll('.mcp-add-btn')).toHaveLength(2);
  });

  it('勾选只上报不做本地乐观翻转：发出 mcp_write/allow 且带回 allowKey', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([RUNNING]);
    const box = mcpRoot().querySelectorAll<HTMLInputElement>('.mcp-allow-check')[1]!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(postMessage).toHaveBeenCalledWith({
      type: 'mcp_write',
      op: 'allow',
      key: 'mcp__fs__write_file',
      allowlisted: true,
    });
    // UI 不持有第二份状态真源：回推到达前先还原，避免显示一个尚未生效的档位
    expect(box.checked).toBe(false);
  });

  it('添加服务器：表单 → 保存 → upsert（args 一行一个、env 按首个 = 切分）', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([]);
    clickOne('#mcpAddBtn');
    const q = <T extends HTMLElement>(sel: string): T => mcpRoot().querySelector(sel) as T;
    q<HTMLInputElement>('#mcpFName').value = 'sqlite';
    q<HTMLInputElement>('#mcpFCommand').value = 'uvx';
    q<HTMLTextAreaElement>('#mcpFArgs').value = 'mcp-server-sqlite\n--db\napp.db\n';
    q<HTMLTextAreaElement>('#mcpFEnv').value = 'TOKEN=a=b\n\nLEVEL=debug';
    q<HTMLInputElement>('#mcpFCwd').value = '   ';
    clickOne('[data-act="save"]');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'mcp_write',
      op: 'upsert',
      server: {
        name: 'sqlite',
        command: 'uvx',
        enabled: true,
        args: ['mcp-server-sqlite', '--db', 'app.db'],
        env: { TOKEN: 'a=b', LEVEL: 'debug' },
      },
      // reqId：写失败时宿主随 mcp_status.ack 原样回传，视图据此复开表单还输入
      reqId: expect.any(String),
    });
    // 保存后表单关闭，以 host 回推为准（不乐观插一条「我以为存上了」的卡片）
    expect(mcpRoot().querySelector('.mcp-form')).toBeNull();
  });

  it('保存前拦下非法环境变量行：不投递，错误就地显示（不静默丢弃用户输入）', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([]);
    clickOne('#mcpAddBtn');
    (mcpRoot().querySelector('#mcpFName') as HTMLInputElement).value = 'x';
    (mcpRoot().querySelector('#mcpFCommand') as HTMLInputElement).value = 'node';
    (mcpRoot().querySelector('#mcpFEnv') as HTMLTextAreaElement).value = 'NOEQUALS';
    clickOne('[data-act="save"]');
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp_write', op: 'upsert' }),
    );
    expect(mcpRoot().querySelector('.mcp-form-error')?.textContent).toContain('NOEQUALS');
    // 表单仍在（内容没被清掉）
    expect(mcpRoot().querySelector('.mcp-form')).not.toBeNull();
  });

  it('删除需二次确认：首次点击只进确认态，确认后才投递 remove', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([RUNNING]);
    clickOne('[data-act="delete"]');
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp_write', op: 'remove' }),
    );
    clickOne('[data-act="delete-confirm"]');
    expect(postMessage).toHaveBeenCalledWith({ type: 'mcp_write', op: 'remove', name: 'fs' });
  });

  it('停用 = 可撤销动作：投递 setEnabled(enabled:false)，不是 remove', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([RUNNING]);
    const toggle = mcpRoot().querySelector<HTMLElement>('[data-act="toggle"]');
    expect(toggle?.textContent).toBe('停用');
    toggle!.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'mcp_write',
      op: 'setEnabled',
      name: 'fs',
      enabled: false,
    });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp_write', op: 'remove' }),
    );
  });

  it('参数含空项/换行的配置禁用编辑（表单无法无损呈现，指路 settings.json）', () => {
    mountSettingsView();
    pushStatus([
      {
        name: 'weird',
        command: 'node',
        args: ['', 'x'],
        enabled: true,
        state: 'running',
        toolCount: 0,
        tools: [],
      },
    ]);
    const edit = mcpRoot().querySelector<HTMLButtonElement>('[data-act="edit"]');
    expect(edit?.disabled).toBe(true);
    // 有损数据宁可不让编辑，也不静默改写（打开→保存会把空参数吞掉）
    expect(edit?.getAttribute('title')).toContain('settings.json');
  });

  it('外部可控文本转义（server/工具名来自外部 MCP server，不进 innerHTML）', () => {
    mountSettingsView();
    pushStatus([
      {
        name: '<img src=x onerror=alert(1)>',
        command: 'x',
        enabled: true,
        state: 'running',
        toolCount: 1,
        tools: [
          {
            originalName: '<b>bad</b>',
            derivedName: 'mcp__x__bad',
            allowKey: 'k',
            allowlisted: false,
          },
        ],
      },
    ]);
    expect(mcpRoot().querySelector('img')).toBeNull();
    expect(mcpRoot().querySelector('b')).toBeNull();
    expect(mcpRoot().querySelector('.mcp-server-name')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('从 JSON 导入：粘贴原文直接投递 import（不预解析，解析器只有宿主一份）', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([]);
    clickOne('#mcpImportBtn');
    const box = mcpRoot().querySelector<HTMLTextAreaElement>('[data-import]');
    expect(box).not.toBeNull();
    // 面板互斥：导入打开时新增表单不出现（同屏两张输入卡会让人不知道往哪张填）
    expect(mcpRoot().querySelector('.mcp-form')).toBeNull();
    const raw = '{ "mcpServers": { "fs": { "command": "npx" } } }';
    box!.value = raw;
    box!.dispatchEvent(new Event('input', { bubbles: true }));
    clickOne('[data-act="import-run"]');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'mcp_write',
      op: 'import',
      raw,
      reqId: expect.any(String),
    });
  });

  it('导入回执：reqId 对得上才把逐条明细留在卡上（toast 消失后仍可回看）', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([]);
    clickOne('#mcpImportBtn');
    const box = mcpRoot().querySelector<HTMLTextAreaElement>('[data-import]')!;
    box.value = '{ "mcpServers": { "fs": { "command": "npx" } } }';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    clickOne('[data-act="import-run"]');
    // 挂载时还有 cfg_load / ready 等初始消息，取那条 import 的回执 id
    const importCall = postMessage.mock.calls
      .map((call) => call[0] as { type?: string; op?: string; reqId?: string })
      .find((msg) => msg?.type === 'mcp_write' && msg.op === 'import');
    const reqId = importCall!.reqId!;

    // 别人的回推（reqId 不同）不得顶掉本次结论
    pushStatus([], undefined, { reqId: 'someone-else', ok: true, detail: '不该出现' });
    expect(mcpRoot().querySelector('.mcp-import-result')).toBeNull();

    pushStatus([], undefined, { reqId, ok: true, detail: '导入完成：新增 1 台。' });
    expect(mcpRoot().querySelector('.mcp-import-result')?.textContent).toContain('新增 1 台');
  });

  it('导入空文本：不投递，就地提示（不发一次必然失败的消息）', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([]);
    clickOne('#mcpImportBtn');
    clickOne('[data-act="import-run"]');
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp_write', op: 'import' }),
    );
    expect(mcpRoot().querySelector('.mcp-import-result')?.textContent).toContain('请先粘贴');
  });

  it('「高级：在 settings.json 中编辑」→ post open_setting（页面级绑定，按钮已降级为后门）', () => {
    const { postMessage } = mountSettingsView();
    pushStatus([]);
    const btn = mcpRoot().querySelector('.open-setting-btn') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn!.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'open_setting',
      key: 'memora.mcpServers',
    });
    expect(
      postMessage.mock.calls.filter((c) => (c[0] as { type?: string }).type === 'open_setting'),
    ).toHaveLength(1);
  });
});
