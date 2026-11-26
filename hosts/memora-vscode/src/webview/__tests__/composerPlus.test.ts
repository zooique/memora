/**
 * `+` 挂载门守卫（COMPOSER-PLUS-1）—— 2026-11-26 技能/图片/引用收拢到最左 `+` 门
 *
 * 背景：Row1 曾有 5 个控件，其中「技能」是低频强制路径（默认由内核渐进披露自动触发），
 * 却占了常驻显名胶囊位；图片同样是低频入口。`+` 门把三个键盘入口做成鼠标等价物。
 *
 * 判据（源码级）：形态由生产骨架字符串 + chatView 回调映射 + chatStyles 承载，jsdom 骨架
 * 是镜像而非真源；故守卫读生产文件，同时锁测试替身同步（防静默失测）。
 *
 * 三条硬约束（任一破即红）：
 *   ① 技能节点**保留**（skillPickerView 的搜索框/菜单宿主挂其上），只 CSS 隐藏触发器；
 *      删节点 = 断链，不是「清理」。
 *   ② 三项复用既有入口（openMenu / imageAttachBtn.click / mention_open），零新协议。
 *   ③ 隐藏用 visibility:hidden + position:absolute，不用 display:none——
 *      后者令 getBoundingClientRect() 归零，applyDropDirection 会把技能菜单翻向下、被底缘裁掉；
 *   ④ 命中面断在 skill-picker **容器**（pointer-events:none），菜单单独恢复 auto——
 *      只隐藏 trigger 时容器仍盖住加号（COMPOSER-PLUS-HIT-1），是「点加号没反应」的真因。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, '..', 'panels', 'chatPanelHtml.ts'), 'utf8');
const CSS = readFileSync(join(HERE, '..', 'styles', 'chatStyles.ts'), 'utf8');
const VIEW = readFileSync(join(HERE, '..', 'scripts', 'chatView.ts'), 'utf8');
const SKILL = readFileSync(join(HERE, '..', 'scripts', 'skillPickerView.ts'), 'utf8');
const FIXTURE = readFileSync(join(HERE, 'helpers', 'chatViewTestEnv.ts'), 'utf8');

/** 取 composer-left 起始到模型选择器之前的片段（`+` 门 + 技能节点都在这段） */
function leftHead(src: string): string {
  const at = src.indexOf('class="composer-left"');
  if (at < 0) return '';
  return src.slice(at, src.indexOf('extraClass: \'model-picker', at));
}

describe('`+` 挂载门守卫（COMPOSER-PLUS-1）', () => {
  it('生产骨架：`+` 门在 Row1 最左，三项用既有文案，技能节点仍在', () => {
    const head = leftHead(HTML);
    expect(head, '生产骨架缺 composer-left').not.toBe('');
    // 门在技能胶囊之前（最左）
    expect(head.indexOf("extraClass: 'composer-plus")).toBeLessThan(
      head.indexOf("extraClass: 'skill-picker"),
    );
    // 三项 ID 固定：JS 回调按此分发，改键即静默失联
    for (const id of ['skill', 'image', 'file']) {
      expect(head).toContain(`{ id: '${id}', label:`);
    }
    // 技能节点保留（菜单/chip 宿主），不是从骨架里删掉
    expect(head).toContain("extraClass: 'skill-picker treedd--capsule'");
    // 回调名与 chatView 映射一一对应
    expect(head).toContain("onSelect: '__composerPlusOnSelect'");
  });

  it('三项复用既有入口：零新协议、零第二份搜索 UI', () => {
    const cb = VIEW.slice(
      VIEW.indexOf('__composerPlusOnSelect:'),
      VIEW.indexOf('__composerPlusOnSelect:') + 420,
    );
    expect(cb, 'chatView 缺 + 门回调').not.toBe('');
    expect(cb).toContain("id === 'skill'");
    expect(cb).toContain('skillPickerView.openMenu()');
    expect(cb).toContain("id === 'image'");
    expect(cb).toContain('imageAttachBtn?.click()');
    expect(cb).toContain("id === 'file'");
    expect(cb).toContain("type: 'mention_open'");
    // 不许在门里自建技能搜索框 / 新协议消息
    expect(cb).not.toMatch(/createElement\('input'|skill_pick|composer_plus/);
    // openMenu 复用斜杠开菜单单点，不是第二份 closeOtherDropdowns/setDropdownOpen 组合
    const openMenu = SKILL.slice(SKILL.indexOf('openMenu(): void {'), SKILL.indexOf('openMenu(): void {') + 80);
    expect(openMenu).toContain('openSlashHint()');
    expect(openMenu).not.toContain('setDropdownOpen');
  });

  it('CSS 折叠保几何：visibility + absolute，不用 display:none 断锚点', () => {
    expect(CSS).toMatch(
      /\.composer-left \.skill-picker \{ position: absolute; left: 0; bottom: 0; pointer-events: none; \}/,
    );
    expect(CSS).toMatch(/\.composer-left \.skill-picker > \.treedd__trigger \{ visibility: hidden; \}/);
    expect(CSS).not.toMatch(/\.skill-picker \{ display: none/);
    expect(CSS).toMatch(/#imageAttachBtn \{ display: none; \}/);
    // 锚点 containing block 必须存在，否则 absolute 落到更外层、菜单位置漂移
    expect(CSS).toMatch(/\.composer-left \{[\s\S]{0,400}position: relative;/);
  });

  it('命中穿透：技能容器不吞加号点击，展开后的菜单仍可点（COMPOSER-PLUS-HIT-1）', () => {
    // 按右花括号截到本规则末尾——定长切片会把下一条菜单规则吞进来，造出假红
    const rule = (selector: string): string => {
      const at = CSS.indexOf(`${selector} {`);
      if (at < 0) return '';
      const end = CSS.indexOf('}', at);
      return CSS.slice(at, end < 0 ? at + 160 : end + 1);
    };
    const hit = rule('.composer-left .skill-picker');
    expect(hit, '容器缺 pointer-events:none 会盖在加号上吞点击').toContain('pointer-events: none');
    expect(hit).toContain('position: absolute');
    // 触发器不再单独声明命中：单点断在容器，避免两处判据漂移
    const trigger = rule('.composer-left .skill-picker > .treedd__trigger');
    expect(trigger).toContain('visibility: hidden');
    expect(trigger).not.toContain('pointer-events');
    // 菜单是容器的子元素，继承 none 后必须显式恢复，否则看得见点不动
    const menu = rule('.composer-left .skill-picker .treedd__menu');
    expect(menu, '菜单缺 pointer-events:auto 会导致技能项点不动').toContain('pointer-events: auto');
  });

  it('测试替身与生产骨架同形：+ 门容器/回调名一致、技能节点保留', () => {
    // 夹具只搭容器与回调（条目由生产 buildDropdownHtml 生成，夹具内硬编码 id 会撞
    // chatView.test 的「夹具不得凭空多出生产没有的 id」守卫——生产源码里没有 id="skill" 字面量）。
    expect(FIXTURE).toMatch(/class="treedd composer-plus treedd--capsule" data-treedd data-on-select="__composerPlusOnSelect"/);
    expect(FIXTURE).toContain('data-on-select="__composerPlusOnSelect"');
    expect(FIXTURE).toContain('data-on-select="__skillPickerOnSelect"');
    // 技能触发器仍显名（被 CSS 隐藏而非删节点）
    expect(FIXTURE).toMatch(/treedd skill-picker[\s\S]{0,240}<span class="dd-trigger-name">选择技能<\/span>/);
  });
});
