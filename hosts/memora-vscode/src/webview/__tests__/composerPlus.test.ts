/**
 * 加号面板守卫（COMPOSER-PLUS-FLAT-1）—— 2026-11-26 技能菜单内联，消除两级点击
 *
 * 演进：COMPOSER-PLUS-1 把技能做成加号菜单里的「链接项」，点击后才从另一个隐藏 treedd
 * 弹出技能菜单 ⇒ 两次点击、无面包屑；那个隐藏容器还曾吞掉加号点击（COMPOSER-PLUS-HIT-1）。
 * 本版把技能搜索列表直接内联进加号面板，隐藏节点与中间跳转一并退役。
 *
 * 判据（源码级）：形态由生产骨架 + chatView 回调映射 + chatStyles 承载，jsdom 骨架是镜像非真源；
 * 守卫读生产文件，同时锁测试替身同步（防静默失测）。
 *
 * 四条硬约束（任一破即红）：
 *   ① 一步可达：菜单内直接挂 .skill-picker 容器，不存在 id=skill 的中间项 / 独立技能 treedd；
 *   ② 分流单一：技能名与清除项走 skillPickerView.select，图片/引用复用既有入口，零新协议；
 *   ③ 滚动分层：技能区自身滚动，两个动作项固定底部，长列表不把动作挤出可视区；
 *   ④ 替身同形：夹具只搭容器，条目由生产同一组件生成（夹具凭空多 id 会撞骨架一致性守卫）。
 *   ⑤ 选中态双通道（MODEL-PICKER-STATE-1）：模型选中项浅底复用菜单令牌，公共条目规则不被牵连。
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

/** 取 composer-left 起始到模型选择器之前的片段（加号门就在这段） */
function leftHead(src: string): string {
  const at = src.indexOf('class="composer-left"');
  if (at < 0) return '';
  return src.slice(at, src.indexOf("extraClass: 'model-picker", at));
}

/** 按右花括号截到本规则末尾——定长切片会把下一条规则吞进来，造出假红 */
function cssRule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  if (at < 0) return '';
  const end = CSS.indexOf('}', at);
  return CSS.slice(at, end < 0 ? at + 180 : end + 1);
}

