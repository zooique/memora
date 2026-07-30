/**
 * 精灵设定面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围（P3 关键测试，R4 迁移前的安全网）：
 * - refreshByType：按 type 分发刷新对应列表（persona/rule/skill 三个分支）
 * - createListItem：DOM 结构正确性（data-action + data-name + 文本内容 + active 标记）
 * - setPersonaMode：程序化调用更新 radio 选中状态，但不触发 onPersonaModeChange 回调
 * - loadAll：三类列表并行加载 + 空状态/非空状态渲染
 * - onPersonaModeChange：radio 用户切换时触发回调 + 乐观更新 badge
 * - setDefaultPersona：程序化设置 select.value + 暂存 currentDefaultPersona
 * - refreshDefaultPersonaOptions：角色列表变化时动态重建 options + 选中值回退空
 * - onDefaultPersonaChange：select change 时触发回调持久化
 *
 * Mock 策略：
 * - Mock SettingsManagerPanelHost 接口（showConfirmDialog/showToast/showModal/hideModal/updatePersonaModeBadge/onSkillInstall）
 * - Mock window.electronAPI（listPersonas/listRules/listSkills 等）
 * - 真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - JSDOM 提供真实 DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SettingsManagerPanelManager,
  type SettingsManagerPanelHost,
} from '../../../electron/renderer/panels/settingsManagerPanel.js';
import type { ConfigFileEntry } from '../../../sprite/configFileManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 Mock SettingsManagerPanelHost */
function createMockHost(overrides?: Partial<SettingsManagerPanelHost>): SettingsManagerPanelHost {
  return {
    showConfirmDialog: vi.fn().mockResolvedValue(true),
    showToast: vi.fn(),
    showModal: vi.fn(),
    hideModal: vi.fn(),
    updatePersonaModeBadge: vi.fn(),
    onSkillInstall: vi.fn(),
    ...overrides,
  };
}

/** 精灵设定面板完整 DOM 结构（三 tab + 列表容器 + 编辑器模态框 + 角色匹配配置区 + 技能拖入区） */
const SPRITE_SETTINGS_HTML = `
  <div id="panel-sprite-settings">
    <!-- tab 导航 -->
    <button class="sprite-settings-tab active" data-sprite-settings-tab="persona">角色</button>
    <button class="sprite-settings-tab" data-sprite-settings-tab="rule">规则</button>
    <button class="sprite-settings-tab" data-sprite-settings-tab="skill">技能</button>

    <!-- tab 内容区 -->
    <div class="sprite-settings-tab-content active" data-sprite-settings-tab="persona">
      <!-- 角色匹配配置区 -->
      <input type="radio" name="sprite-persona-mode" value="auto" checked />
      <input type="radio" name="sprite-persona-mode" value="manual" />
      <select id="cfg-sprite-default-persona"><option value="">（自动匹配）</option></select>
      <!-- 角色列表 -->
      <button id="btn-add-persona" type="button">+ 新建角色</button>
      <div id="persona-config-list" class="sprite-settings-list"></div>
      <div id="persona-config-empty" class="sprite-settings-empty hidden">暂无角色</div>
    </div>

    <div class="sprite-settings-tab-content" data-sprite-settings-tab="rule">
      <button id="btn-add-rule" type="button">+ 新建规则</button>
      <div id="rule-config-list" class="sprite-settings-list"></div>
      <div id="rule-config-empty" class="sprite-settings-empty hidden">暂无规则</div>
      <div id="guardrail-config-list" class="sprite-settings-list"></div>
      <div id="guardrail-config-empty" class="sprite-settings-empty hidden">暂无护栏规则</div>
      <div id="project-rule-config-list" class="sprite-settings-list"></div>
      <div id="project-rule-config-empty" class="sprite-settings-empty hidden">暂无项目级规则</div>
    </div>

    <div class="sprite-settings-tab-content" data-sprite-settings-tab="skill">
      <button id="btn-add-skill" type="button">+ 新建技能</button>
      <div id="sprite-skill-dropzone" class="skill-dropzone" tabindex="0" role="button">
        <input type="file" id="sprite-skill-file-input" accept=".md" hidden />
      </div>
      <div id="skill-config-list" class="sprite-settings-list"></div>
      <div id="skill-config-empty" class="sprite-settings-empty hidden">暂无技能</div>
    </div>
  </div>

  <!-- 编辑器模态框 -->
  <div id="config-file-editor-modal" class="modal hidden" role="dialog">
    <div class="modal-overlay" data-action="close-editor"></div>
    <div class="modal-content config-file-editor-content">
      <div class="modal-header">
        <h2 id="config-file-editor-title">编辑设定</h2>
        <button class="modal-close" data-action="close-editor" aria-label="关闭"></button>
      </div>
      <div class="modal-body config-file-editor-body">
        <div id="config-file-editor-form" class="config-file-editor-form"></div>
        <div class="config-file-editor-body-section">
          <label for="config-file-editor-content">正文</label>
          <textarea id="config-file-editor-content" class="config-file-editor-textarea" rows="12"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" data-action="cancel-editor">取消</button>
        <button class="btn-primary" data-action="save-editor">保存</button>
      </div>
    </div>
  </div>
`;

