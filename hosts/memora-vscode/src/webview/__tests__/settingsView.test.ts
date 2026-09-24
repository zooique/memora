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
          <div id="apikeyHint" hidden></div><div id="testResult" hidden></div>
          <button id="btnTest" type="button"></button><button id="btnCancel" type="button"></button><button id="btnSave" type="submit"></button>
        </form>
      </div>
    </div>
    <div id="toast"></div>
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
        data: { type: 'skills_loaded', skills: [makeSkill(0)], unmatchedDisabled: ['typo-skill', 'ghost-skill'] },
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
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'skills_loaded', skills } }),
    );
  }

  it('builtin/user 技能卡片渲染真实开关；disabled=true → checked（与「已禁用」徽章同态对照）', () => {
    mountSettingsView();
    dispatchSkills([
      { name: 's1', description: '启用中的内置技能', layer: 'builtin' },
      { name: 's2', description: '已禁用的用户技能', layer: 'user', disabled: true },
    ]);
    const s1Toggle = document.querySelector('.skill-item[data-skill-name="s1"] .skill-disable-check') as HTMLInputElement | null;
    const s2Toggle = document.querySelector('.skill-item[data-skill-name="s2"] .skill-disable-check') as HTMLInputElement | null;
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
    const toggle = document.querySelector('.skill-item[data-skill-name="s1"] .skill-disable-check') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    toggle.click(); // 原生 click 翻转 checked 并触发 change（change 冒泡被 listEl 委托捕获）
    expect(postMessage).toHaveBeenCalledWith({ type: 'toggle_skill_disabled', name: 's1', disabled: true });
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
      new MessageEvent('message', { data: { type: 'notice', level: 'info', message: '已切换网页搜索引擎' } }),
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
      new MessageEvent('message', { data: { type: 'notice', level: 'error', message: '角色包不存在：x' } }),
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
      new MessageEvent('message', { data: { type: 'skill_content', skillName: 'skill-00', content: payload } }),
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
