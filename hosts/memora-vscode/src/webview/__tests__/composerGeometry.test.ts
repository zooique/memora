/**
 * 输入区 Row1 几何守卫（COMPOSER-GEOM-1）—— 排雷后唯一站得住的输入区打磨项
 *
 * 背景（2026-11-26 排雷）：上一轮提出过四条「形态调整」，逐条回源后三条被推翻——
 *   ① skill 生命周期 ≠ 引用：HOST-ATT-1 的不可共容主依据是「基数」（skill = 会话级单值
 *      开关，无逐条删除；图片/引用 = 多值候选队列），不是「发完即清」这一半事实；
 *   ② skill 选中态并非只靠触发器染色：renderChip() 在 #skillChips 画名称 + pin + ✕，
 *      就贴在 textarea 上方，不存在「状态离得最远」；
 *   ③ `+` 聚合缺第二项：协议只有 image_pick_request，无通用文件选择，@ 走工作区搜索，
 *      只有一项的 `+` 是假聚合，等于用 UI 倒逼新功能（违自然生长）；
 *   ④ aria-disabled 是刻意设计「置灰但可点跳设置」，disabled 属性才不可达。
 * 唯一坐实的是纯几何缺口：Row1 同排出现 24 / 28 / 32 三种高度，图标按钮非正方形。
 *
 * 判据（源码级，jsdom 不算样式）：本守卫把几何修复钉成机器判据，防下次被静默改回。
 * 选源码级而非 DOM 级：该形态由 CSS 表达、生产与测试骨架均不承载尺寸声明。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'styles', 'chatStyles.ts'), 'utf8');
const TOKENS = readFileSync(join(HERE, '..', 'styles', 'tokens.ts'), 'utf8');

/** 取一个选择器的规则块体（与仓库其它样式守卫同款提取口径） */
function blockOf(selector: string): string {
  const at = CSS.indexOf(selector);
  if (at < 0) return '';
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open, close);
}

describe('输入区 Row1 几何守卫（COMPOSER-GEOM-1）', () => {
  it('图标按钮正方形且与选择器胶囊齐高：ctl / 润色 / 图片统一 28', () => {
    // .ctl 基类 min-width/min-height 同档 —— 图标按钮正方形
    const ctl = blockOf('.ctl {');
    expect(ctl).toMatch(/min-width:\s*var\(--sq-xl,\s*28px\)/);
    expect(ctl).toMatch(/min-height:\s*var\(--sq-xl,\s*28px\)/);
    // 两个图标按钮的显式 height 同档 —— 消除 24 与 28 的参差
    for (const selector of ['.polish-btn-icon {', '.image-attach-btn {']) {
      const block = blockOf(selector);
      expect(block, selector).toMatch(/height:\s*var\(--sq-xl,\s*28px\)/);
      expect(block, selector).not.toMatch(/height:\s*var\(--sq-lg,\s*24px\)/);
    }
    // 令牌族计数不变：sq-lg 令牌本体仍存在，不得为了「统一」删定义（族计数由 tokensClosure 守卫）
    expect(TOKENS).toMatch(/--sq-lg:\s*24px/);
  });

  it('分组缝只在润色左缘：组内 6px、组间 16px，且不靠新增 DOM wrapper', () => {
    const polish = blockOf('.polish-btn-icon {');
    // 组间缝 = gap(6) + margin-left(10) = 16，是组内 6 的 2.67 倍
    expect(polish).toMatch(/margin-left:\s*var\(--sp-4,\s*10px\)/);
    // 分组靠 CSS margin，不在骨架里加 wrapper 节点（避免生产/测试双骨架漂移）
    expect(polish).not.toMatch(/margin-left:\s*\d+px/);
    // 图片按钮不得自带左缘 margin —— 它与润色同组，组内仍走 .composer-left 的 gap
    expect(blockOf('.image-attach-btn {')).not.toMatch(/margin-left/);
    // .composer-left 的 gap 维持 6px（组内节奏不被改动）
    expect(blockOf('.composer-left {')).toMatch(/gap:\s*var\(--sp-2,\s*6px\)/);
  });

  it('润色空态禁用有视觉档位（POLISH-EMPTY-1）：disabled 与发送键同用 op-3', () => {
    const disabled = blockOf('.polish-btn-icon:disabled {');
    expect(disabled).toMatch(/opacity:\s*var\(--op-3(?:\s*\)|,)/);
    expect(disabled).toMatch(/cursor:\s*not-allowed/);
    // 置灰按钮不得在 hover 时提亮成假 affordance
    expect(CSS).toMatch(/\.polish-btn-icon:hover:not\(:disabled\)/);
  });

  it('不改判定语义：图片按钮的置灰仍由 aria-disabled 承载，角色徽章不被隐藏', () => {
    // 排雷④：aria-disabled 是刻意的「置灰但可点跳设置」，几何打磨不得顺手改成 disabled
    expect(CSS).toMatch(/\.ctl\[aria-disabled='true'\]/);
    // 助手形态减法边界不受几何改动影响
    const hidden = CSS.match(/body\[data-form='assistant'\][^{}]*\{[^}]*display:\s*none/g) ?? [];
    expect(hidden.some((r) => r.includes('.composer-left'))).toBe(false);
  });
});