/** Mock window.electronAPI（精灵设定面板用到的全部方法） */
function mockElectronAPI(overrides?: {
  listPersonas?: ReturnType<typeof vi.fn>;
  listRules?: ReturnType<typeof vi.fn>;
  listSkills?: ReturnType<typeof vi.fn>;
}): void {
  const defaultListPersonas = vi.fn().mockResolvedValue({
    personas: [{ name: '导师', description: '教学指导', active: true }],
  });
  const defaultListRules = vi.fn().mockResolvedValue([
    { name: '代码规范', fileName: '代码规范.md', filePath: '/tmp/r.md', content: '', size: 100, mtime: 1700000000000 },
  ] as ConfigFileEntry[]);
  const defaultListSkills = vi.fn().mockResolvedValue([
    { name: '翻译', fileName: '翻译.md', filePath: '/tmp/s.md', content: '', size: 200, mtime: 1700000001000 },
  ] as ConfigFileEntry[]);

  Object.assign(window, {
    electronAPI: {
      listPersonas: overrides?.listPersonas ?? defaultListPersonas,
      listRules: overrides?.listRules ?? defaultListRules,
      listSkills: overrides?.listSkills ?? defaultListSkills,
      readPersonaFile: vi.fn().mockResolvedValue('---\nname: 导师\n---\n正文'),
      readRule: vi.fn().mockResolvedValue('---\nname: 代码规范\n---\n正文'),
      // MIND2-A4：savePersonaFile/saveRule 合并为 saveConfigFile(type, name, content)
      saveConfigFile: vi.fn().mockResolvedValue({ ok: true }),
      installSkill: vi.fn().mockResolvedValue({ ok: true, hotReloaded: true }),
      deletePersonaFile: vi.fn().mockResolvedValue({ ok: true }),
      deleteRule: vi.fn().mockResolvedValue({ ok: true }),
      deleteSkill: vi.fn().mockResolvedValue({ ok: true }),
    },
  });
}

/** 创建 SettingsManagerPanelManager（已 init） */
function createManager(opts?: {
  host?: SettingsManagerPanelHost;
  html?: string;
  init?: boolean;
  apiOverrides?: Parameters<typeof mockElectronAPI>[0];
}): { manager: SettingsManagerPanelManager; host: SettingsManagerPanelHost } {
  document.body.innerHTML = opts?.html ?? SPRITE_SETTINGS_HTML;
  mockElectronAPI(opts?.apiOverrides);
  const host = opts?.host ?? createMockHost();
  const manager = new SettingsManagerPanelManager(host);
  if (opts?.init !== false) {
    manager.init();
  }
  return { manager, host };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

// ─── refreshByType · 按 type 分发刷新 ────────────────────

describe('refreshByType · 按 type 分发刷新对应列表', () => {
  it('type=persona 应调用 loadPersonaList（即 listPersonas IPC）', async () => {
    const { manager } = createManager();
    // 清空调用记录（createManager 期间未调用 listPersonas，但保险起见 clear）
    (window.electronAPI.listPersonas as ReturnType<typeof vi.fn>).mockClear();

    await manager.refreshByType('persona');

    expect(window.electronAPI.listPersonas).toHaveBeenCalledTimes(1);
    // 不应调用 listRules / listSkills
    expect(window.electronAPI.listRules).not.toHaveBeenCalled();
    expect(window.electronAPI.listSkills).not.toHaveBeenCalled();
  });

  it('type=rule 应调用 loadRuleList（即 listRules IPC）', async () => {
    const { manager } = createManager();
    (window.electronAPI.listRules as ReturnType<typeof vi.fn>).mockClear();

    await manager.refreshByType('rule');

    expect(window.electronAPI.listRules).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.listPersonas).not.toHaveBeenCalled();
    expect(window.electronAPI.listSkills).not.toHaveBeenCalled();
  });

  it('type=skill 应调用 loadSkillList（即 listSkills IPC）', async () => {
    const { manager } = createManager();
    (window.electronAPI.listSkills as ReturnType<typeof vi.fn>).mockClear();

    await manager.refreshByType('skill');

    expect(window.electronAPI.listSkills).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.listPersonas).not.toHaveBeenCalled();
    expect(window.electronAPI.listRules).not.toHaveBeenCalled();
  });
});

