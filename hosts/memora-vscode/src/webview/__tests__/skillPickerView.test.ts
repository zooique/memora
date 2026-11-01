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
import { buildDropdownHtml, initDropdowns } from '../components/dropdown.js';
import { createSkillPickerView, type SkillPickerView } from '../scripts/skillPickerView.js';
import type { SkillDto } from '../../shared/protocol.js';

interface Mounted {
  view: SkillPickerView;
  root: HTMLElement;
  menu: HTMLElement;
  trigger: HTMLElement;
  chipRow: HTMLElement;
  input: HTMLTextAreaElement;
}

/** 复刻**真机 DOM 形状**：buildDropdownHtml 产物（treedd + capsule 变体 + data-treedd 契约）
 * + initDropdowns 装配（开合/委托/键盘/全局 click 关闭）——手写简化 DOM 测不到装配差异。 */
function mount(): Mounted {
  document.body.innerHTML = `
    ${buildDropdownHtml([], {
      extraClass: 'skill-picker treedd--capsule',
      onSelect: '__skillPickerOnSelect',
      triggerLabel: '<span class="btn-icon" data-icon="bolt"></span>',
      triggerTitle: '选择 Skill',
      triggerAriaLabel: '选择 Skill',
    })}
    <div id="skillChips"></div>
    <textarea id="input"></textarea>
  `;
  const root = document.querySelector<HTMLElement>('.skill-picker') as HTMLElement;
  const menu = document.querySelector<HTMLElement>('.treedd__menu') as HTMLElement;
  const trigger = document.querySelector<HTMLElement>('.treedd__trigger') as HTMLElement;
  const chipRow = document.getElementById('skillChips') as HTMLElement;
  const input = document.getElementById('input') as HTMLTextAreaElement;
  initDropdowns(document, { __skillPickerOnSelect: () => {} });
  const view = createSkillPickerView({ document, root, menu, trigger, chipRow, input });
  return { view, root, menu, trigger, chipRow, input };
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

describe('skillPickerView 斜杠触发（/ 打开选择器）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** 模拟真实键入：**逐字符**插入并派发带 inputType 的 input 事件。
   * 一次性设整串 value 不等于真实形态——斜杠触发判据是「刚落进来的字符是 `/`」，
   * 整串写入时只有最后一个字符会被看到，测到的是一条用户走不到的路径。 */
  function type(input: HTMLTextAreaElement, text: string): void {
    for (const ch of text) {
      input.value += ch;
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }));
    }
  }

  const isOpen = (root: HTMLElement): boolean => root.classList.contains('is-open');

  /** 派发一次指定形态的 input 事件（inputType / 组合态可控）。
   * 探针实证：普通 insertText、IME 组合 insertCompositionText、全角 ／ 在触发判据上
   * 行为各不相同——只测 insertText 等于只测英文态，中文主路径裸奔。 */
  function fire(
    input: HTMLTextAreaElement,
    opts: { ch: string; inputType: string; isComposing: boolean },
  ): void {
    input.value += opts.ch;
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(
      new InputEvent('input', {
        inputType: opts.inputType,
        isComposing: opts.isComposing,
      } as InputEventInit),
    );
  }

  it('行首 `/` 打开菜单', () => {
    const { root, input } = mount();
    type(input, '/');
    expect(isOpen(root)).toBe(true);
  });

  it('空白后的 `/` 也触发（句中换词的自然用法）', () => {
    const { root, input } = mount();
    type(input, '帮我 /');
    expect(isOpen(root)).toBe(true);
  });

  it('`A/B`、`1/2`、日期里的 `/` 一律不触发（硬边界，靠前一位是否空白判定）', () => {
    for (const text of ['A/', '1/', '2026/']) {
      const { root, input } = mount();
      type(input, text);
      expect(isOpen(root)).toBe(false);
    }
  });

  it('斜杠态继续键入即收起菜单（被动提示，不把正文劫持成搜索）', () => {
    const { view, menu, root, input } = mount();
    view.setSkills(SKILLS);
    type(input, '/su');
    expect(isOpen(root)).toBe(false); // 第二个字符即收起（不再过滤）
    expect(skillItems(menu)).toHaveLength(2); // 列表不过滤，恢复全量
    expect(searchBox(menu).value).toBe(''); // 搜索框未镜像 token
    expect(input.value).toBe('/su'); // 正文原样保留，未被吃成搜索词
  });

  it('选中技能后 token 从正文撤除（`/` 不得变成伪造的用户输入）', () => {
    const { view, chipRow, input } = mount();
    view.setSkills(SKILLS);
    type(input, '/');
    view.select('summarize');
    expect(input.value).toBe('');
    expect(chipRow.querySelector('.skill-chip__name')?.textContent).toBe('摘要提炼');
  });

  it('斜杠态继续输入任意字符即收起（非模态：不把正文当搜索、不赖屏）', () => {
    const { view, menu, root, input } = mount();
    view.setSkills(SKILLS);
    type(input, '/');
    expect(isOpen(root)).toBe(true);
    expect(skillItems(menu)).toHaveLength(2); // 提示态展示全量，不预先过滤
    type(input, 'x'); // 任意字符（非导航键）即视为放弃挑选
    expect(isOpen(root)).toBe(false); // 菜单收起——否则浮层赖着不走，体感打断输入
    expect(input.value).toBe('/x'); // 正文原样保留，未被劫持成搜索词
    expect(searchBox(menu).value).toBe('');
  });

  it('斜杠态 token 含空白也收起（用户开始写正文）', () => {
    const { view, menu, root, input } = mount();
    view.setSkills(SKILLS);
    type(input, '/');
    type(input, ' 然后');
    expect(isOpen(root)).toBe(false);
    expect(skillItems(menu)).toHaveLength(2); // 恢复全量（不再过滤）
  });

  it('斜杠态 Esc 收起菜单，`/` 与已打的字留在正文（取消无扰动）', () => {
    const { root, input } = mount();
    type(input, '/');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isOpen(root)).toBe(false);
    expect(input.value).toBe('/');
  });

  it('IME 组合中的 `/` 也触发（中文输入法主路径——真机「按 / 不弹」回归判据）', () => {
    const { root, input } = mount();
    fire(input, { ch: '/', inputType: 'insertCompositionText', isComposing: true });
    expect(isOpen(root)).toBe(true);
  });

  it('组合中途的拼音字母不收起菜单（防逐字母闪烁）', () => {
    const { root, input } = mount();
    fire(input, { ch: '/', inputType: 'insertCompositionText', isComposing: true });
    expect(isOpen(root)).toBe(true);
    fire(input, { ch: 'n', inputType: 'insertCompositionText', isComposing: true });
    expect(isOpen(root)).toBe(true); // 组合中只开不关
  });

  it('组合收尾：上屏非 `/` 内容即收起；只上屏 `/` 则提示保持', () => {
    const { root, input } = mount();
    fire(input, { ch: '/', inputType: 'insertCompositionText', isComposing: true });
    // 组合结束后上屏「摘要」（Chromium 在 compositionend 前派发最后一次 input）
    fire(input, { ch: '摘要', inputType: 'insertCompositionText', isComposing: false });
    input.dispatchEvent(new Event('compositionend'));
    expect(isOpen(root)).toBe(false);
    // 只上屏 `/` 本身：重置现场（value='/摘要/' 时 `/` 前是「要」，硬边界本就该拒绝）
    input.value = '/';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(
      new InputEvent('input', {
        inputType: 'insertCompositionText',
        isComposing: true,
      } as InputEventInit),
    );
    input.dispatchEvent(new Event('compositionend'));
    expect(isOpen(root)).toBe(true);
  });

  it('全角斜杠 ／ 不触发（硬边界外：判据按字符字面匹配半角 `/`）', () => {
    const { root, input } = mount();
    type(input, '／');
    expect(isOpen(root)).toBe(false);
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
