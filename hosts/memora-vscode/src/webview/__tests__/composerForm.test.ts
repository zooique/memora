/**
 * 输入区 Row1 形态守卫（COMPOSER-FORM-1）—— 2026-11-26「不改间距，改形态」落地
 *
 * 背景：COMPOSER-GEOM-1 只统一了高度与分组缝，用户仍觉得乱——根因不是间距而是信息架构：
 *   ① 模型选择器运行期显示当前模型名，skill 触发器却恒为闪电图标 ⇒ 两个同类控件信息密度差一倍；
 *   ② `edit` 一形三义（编辑/重命名/润色），放在输入框旁只会被读成「编辑输入框」；
 *   ③ `paperclip` 承诺任意附件，实际只收图片 ⇒ 承诺与交付不一致。
 *
 * 判据（源码级）：形态由生产骨架的字符串模板与 icons.ts 的路径表表达，jsdom 骨架是镜像而非真源，
 * 故守卫读生产文件；同时锁测试替身同步，防「测试拿旧形态验新判据」的静默失测。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getIconSvg } from '../scripts/icons.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, '..', 'panels', 'chatPanelHtml.ts'), 'utf8');
const FIXTURE = readFileSync(join(HERE, 'helpers', 'chatViewTestEnv.ts'), 'utf8');
const ICONS = readFileSync(join(HERE, '..', 'scripts', 'icons.ts'), 'utf8');

/** 取 skill 选择器 buildDropdownHtml 调用的实参块（从 extraClass 锚到 onSelect 收束） */
function skillTriggerBlock(src: string): string {
  const at = src.indexOf("extraClass: 'skill-picker treedd--capsule'");
  if (at < 0) return '';
  return src.slice(at, src.indexOf('})', at));
}

describe('输入区 Row1 形态守卫（COMPOSER-FORM-1）', () => {
  it('skill 与模型同为显名触发器：文案走 l10n、共用 dd-trigger-name，名称不重复进触发器', () => {
    const block = skillTriggerBlock(HTML);
    expect(block, '生产骨架缺 skill 选择器构造块').not.toBe('');
    // 显名：span.dd-trigger-name（与 pickerView.ts 的模型同构，CSS ellipsis 才有承载节点）
    expect(block).toMatch(/triggerLabel:\s*`<span class="dd-trigger-name">\$\{vscode\.l10n\.t\('Select skill'\)\}<\/span>`/);
    // 与模型对称：模型也走 Select model，两个选择器同类可读
    expect(HTML).toMatch(/triggerLabel:\s*vscode\.l10n\.t\('Select model'\)/);
    // 不回退成图标入口（图标只留菜单内项与 chip）
    expect(block).not.toMatch(/data-icon="bolt"/);
    // 当前技能名归 chip，不在触发器里二次登记（两处写同一状态必漂移）。
    // 只禁运行期状态变量（currentSkill / displayName / skillName），不误伤 l10n 的静态插值
    expect(block).not.toMatch(/Current skill|currentSkill|displayName|skillName/);
  });

  it('润色换 sparkle、图片换 image：图标语义与交付一致，旧键保留不破坏 IconName 类型面', () => {
    // 生产骨架：两个按钮各用专属图标
    expect(HTML).toMatch(/id="polishBtn"[\s\S]{0,200}data-icon="sparkle"/);
    expect(HTML).toMatch(/id="imageAttachBtn"[\s\S]{0,300}data-icon="image"/);
    expect(HTML).not.toMatch(/id="polishBtn"[\s\S]{0,200}data-icon="edit"/);
    expect(HTML).not.toMatch(/id="imageAttachBtn"[\s\S]{0,300}data-icon="paperclip"/);
    // 图标库：新键进联合类型与路径表（TS 的 Record<IconName, string> 会强制两处同在）
    expect(ICONS).toMatch(/\| 'sparkle'/);
    expect(ICONS).toMatch(/\| 'image'/);
    // 旧图标保留：rename 仍用 edit，通用附件仍用 paperclip（扩容而非替换）
    expect(ICONS).toMatch(/\| 'edit'/);
    expect(ICONS).toMatch(/\| 'paperclip'/);
    // 图标本体可被图标语言守卫解析（非字符图标、描边族）
    for (const name of ['sparkle', 'image'] as const) {
      const svg = getIconSvg(name, 16, 16);
      expect(svg, `${name} 未在 icons.ts 路径表中落地`).toContain('<svg');
      expect(svg).toContain('stroke="currentColor"');
    }
  });

  it('测试替身与生产骨架同形：显名触发器与两个图标均无旧形态残留', () => {
    // 替身是镜像而非真源，但残留旧形态会让整条链路在夹具里静默失测
    expect(FIXTURE).toMatch(/<div class="treedd skill-picker[\s\S]{0,240}<span class="dd-trigger-name">选择技能<\/span>/);
    expect(FIXTURE).toMatch(/id="polishBtn"[\s\S]{0,120}data-icon="sparkle"/);
    expect(FIXTURE).toMatch(/id="imageAttachBtn"[\s\S]{0,180}data-icon="image"/);
    expect(FIXTURE).not.toMatch(/data-icon="paperclip"/);
  });
});