// ─── createListItem · DOM 结构正确性 ─────────────────────

describe('createListItem · DOM 结构正确性', () => {
  it('persona 类型应渲染名称 + 描述 + active 标记 + 编辑/删除按钮', () => {
    const { manager } = createManager();
    // createListItem 是 private 方法，通过 [key] 访问测试
    const item = (manager as unknown as {
      createListItem: (
        type: 'persona' | 'rule' | 'skill',
        name: string,
        description: string,
        active: boolean,
      ) => HTMLElement;
    }).createListItem('persona', '导师', '教学指导', true);

    // 容器 + data 属性（供事件委托识别）
    expect(item.className).toBe('sprite-settings-item');
    expect(item.dataset.type).toBe('persona');
    expect(item.dataset.name).toBe('导师');

    // 名称 span（textContent 防 XSS，不用 innerHTML）
    const nameSpan = item.querySelector('.sprite-settings-item-name');
    expect(nameSpan?.textContent).toBe('导师');

    // 描述 span
    const descSpan = item.querySelector('.sprite-settings-item-desc');
    expect(descSpan?.textContent).toBe('教学指导');

    // active 标记（仅 persona active 时显示）
    const activeSpan = item.querySelector('.sprite-settings-item-active');
    expect(activeSpan?.textContent).toBe('当前');

    // 操作按钮 + data-action
    const editBtn = item.querySelector('[data-action="edit"]');
    const deleteBtn = item.querySelector('[data-action="delete"]');
    expect(editBtn?.textContent).toBe('编辑');
    expect(deleteBtn?.textContent).toBe('删除');
  });

  it('rule 类型 active=false 不应渲染 active 标记', () => {
    const { manager } = createManager();
    const item = (manager as unknown as {
      createListItem: (
        type: 'persona' | 'rule' | 'skill',
        name: string,
        description: string,
        active: boolean,
      ) => HTMLElement;
    }).createListItem('rule', '代码规范', '', false);

    expect(item.dataset.type).toBe('rule');
    expect(item.dataset.name).toBe('代码规范');
    // 无描述时不渲染 desc span
    expect(item.querySelector('.sprite-settings-item-desc')).toBeNull();
    // active=false 不渲染 active 标记
    expect(item.querySelector('.sprite-settings-item-active')).toBeNull();
    // 仍保留编辑/删除按钮
    expect(item.querySelector('[data-action="edit"]')).not.toBeNull();
    expect(item.querySelector('[data-action="delete"]')).not.toBeNull();
  });

  it('名称含 HTML 特殊字符应被 textContent 转义（防 XSS）', () => {
    const { manager } = createManager();
    const maliciousName = '<script>alert(1)</script>';
    const item = (manager as unknown as {
      createListItem: (
        type: 'persona' | 'rule' | 'skill',
        name: string,
        description: string,
        active: boolean,
      ) => HTMLElement;
    }).createListItem('persona', maliciousName, '', false);

    // textContent 应原样显示字符串，不解析为 HTML
    const nameSpan = item.querySelector('.sprite-settings-item-name');
    expect(nameSpan?.textContent).toBe(maliciousName);
    // 确认没有 script 子元素被注入
    expect(item.querySelectorAll('script').length).toBe(0);
  });
});

// ─── setPersonaMode · 程序化调用不触发回调 ───────────────

