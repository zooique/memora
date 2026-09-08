/**
 * rolesView 测试 — 角色管理面板渲染分支（2026-08-17 独立视图）
 *
 * 覆盖新增的角色管理视图渲染路径：
 *   - 顶栏统计（statBar：「已加载 N 个角色」）
 *   - 分区标题（group-title：「当前角色」/「其他角色」）+ 激活角色置顶
 *   - 激活徽章（badge：「当前」）+ 能力标签 chips（cap-chip 中文 label + title 原始能力名）
 *   - 空态引导（empty-state）
 *   - 「设为当前」按钮 → postMessage roles_set_active（host 切换 + 持久化 + 重推）
 * 用 jsdom 环境 + 注入 mock acquireVsCodeApi，通过 createRolesView 工厂驱动 render。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRolesView } from '../scripts/rolesView.js';

/** 覆盖 createRolesView 全部查询引用的最小 HTML 骨架（子视图挂载在 #roles-root 根容器内，
 *  与设置视图选项卡合并后的 id 空间隔离约定一致） */
const HTML = `
  <div id="roles-root">
    <div class="header">
      <h2>角色</h2>
      <span id="statBar" class="stat-bar" hidden></span>
    </div>
    <div id="list"><p class="hint">加载中…</p></div>
    <p class="footer-hint">「设为当前」仅切换默认角色；「带入对话」还会跳到对话并预填一句过渡语（不自动发送，可编辑后再发）。</p>
  </div>
`;

/** 挂载 createRolesView 并返回 postMessage mock */
function mountRolesView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  const root = document.getElementById('roles-root') as HTMLElement;
  createRolesView({
    vscode: { postMessage },
    window: window as unknown as Window,
    root,
  });
  return { postMessage };
}

/**
 * 向 webview 分发一条 roles_loaded 消息，驱动 render。
 * maxTeamMembers 模拟宿主下发的内核常量（MAX_TEAM_MEMBERS）。
 */
function dispatchLoaded(
  packs: unknown[],
  activeName: string,
  teams: unknown[] = [],
  maxTeamMembers = 4,
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'roles_loaded', packs, activeName, teams, maxTeamMembers },
    }),
  );
}