describe('加号面板守卫（COMPOSER-PLUS-FLAT-1）', () => {
  it('生产骨架：加号门在最左，技能容器内联进菜单，无中间链接项', () => {
    const head = leftHead(HTML);
    expect(head, '生产骨架缺 composer-left').not.toBe('');
    expect(HTML.indexOf("extraClass: 'composer-plus")).toBeLessThan(
      HTML.indexOf("extraClass: 'model-picker"),
    );
    // 技能内容容器直接挂在菜单头部：点一次加号就看到搜索框与技能列表
    expect(head).toMatch(
      /menuLeadingHtml:\s*'<div class="skill-picker"><\/div><div class="treedd__divider"><\/div>'/,
    );
    // 两个立即动作项仍在，但「skill」链接项已退役（否则又变回两步）
    expect(head).toContain("{ id: 'image', label:");
    expect(head).toContain("{ id: 'file', label:");
    expect(head).not.toContain("{ id: 'skill', label:");
    // 独立技能 treedd 删除：两级宿主与吞点击覆盖盒一并消失
    expect(head).not.toContain("extraClass: 'skill-picker treedd--capsule'");
    expect(head).toContain("onSelect: '__composerPlusOnSelect'");
  });

  it('分流单一：技能名与清除项走域内 select，图片/引用复用既有入口，零新协议', () => {
    const at = VIEW.indexOf('__composerPlusOnSelect:');
    expect(at, 'chatView 缺加号回调').toBeGreaterThan(-1);
    const cb = VIEW.slice(at, at + 500);
    expect(cb).toContain("id === 'image'");
    expect(cb).toContain('imageAttachBtn?.click()');
    expect(cb).toContain("id === 'file'");
    expect(cb).toContain("type: 'mention_open'");
    expect(cb, '技能项必须落在原有 select 单点').toContain('skillPickerView.select(id)');
    // 不再有「先开另一个菜单」的中间跳转；也不许在回调里自建搜索 UI / 新协议
    expect(cb).not.toContain('skillPickerView.openMenu()');
    expect(cb).not.toMatch(/createElement\('input'|skill_pick|composer_plus/);
    // 斜杠入口仍复用 openSlashHint（与加号面板同一菜单、同一搜索状态）
    const openMenu = SKILL.slice(
      SKILL.indexOf('openMenu(): void {'),
      SKILL.indexOf('openMenu(): void {') + 80,
    );
    expect(openMenu).toContain('openSlashHint()');
    expect(openMenu).not.toContain('setDropdownOpen');
  });

  it('滚动分层：技能区自身滚动、动作项固定底部，隐藏 treedd 规则已退役', () => {
    const skills = cssRule('.composer-plus .treedd__menu > .skill-picker');
    expect(skills, '技能区缺独立滚动容器').toContain('flex: 1 1 auto');
    expect(skills).toContain('min-height: 0');
    expect(skills).toContain('overflow-y: auto');
    const menu = cssRule('.composer-plus.treedd--capsule .treedd__menu');
    expect(menu, '外层必须收滚动，否则技能列表会把动作项顶出可视区').toContain('overflow: hidden');
    expect(menu).toContain('left: 0');
    // 动作项不参与伸缩（长列表滚的是技能区，不是整个菜单）
    expect(CSS).toMatch(/\.composer-plus \.treedd__menu > \.treedd__item \{ flex: 0 0 auto; \}/);
    // 旧隐藏容器与其命中穿透判据不得复活（复活即两级 + 吞点击回归）
    expect(CSS).not.toContain('.composer-left .skill-picker');
    expect(CSS).not.toContain('.skill-picker .treedd__menu { pointer-events: auto');
  });

  it('MODEL-PICKER-ELASTIC-1：模型菜单下限复用窄档、宽档令牌退役，加号门不受牵连', () => {
    const css = cssRule('.model-picker');
    // 下限从固定 200 改为既有窄档 120：短模型名贴内容、长名由 --dim-xl(280) 兜底
    expect(css).toContain('--dd-menu-min-w: var(--dd-trigger-max-w-narrow)');
    expect(css).toContain('--dd-menu-max-w: var(--dim-xl)');
    const TOKENS = readFileSync(join(HERE, '..', 'styles', 'tokens.ts'), 'utf8');
    // 零消费者令牌须退役（否则僵尸守卫红）；窄档与 --dim-xl 仍保留
    expect(TOKENS).not.toContain('--dd-menu-min-w-wide:');
    expect(TOKENS).toMatch(/--dd-trigger-max-w-narrow:\s*120px/);
    expect(TOKENS).toMatch(/--dim-xl:\s*280px/);
    // 加号门自己的取值不动（192 派生式），公共 capsule 默认值不动
    expect(TOKENS).toMatch(
      /--composer-plus-menu-w:\s*calc\(var\(--dim-xl\) - var\(--sp-6\)(?: - var\(--sp-8\)){3}\)/,
    );
    expect(TOKENS).toMatch(/--dd-menu-min-w:\s*160px/);
    expect(TOKENS).toMatch(/--dd-menu-max-w:\s*240px/);
  });

  it('MODEL-PICKER-NOWRAP-1：模型名单行由内容撑宽，公共下拉项换行规则不受牵连', () => {
    const item = cssRule('.model-picker .treedd__item');
    expect(item).toContain('white-space: nowrap');
    expect(item).toContain('overflow: hidden');
    expect(item).toContain('text-overflow: ellipsis');
    // 不带伤：会话历史 / 技能等仍走公共 .treedd__item，不能被顺手改成 nowrap
    expect(cssRule('.treedd__item')).not.toContain('white-space: nowrap');
    // 宽度上下限仍由弹性令牌提供：nowrap 只改变内容测量方式，不改几何契约
    expect(cssRule('.model-picker')).toContain('--dd-menu-max-w: var(--dim-xl)');
    expect(readFileSync(join(HERE, '..', 'styles', 'dropdown.ts'), 'utf8')).toContain(
      'max-width: min(var(--dd-menu-max-w, 240px), calc(100vw - var(--sp-6)))',
    );
  });

  it('视觉分层（COMPOSER-PLUS-VISUAL-1）：加宽走局部取值、动作项图标走组件字段', () => {
    const menu = cssRule('.composer-plus.treedd--capsule .treedd__menu');
    // 宽度只在加号门覆写：公共 capsule 令牌仍服务 model-picker，禁止改全局取值
    expect(menu).toContain('--dd-menu-min-w: var(--composer-plus-menu-w)');
    expect(menu).toContain('--dd-menu-max-w: var(--composer-plus-menu-w)');
    const TOKENS = readFileSync(join(HERE, '..', 'styles', 'tokens.ts'), 'utf8');
    const DROPDOWN_CSS = readFileSync(join(HERE, '..', 'styles', 'dropdown.ts'), 'utf8');
    // 窄窗兜底由公共组件承担（min/max 同锚视口），加号门只换刻度不换几何契约。
    // 2026-11-26 真机红框目标 192px ⇒ dim-xl − sp-6 − 3×sp-8：不新增裸值/令牌，
    // 家族计数零漂移；回退成 280 / 264 / 240 的定值写法即红。
    expect(TOKENS).toMatch(
      /--composer-plus-menu-w:\s*calc\(var\(--dim-xl\) - var\(--sp-6\)(?: - var\(--sp-8\)){3}\)/,
    );
    // 字符串锁只防「表达式被换掉」，不防两端刻度被改：把 192 变成机器真值。
    // 否则注释 / 台账写 192 而实际宽度已漂移时全门仍绿（同一事实两处登记必漂移）。
    const dimXl = Number(TOKENS.match(/--dim-xl:\s*(\d+)px/)?.[1]);
    const sp6 = Number(TOKENS.match(/--sp-6:\s*(\d+)px/)?.[1]);
    const sp8 = Number(TOKENS.match(/--sp-8:\s*(\d+)px/)?.[1]);
    expect(dimXl - sp6 - 3 * sp8, '加号菜单派生宽度必须是 192px').toBe(192);
    // 公共 capsule 取值不动：不能为了修加号宽度顺手改 model-picker 的共享档
    expect(TOKENS).toMatch(/--dd-menu-min-w:\s*160px/);
    expect(TOKENS).toMatch(/--dd-menu-max-w:\s*240px/);
    expect(DROPDOWN_CSS).toContain(
      'min-width: min(var(--dd-menu-min-w, 160px), calc(100vw - var(--sp-6)))',
    );
    expect(DROPDOWN_CSS).toContain(
      'max-width: min(var(--dd-menu-max-w, 240px), calc(100vw - var(--sp-6)))',
    );
    // 动作项带图标但 label 仍是纯 l10n 文本：键面扫描不撞新增中文注释，翻译表不漂移
    const head = leftHead(HTML);
    expect(head).toMatch(/\{ id: 'image', label: vscode\.l10n\.t\('Add image'\), icon: 'image' \}/);
    expect(head).toMatch(
      /\{ id: 'file', label: vscode\.l10n\.t\('Reference files'\), icon: 'paperclip' \}/,
    );
    // 图标由组件单点注入 data-icon 占位，不把 SVG 塞进 label（label 同时担文案与结构两套职责即漂移）
    const COMPONENT = readFileSync(join(HERE, '..', 'components', 'dropdown.ts'), 'utf8');
    expect(COMPONENT).toContain('data-icon="${it.icon}"');
    expect(COMPONENT).toContain('it.icon ? `<span class="treedd__item-icon"');
    // 搜索框分层 + 细滚动条：只在本门覆写，公共 sticky / border-bottom 契约不动
    expect(cssRule('.composer-plus .treedd__search')).toContain('background: var(--surface-inset');
    expect(cssRule('.composer-plus .treedd__menu > .skill-picker')).toContain(
      'scrollbar-width: thin',
    );
    expect(DROPDOWN_CSS).toContain('.treedd__search {');
    expect(DROPDOWN_CSS).toMatch(/position: sticky; top: 0/);
  });

  it('测试替身与生产骨架同形：夹具只搭容器，无独立技能 treedd / 旧回调', () => {
    expect(FIXTURE).toMatch(
      /class="treedd composer-plus treedd--capsule" data-treedd data-on-select="__composerPlusOnSelect"/,
    );
    expect(FIXTURE).toMatch(
      /<div class="treedd__menu" role="menu"><div class="skill-picker"><\/div>/,
    );
    expect(FIXTURE).not.toContain('data-on-select="__skillPickerOnSelect"');
    expect(FIXTURE).not.toContain('treedd skill-picker');
    // 夹具不得硬编码 data-treedd-id：骨架一致性守卫会把它们当成夹具凭空多出的 id
    expect(FIXTURE).not.toMatch(/data-treedd-id="(image|file|skill)"/);
  });

  it('模型选中态双通道：浅底复用菜单令牌，公共条目规则不被牵连', () => {
    const active = cssRule('.model-picker .treedd__item.is-active');
    expect(active).toContain('background: var(--menu-selection-bg)');
    expect(active).toContain('color: var(--accent');
    expect(active).toContain('font-weight: 600');
    const DROPDOWN_CSS = readFileSync(join(HERE, '..', 'styles', 'dropdown.ts'), 'utf8');
    const baseAt = DROPDOWN_CSS.indexOf('.treedd__item {');
    const base = DROPDOWN_CSS.slice(baseAt, DROPDOWN_CSS.indexOf('}', baseAt));
    expect(base, '公共条目基础规则必须保持透明底色').toContain('background: transparent');
    // 浅底在公共规则里仍只归 hover / focus-visible，选中态是 model-picker 的差异定制
    expect(DROPDOWN_CSS).toContain('.treedd__item:focus-visible {');
    expect(DROPDOWN_CSS).toContain('background: var(--menu-selection-bg, rgba(14, 99, 156, 0.06))');
  });

  it('新出现项角标（MODEL-PICKER-NEW-1）：inset 竖条复用既有令牌，与选中态浅底正交', () => {
    const isNew = cssRule('.model-picker .treedd__item.is-new');
    expect(isNew).toContain('box-shadow: inset var(--sp-0');
    expect(isNew).toContain('var(--accent');
    // 角标不写 background（避免覆盖 is-active 的浅底），两通道可并存
    expect(isNew).not.toContain('background:');
    // 基线：公共条目规则未被牵连
    const DROPDOWN_CSS = readFileSync(join(HERE, '..', 'styles', 'dropdown.ts'), 'utf8');
    expect(DROPDOWN_CSS).not.toContain('.treedd__item.is-new');
  });
});