describe('setPersonaMode · 程序化调用不触发 onPersonaModeChange 回调', () => {
  it('setPersonaMode 应更新 radio 选中状态但不触发回调', () => {
    const { manager, host } = createManager();
    const callback = vi.fn();
    manager.onPersonaModeChange(callback);

    // 初始 auto 选中
    const autoRadio = document.querySelector<HTMLInputElement>(
      'input[name="sprite-persona-mode"][value="auto"]',
    );
    const manualRadio = document.querySelector<HTMLInputElement>(
      'input[name="sprite-persona-mode"][value="manual"]',
    );
    expect(autoRadio?.checked).toBe(true);
    expect(manualRadio?.checked).toBe(false);

    // 程序化切换到 manual
    manager.setPersonaMode('manual');

    // radio 选中状态应更新
    expect(autoRadio?.checked).toBe(false);
    expect(manualRadio?.checked).toBe(true);
    // 但回调不应被触发（程序化设置 .checked 不触发 change 事件）
    expect(callback).not.toHaveBeenCalled();
    // badge 也不应被更新（setPersonaMode 只负责 radio 状态，badge 由调用方管理）
    expect(host.updatePersonaModeBadge).not.toHaveBeenCalled();
  });

  it('radio 用户切换应触发 onPersonaModeChange 回调 + 乐观更新 badge', () => {
    const { manager, host } = createManager();
    const callback = vi.fn();
    manager.onPersonaModeChange(callback);

    // 模拟用户点击 manual radio
    const manualRadio = document.querySelector<HTMLInputElement>(
      'input[name="sprite-persona-mode"][value="manual"]',
    );
    manualRadio!.checked = true;
    manualRadio!.dispatchEvent(new Event('change', { bubbles: true }));

    // 回调应被触发，参数为 'manual'
    expect(callback).toHaveBeenCalledWith('manual');
    // badge 应被乐观更新（用户切换时立即同步，不等 IPC 成功）
    expect(host.updatePersonaModeBadge).toHaveBeenCalledWith('manual');
  });
});

// ─── setDefaultPersona + refreshDefaultPersonaOptions · 默认角色下拉 ───

describe('setDefaultPersona + refreshDefaultPersonaOptions · 默认角色下拉', () => {
  it('setDefaultPersona 应设置 select.value 并暂存值', () => {
    const { manager } = createManager();
    const select = document.getElementById('cfg-sprite-default-persona') as HTMLSelectElement;

    // 初始为占位项（空值）
    expect(select.value).toBe('');

    // 程序化设置默认角色
    manager.setDefaultPersona('导师');

    // select.value 应立即更新（如果 option 存在）
    // 但此时 options 只有占位项，select.value 实际为空——暂存值由 currentDefaultPersona 保持
    // 验证暂存字段：通过 renderPersonaList 后恢复选中来间接验证
    expect(select.value).toBe('');
  });

  it('renderPersonaList 应动态重建 select options 并恢复暂存的选中值', async () => {
    const { manager } = createManager();
    // 先暂存默认角色（options 未填充）
    manager.setDefaultPersona('导师');

    // mock 角色列表包含"导师"
    (window.electronAPI.listPersonas as ReturnType<typeof vi.fn>).mockResolvedValue({
      personas: [
        { name: '导师', description: '教学角色', active: false },
        { name: '朋友', description: '陪伴角色', active: false },
      ],
    });

    await manager.loadAll();

    const select = document.getElementById('cfg-sprite-default-persona') as HTMLSelectElement;
    // options 应包含占位项 + 2 个角色
    expect(select.options.length).toBe(3);
    expect(select.options[0]!.value).toBe('');
    expect(select.options[1]!.value).toBe('导师');
    expect(select.options[2]!.value).toBe('朋友');
    // 暂存值"导师"应被恢复选中
    expect(select.value).toBe('导师');
  });

  it('暂存值不在角色列表中时 select 应回退到空（自动匹配）', async () => {
    const { manager } = createManager();
    // 暂存一个不存在的角色名
    manager.setDefaultPersona('已删除的角色');

    (window.electronAPI.listPersonas as ReturnType<typeof vi.fn>).mockResolvedValue({
      personas: [{ name: '导师', description: '教学', active: false }],
    });

    await manager.loadAll();

    const select = document.getElementById('cfg-sprite-default-persona') as HTMLSelectElement;
    // "已删除的角色"不在 options 中，应回退到空
    expect(select.value).toBe('');
  });

  it('角色列表为空时 select options 应只剩占位项', async () => {
    const { manager } = createManager();
    // 先填充 options
    (window.electronAPI.listPersonas as ReturnType<typeof vi.fn>).mockResolvedValue({
      personas: [{ name: '导师', description: '教学', active: false }],
    });
    await manager.loadAll();

    const select = document.getElementById('cfg-sprite-default-persona') as HTMLSelectElement;
    expect(select.options.length).toBe(2); // 占位 + 导师

    // 再清空角色列表
    (window.electronAPI.listPersonas as ReturnType<typeof vi.fn>).mockResolvedValue({
      personas: [],
    });
    await manager.loadAll();

    // select 应只剩占位项
    expect(select.options.length).toBe(1);
    expect(select.options[0]!.value).toBe('');
    expect(select.value).toBe('');
  });

  it('select change 应触发 onDefaultPersonaChange 回调', () => {
    const { manager } = createManager();
    const callback = vi.fn();
    manager.onDefaultPersonaChange(callback);

    const select = document.getElementById('cfg-sprite-default-persona') as HTMLSelectElement;
    // 加一个 option 供选择
    const opt = document.createElement('option');
    opt.value = '导师';
    opt.textContent = '导师';
    select.appendChild(opt);

    // 模拟用户选择"导师"
    select.value = '导师';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    // 回调应被触发，参数为 '导师'
    expect(callback).toHaveBeenCalledWith('导师');
  });
});

