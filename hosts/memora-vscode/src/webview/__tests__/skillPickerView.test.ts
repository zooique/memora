/**
 * 技能选择器域（skillPickerView）单元测试
 *
 * 覆盖判据全部落在**该域自己的执行链**上（不拉整个 chatView）：
 *   - 菜单项必须是可聚焦的 `button`（div 的 focus() 是空操作 ⇒ 键盘导航静默失效）
 *   - 搜索三字段：name（id）/ displayName / description 任一命中
 *   - 选中态 → 触发器 label 与 chip 文本用 displayName，回传 id 用 name
 *   - pinned 语义：默认常驻、afterSend 不清；取消常驻后 afterSend 清除
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createSkillPickerView, type SkillPickerView } from '../scripts/skillPickerView.js';
import type { SkillDto } from '../../shared/protocol.js';

interface Mounted {
  view: SkillPickerView;
  menu: HTMLElement;
  trigger: HTMLElement;
  chipRow: HTMLElement;
}

function mount(): Mounted {
  document.body.innerHTML = `
    <div class="skill-picker">
      <button class="treedd__trigger"></button>
      <div class="treedd__menu"></div>
    </div>
    <div id="skillChips"></div>
  `;
  const root = document.querySelector<HTMLElement>('.skill-picker') as HTMLElement;
  const menu = document.querySelector<HTMLElement>('.treedd__menu') as HTMLElement;
  const trigger = document.querySelector<HTMLElement>('.treedd__trigger') as HTMLElement;
  const chipRow = document.getElementById('skillChips') as HTMLElement;
  const view = createSkillPickerView({ document, root, menu, trigger, chipRow });
  return { view, menu, trigger, chipRow };
}

/** 两条技能：一条有中文显示名、一条无（回退 name） */
const SKILLS: SkillDto[] = [
  { name: 'summarize', description: '长文本结构化摘要', displayName: '摘要提炼', layer: 'builtin' },
  { name: 'foreshadow', description: '伏笔埋设与回收', layer: 'rolepack' },
];

/** 取当前菜单里的技能项（排除「未选择技能」清除项与分隔线） */
function skillItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('.treedd__item')).filter(
    (el) => el.dataset.treeddId !== '__clear_skill',
  );
}

/** 菜单搜索框（装配后由域内插入菜单容器首位） */
function searchBox(menu: HTMLElement): HTMLInputElement {
  return menu.querySelector<HTMLInputElement>('.treedd__search') as HTMLInputElement;
}

describe('skillPickerView 菜单渲染', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('初始空清单：只有清除项与分隔线，无技能项', () => {
    const { menu } = mount();
    expect(skillItems(menu)).toHaveLength(0);
    expect(menu.querySelector('.treedd__divider')).not.toBeNull();
  });

  it('菜单项是可聚焦 button（div 的 focus() 是空操作 ⇒ 键盘导航失效的根因）', () => {
    const { view, menu } = mount();
    view.setSkills(SKILLS);
    const items = skillItems(menu);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.tagName).toBe('BUTTON');
      item.focus();
      // 判据不放宽：div 在此处 activeElement 会停在 body
      expect(document.activeElement).toBe(item);
    }
  });

  it('显示名优先、缺失回退 name；清理项文本为「未选择技能」', () => {
    const { view, menu } = mount();
    view.setSkills(SKILLS);
    const items = skillItems(menu);
    expect(items[0]?.textContent).toBe('摘要提炼');
    expect(items[1]?.textContent).toBe('foreshadow');
    const clear = menu.querySelector<HTMLElement>('[data-treedd-id="__clear_skill"]');
    expect(clear?.textContent).toBe('未选择技能');
  });

  it('禁用技能：弱化 + 「已禁用」徽记，但条目保留不隐藏', () => {
    const { view, menu } = mount();
    view.setSkills([{ ...SKILLS[0]!, disabled: true }]);
    const item = skillItems(menu)[0]!;
    expect(item.classList.contains('is-disabled')).toBe(true);
    expect(item.querySelector('.treedd__item-note')?.textContent).toBe('已禁用');
  });
});

describe('skillPickerView 搜索判据', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function search(menu: HTMLElement, q: string): string[] {
    const box = searchBox(menu);
    box.value = q;
    box.dispatchEvent(new Event('input'));
    return skillItems(menu).map((el) => el.dataset.treeddId ?? '');
  }

  it('按英文 id 命中（展示层只显中文名，只记得 id 的用户不能搜不到）', () => {
    const { view, menu } = mount();
    view.setSkills(SKILLS);
    expect(search(menu, 'summ')).toEqual(['summarize']);
  });

  it('按显示名命中', () => {
    const { view, menu } = mount();
    view.setSkills(SKILLS);
    expect(search(menu, '摘要')).toEqual(['summarize']);
  });

  it('按描述命中', () => {
    const { view, menu } = mount();
    view.setSkills(SKILLS);
    expect(search(menu, '伏笔')).toEqual(['foreshadow']);
  });

  it('无命中：显示空态且不残留技能项', () => {
    const { view, menu } = mount();
    view.setSkills(SKILLS);
    expect(search(menu, 'zzz')).toEqual([]);
    expect(menu.querySelector('.treedd__empty')?.textContent).toBe('无匹配技能');
  });
});

describe('skillPickerView 选中态与 pinned', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('选中后：触发器 aria 用显示名，回传 id 仍是 name，chip 文本用显示名', () => {
    const { view, trigger, chipRow } = mount();
    view.setSkills(SKILLS);
    view.select('summarize');
    expect(trigger.getAttribute('aria-label')).toBe('当前 Skill：摘要提炼');
    expect(view.getSelected()?.name).toBe('summarize');
    expect(chipRow.querySelector('.skill-chip__name')?.textContent).toBe('摘要提炼');
    expect(chipRow.hidden).toBe(false);
  });

  it('未知 id 不改现状（清单重推瞬间的竞态不得静默清空用户选择）', () => {
    const { view } = mount();
    view.setSkills(SKILLS);
    view.select('summarize');
    view.select('__not_exist__');
    expect(view.getSelected()?.name).toBe('summarize');
  });

  it('清除项：清空选中并隐藏 chip 行', () => {
    const { view, chipRow } = mount();
    view.setSkills(SKILLS);
    view.select('summarize');
    view.select('__clear_skill');
    expect(view.getSelected()).toBeNull();
    expect(chipRow.hidden).toBe(true);
  });

  it('afterSend：默认常驻（pinned=true）不清；取消常驻后清除', () => {
    const { view } = mount();
    view.setSkills(SKILLS);
    view.select('summarize');
    view.afterSend();
    expect(view.getSelected()?.name).toBe('summarize');

    expect(view.getSelected()?.pinned).toBe(true);
    view.refreshEdges();
    const pin = document.querySelector<HTMLElement>('.skill-chip__pin') as HTMLElement;
    pin.click(); // 切到未钉住
    expect(view.getSelected()?.pinned).toBe(false);
    view.afterSend();
    expect(view.getSelected()).toBeNull();
  });
});
