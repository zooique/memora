/**
 * 输入区 Row1 形态守卫（COMPOSER-FORM-1）—— 2026-11-26「不改间距，改形态」落地
 *
 * 背景：COMPOSER-GEOM-1 只统一了高度与分组缝，用户仍觉得乱——根因不是间距而是信息架构：
 *   ① 模型选择器运行期显示当前模型名，skill 触发器却恒为闪电图标 ⇒ 两个同类控件信息密度差一倍；
 *   ② edit 一形三义（编辑/重命名/润色），放在输入框旁只会被读成「编辑输入框」；
 *   ③ paperclip 承诺任意附件，实际只收图片 ⇒ 承诺与交付不一致。
 *
 * 演进（COMPOSER-PLUS-FLAT-1）：显名技能胶囊已被加号面板内联菜单取代，入口形态判据随之迁移；
 * 图标语义与「名称只在 chip 登记」两条纪律不变。
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

describe('输入区 Row1 形态守卫（COMPOSER-FORM-1）', () => {
  it('入口形态：加号是 plus 图标、模型仍显名，技能名只由 chip 承载', () => {
    expect(HTML).toMatch(/triggerLabel: getIconSvg\('plus', 16, 16\)/);
    expect(HTML).toMatch(/triggerLabel:\s*vscode\.l10n\.t\('Select model'\)/);
    // 技能名不进任何入口：加号只说「添加到消息」，技能容器只挂搜索/列表，选中名归 chip
    expect(HTML).not.toMatch(/menuLeadingHtml:[^\n]*dd-trigger-name/);
    expect(HTML).not.toMatch(/menuLeadingHtml:[^\n]*Select skill/);
    expect(HTML).not.toMatch(/data-icon="bolt"/);
  });

  it('润色换 sparkle、图片换 image：图标语义与交付一致，旧键保留不破坏 IconName 类型面', () => {
    expect(HTML).toMatch(/id="polishBtn"[\s\S]{0,200}data-icon="sparkle"/);
    expect(HTML).toMatch(/id="imageAttachBtn"[\s\S]{0,300}data-icon="image"/);
    expect(HTML).not.toMatch(/id="polishBtn"[\s\S]{0,200}data-icon="edit"/);
    expect(HTML).not.toMatch(/id="imageAttachBtn"[\s\S]{0,300}data-icon="paperclip"/);
    expect(ICONS).toMatch(/\| 'sparkle'/);
    expect(ICONS).toMatch(/\| 'image'/);
    // 旧图标保留：rename 仍用 edit，通用附件仍用 paperclip（扩容而非替换）
    expect(ICONS).toMatch(/\| 'edit'/);
    expect(ICONS).toMatch(/\| 'paperclip'/);
    for (const name of ['sparkle', 'image'] as const) {
      const svg = getIconSvg(name, 16, 16);
      expect(svg, `${name} 未在 icons.ts 路径表中落地`).toContain('<svg');
      expect(svg).toContain('stroke="currentColor"');
    }
  });

  it('测试替身与生产骨架同形：加号内联技能容器，图标无旧形态残留', () => {
    expect(FIXTURE).toMatch(
      /class="treedd composer-plus treedd--capsule"[\s\S]{0,240}<div class="skill-picker"><\/div>/,
    );
    expect(FIXTURE).not.toContain('treedd skill-picker');
    expect(FIXTURE).toMatch(/id="polishBtn"[\s\S]{0,120}data-icon="sparkle"/);
    expect(FIXTURE).toMatch(/id="imageAttachBtn"[\s\S]{0,180}data-icon="image"/);
    expect(FIXTURE).not.toMatch(/data-icon="paperclip"/);
  });
});