// ─── loadAll · 三类列表并行加载 + 空状态 ─────────────────

describe('loadAll · 三类列表并行加载', () => {
  it('loadAll 应并行调用三个 listXxx IPC 并渲染列表', async () => {
    const { manager } = createManager();
    (window.electronAPI.listPersonas as ReturnType<typeof vi.fn>).mockClear();
    (window.electronAPI.listRules as ReturnType<typeof vi.fn>).mockClear();
    (window.electronAPI.listSkills as ReturnType<typeof vi.fn>).mockClear();

    await manager.loadAll();

    // 三个 IPC 都被调用
    expect(window.electronAPI.listPersonas).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.listRules).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.listSkills).toHaveBeenCalledTimes(1);

    // 列表应被渲染（非空状态）
    const personaList = document.getElementById('persona-config-list');
    const ruleList = document.getElementById('rule-config-list');
    const skillList = document.getElementById('skill-config-list');
    expect(personaList?.children.length).toBe(1);
    expect(ruleList?.children.length).toBe(1);
    expect(skillList?.children.length).toBe(1);

    // 空状态应被隐藏
    expect(document.getElementById('persona-config-empty')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('rule-config-empty')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('skill-config-empty')?.classList.contains('hidden')).toBe(true);
  });

  it('空列表应显示空状态 + 清空列表容器', async () => {
    const { manager } = createManager({
      apiOverrides: {
        listPersonas: vi.fn().mockResolvedValue({ personas: [] }),
        listRules: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockResolvedValue([]),
      },
    });

    await manager.loadAll();

    // 列表容器应为空
    expect(document.getElementById('persona-config-list')?.children.length).toBe(0);
    expect(document.getElementById('rule-config-list')?.children.length).toBe(0);
    expect(document.getElementById('skill-config-list')?.children.length).toBe(0);

    // 空状态应显示（移除 hidden 类）
    expect(document.getElementById('persona-config-empty')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('rule-config-empty')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('skill-config-empty')?.classList.contains('hidden')).toBe(false);
  });

  it('loadAll 失败应显示 toast 错误提示（不抛出异常）', async () => {
    const { manager, host } = createManager({
      apiOverrides: {
        listPersonas: vi.fn().mockRejectedValue(new Error('IPC 失败')),
      },
    });

    // loadAll 内部 Promise.all 不会因单个 reject 而中断其他列表
    // 但 loadPersonaList 内部 try/catch 会捕获并显示 toast
    await manager.loadAll();

    expect(host.showToast).toHaveBeenCalledWith('加载角色列表失败', 'error');
  });
});

// ─── cleanup · 事件监听器清理 ────────────────────────────

describe('cleanup · 事件监听器清理', () => {
  it('cleanup 后 radio change 不应再触发回调', () => {
    const { manager, host } = createManager();
    const callback = vi.fn();
    manager.onPersonaModeChange(callback);

    // cleanup 后事件监听器应被解绑
    manager.cleanup();

    const manualRadio = document.querySelector<HTMLInputElement>(
      'input[name="sprite-persona-mode"][value="manual"]',
    );
    manualRadio!.checked = true;
    manualRadio!.dispatchEvent(new Event('change', { bubbles: true }));

    expect(callback).not.toHaveBeenCalled();
    expect(host.updatePersonaModeBadge).not.toHaveBeenCalled();
  });
});