describe('rolesView 渲染（2026-08-17 独立角色管理视图）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('roles_loaded 渲染角色卡片：激活角色置顶带徽章，其余归「其他角色」', () => {
    mountRolesView();
    dispatchLoaded(
      [
        { name: 'doc-review', displayName: '文档打磨', description: '打磨文档', capabilities: [] },
        { name: 'translator', displayName: '翻译助手', capabilities: [] },
      ],
      'doc-review',
    );
    const list = document.getElementById('list') as HTMLElement;
    // 顶栏统计
    expect(document.getElementById('statBar')?.textContent).toBe('已加载 2 个角色');
    // 分组：当前角色（doc-review 带徽章）→ 其他角色
    const groups = list.querySelectorAll('.group-title');
    expect(groups[0]?.textContent).toBe('当前角色');
    expect(groups[1]?.textContent).toBe('其他角色');
    const cards = list.querySelectorAll('.card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.classList.contains('active')).toBe(true);
    // badge 内嵌于 .card-name（文本节点 + 徽章 span），名称部分包含「文档打磨」
    expect(cards[0]?.querySelector('.card-name')?.textContent).toContain('文档打磨');
    expect(cards[0]?.querySelector('.badge')?.textContent).toBe('当前');
    // 激活角色无「设为当前」（仅「带入对话」+ 卡片级组队入口），其他角色两者都有
    expect(
      Array.from(cards[0]!.querySelectorAll('.btn-secondary')).some((b) => b.textContent === '设为当前'),
    ).toBe(false);
    expect(cards[1]?.querySelector('.card-name')?.textContent).toBe('翻译助手');
    expect(cards[1]?.querySelector('.btn-secondary')?.textContent).toBe('设为当前');
    // 每张卡片都有「带入对话」按钮
    expect(cards[0]?.querySelector('.btn-primary')?.textContent).toBe('带入对话');
    expect(cards[1]?.querySelector('.btn-primary')?.textContent).toBe('带入对话');
    // 按钮 title 提示：解释各自行为（对齐 chip.title 可发现性范式）
    expect(cards[0]?.querySelector('.btn-primary')?.getAttribute('title')).toContain('跳到对话');
    expect(cards[1]?.querySelector('.btn-secondary')?.getAttribute('title')).toContain('仅切换默认角色');
  });

  it('能力标签 chips：展示 host 翻译的中文 label，title 承载原始能力名', () => {
    mountRolesView();
    dispatchLoaded(
      [
        {
          name: 'doc-review',
          displayName: '文档打磨',
          capabilities: [
            { capability: 'file:read', label: '读取文件' },
            { capability: 'llm:summarize', label: '摘要生成' },
          ],
        },
      ],
      'doc-review',
    );
    const chips = document.querySelectorAll('.cap-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe('读取文件');
    expect(chips[0]?.getAttribute('title')).toBe('file:read');
    expect(chips[1]?.textContent).toBe('摘要生成');
  });

  it('G29 健康区：roles_loaded issues 渲染徽章 + 问题列表（error/warning 分色）', () => {
    mountRolesView();
    dispatchLoaded(
      [
        {
          name: 'doc-review',
          displayName: '文档打磨',
          capabilities: [],
          issues: [
            { level: 'error' as const, message: '缺 name 字段' },
            { level: 'warning' as const, message: '未知键 keywords（宽容忽略）' },
          ],
        },
        { name: 'translator', displayName: '翻译助手', capabilities: [] },
      ],
      'doc-review',
    );
    const cards = document.querySelectorAll('.card');
    // 有问题卡片：显示健康区 + 徽章（含 error → 配置异常）+ 两条问题（分色）
    const health = cards[0]?.querySelector('.role-health');
    expect(health).not.toBeNull();
    expect(health?.querySelector('.role-health-badge')?.textContent).toBe('配置异常');
    const problems = health?.querySelectorAll('.role-problems li');
    expect(problems).toHaveLength(2);
    expect(problems?.[0]?.textContent).toContain('缺 name 字段');
    expect(problems?.[0]?.classList.contains('prob-error')).toBe(true);
    expect(problems?.[1]?.classList.contains('prob-warning')).toBe(true);
    // 无问题卡片：不渲染健康区
    expect(cards[1]?.querySelector('.role-health')).toBeNull();
  });

  it('G29 健康区：仅有 warning 时徽章为「可优化」（error 优先分级）', () => {
    mountRolesView();
    dispatchLoaded(
      [
        {
          name: 'translator',
          displayName: '翻译助手',
          capabilities: [],
          issues: [{ level: 'warning' as const, message: '未知键 trigger（宽容忽略）' }],
        },
      ],
      'translator',
    );
    const badge = document.querySelector('.role-health-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('可优化');
    expect(badge?.classList.contains('health-warn')).toBe(true);
  });

  it('「设为当前」→ postMessage roles_set_active（host 切换 + 持久化 + 重推）', () => {
    const { postMessage } = mountRolesView();
    dispatchLoaded(
      [
        { name: 'doc-review', displayName: '文档打磨', capabilities: [] },
        { name: 'translator', displayName: '翻译助手', capabilities: [] },
      ],
      'doc-review',
    );
    const btn = document.querySelector('.card:not(.active) .btn-secondary') as HTMLButtonElement;
    btn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'roles_set_active', name: 'translator' });
  });

  it('「带入对话」→ postMessage roles_handoff（host 切换激活角色 + 聚焦对话视图）', () => {
    const { postMessage } = mountRolesView();
    dispatchLoaded(
      [
        { name: 'doc-review', displayName: '文档打磨', capabilities: [] },
        { name: 'translator', displayName: '翻译助手', capabilities: [] },
      ],
      'doc-review',
    );
    const btn = document.querySelector('.card:not(.active) .btn-primary') as HTMLButtonElement;
    btn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'roles_handoff', name: 'translator' });
  });

  it('roles_loaded 空列表 → 渲染空态引导', () => {
    mountRolesView();
    dispatchLoaded([], '');
    expect(document.querySelector('.empty-title')?.textContent).toBe('暂无角色包');
    expect(document.querySelector('.empty-hint')?.textContent).toContain('打开一个工作区');
  });

  it('② 卡片级组队：无队伍 → ribbon「暂无队伍」+ 创建按钮 → 弹窗排除自身、勾选保存', () => {
    const { postMessage } = mountRolesView();
    const packs = [
      { name: '小说助手', displayName: '小说助手', capabilities: [] },
      { name: '编辑', displayName: '编辑', capabilities: [] },
      { name: '评论家', displayName: '评论家', capabilities: [] },
      { name: 'memora助手', displayName: 'memora 助手', capabilities: [], isFallback: true },
    ];
    dispatchLoaded(packs, '小说助手', []); // 无队伍

    // 无队伍 → 「暂无队伍」+ 「创建队伍」入口
    const card = Array.from(document.querySelectorAll('.card')).find(
      (c) => c.querySelector('.card-name')?.textContent === '小说助手',
    );
    expect(card?.querySelector('.team-ribbon-label')?.textContent).toBe('暂无队伍');
    (card?.querySelector('.team-ribbon-btn') as HTMLButtonElement).click();

    // 兜底契约包定位 chip（能力标签区，2026-08-29 实测反馈）：顶部 badge 已移除，仅保留策略区 chip
    const fallbackCard = Array.from(document.querySelectorAll('.card')).find(
      (c) => c.querySelector('.card-name')?.textContent === 'memora 助手',
    );
    expect(fallbackCard?.querySelector('.strategy-chip.fallback')?.textContent).toContain('系统兜底');

    // 弹窗：显示队长（当前卡片角色）+ 排除自身后的其余角色
    const modal = document.querySelector('.team-modal');
    expect(modal).not.toBeNull();
    expect(modal?.querySelector('.team-modal-title')?.textContent).toContain('小说助手');
    const items = Array.from(modal?.querySelectorAll('.team-modal-item input') ?? []) as HTMLInputElement[];
    expect(items).toHaveLength(3); // 编辑 / 评论家 / memora 助手（排除队长自身）
    items.find((cb) => cb.value === '编辑')!.checked = true;
    items.find((cb) => cb.value === '评论家')!.checked = true;
    (modal?.querySelector('.btn-primary') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'roles_team_save',
      leader: '小说助手',
      members: ['编辑', '评论家'],
    });
  });

  it('② 卡片级组队：既有队伍 → ribbon 显示阵容 + 编辑态回显 + 删除队伍入口', () => {
    const { postMessage } = mountRolesView();
    const packs = [
      { name: '小说助手', displayName: '小说助手', capabilities: [] },
      { name: '编辑', displayName: '编辑', capabilities: [] },
      { name: '评论家', displayName: '评论家', capabilities: [] },
      { name: 'memora助手', displayName: 'memora 助手', capabilities: [], isFallback: true },
    ];
    dispatchLoaded(packs, '小说助手', [{ leader: '小说助手', members: ['编辑', '评论家'] }]);

    const card = Array.from(document.querySelectorAll('.card')).find(
      (c) => c.querySelector('.card-name')?.textContent === '小说助手',
    );
    // ribbon 显示阵容（成员 displayName 拼接）
    expect(card?.querySelector('.team-ribbon-label')?.textContent).toBe('队伍：编辑 / 评论家');
    const btn = card?.querySelector('.team-ribbon-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('编辑队伍');
    btn.click();

    // 编辑态回显：已有组员勾选
    const modal = document.querySelector('.team-modal');
    const cbs = Array.from(modal?.querySelectorAll('.team-modal-item input') ?? []) as HTMLInputElement[];
    expect(cbs.find((cb) => cb.value === '编辑')?.checked).toBe(true);
    // 删除队伍（仅编辑态提供）→ postMessage roles_team_delete
    (modal?.querySelector('.team-modal-del') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'roles_team_delete', leader: '小说助手' });
  });

  it('② 卡片组队弹窗：5 人组上限（队长 1 + 组员 ≤ 4），第 5 名勾选被拒绝', () => {
    mountRolesView();
    const packs = [
      { name: '小说助手', displayName: '小说助手', capabilities: [] },
      { name: '编辑', displayName: '编辑', capabilities: [] },
      { name: '评论家', displayName: '评论家', capabilities: [] },
      { name: '校对', displayName: '校对', capabilities: [] },
      { name: '排版', displayName: '排版', capabilities: [] },
      { name: '发行', displayName: '发行', capabilities: [] },
    ];
    dispatchLoaded(packs, '小说助手', []);
    const card = Array.from(document.querySelectorAll('.card')).find(
      (c) => c.querySelector('.card-name')?.textContent === '小说助手',
    );
    (card?.querySelector('.team-ribbon-btn') as HTMLButtonElement).click();

    const modal = document.querySelector('.team-modal');
    const cbs = Array.from(modal?.querySelectorAll('.team-modal-item input') ?? []) as HTMLInputElement[];
    // 依次勾选全部（5 名可选）→ 第 5 名被上限拒绝（勾满 4 即封顶）
    let checked = 0;
    for (const cb of cbs) {
      cb.click();
      if (cb.checked) checked++;
    }
    expect(checked).toBe(4);
    expect(modal?.querySelectorAll('.team-modal-item input:checked')).toHaveLength(4);
    expect(modal?.querySelector('.team-modal-hint')?.textContent).toContain('5 人组上限');
  });

  it('② 存量超限队伍：卡片标注实际参会人数，不虚报（名单原样展示）', () => {
    mountRolesView();
    const packs = [
      { name: '小说助手', displayName: '小说助手', capabilities: [] },
      { name: '编辑', displayName: '编辑', capabilities: [] },
      { name: '评论家', displayName: '评论家', capabilities: [] },
      { name: '校对', displayName: '校对', capabilities: [] },
      { name: '排版', displayName: '排版', capabilities: [] },
      { name: '发行', displayName: '发行', capabilities: [] },
    ];
    // 存量数据：5 名组员（超上限 4）
    dispatchLoaded(
      packs,
      '小说助手',
      [{ leader: '小说助手', members: ['编辑', '评论家', '校对', '排版', '发行'] }],
    );
    const card = Array.from(document.querySelectorAll('.card')).find(
      (c) => c.querySelector('.card-name')?.textContent === '小说助手',
    );
    const label = card?.querySelector('.team-ribbon-label') as HTMLElement;
    // 名单原样展示（用户可自行删减）
    expect(label.textContent).toBe('队伍：编辑 / 评论家 / 校对 / 排版 / 发行');
    // 实际只有 4 名参会，且明确告知超出 1 名不参与
    expect(label.title).toContain('4 名组员参与小组会议');
    expect(label.title).toContain('名单共 5 名');
    expect(label.title).toContain('超出上限的 1 名不参与');
  });
});
