/**
 * settingsTabs 测试 — 设置面板选项卡单点定义（协议 / 宿主面板 / webview 三侧共用）
 *
 * **本文件的守卫意图**：tab 清单从 5 处手抄收敛到一处后，「漏改」的形态从「点了没反应 /
 * 类型对不上」变成了编译期红。这里补的是编译期兜不住的三件事：
 *   ① `settingsRootId` 的拼接格式（webview 侧 `getElementById` 与产物 HTML 靠它对齐）；
 *   ② `isSettingsTab` 的收窄边界（`data-tab` 是 DOM 字符串，假值必须一律为 false）；
 *   ③ 默认首页 = 下标 0（此前「谁是首页」的事实散落在产线 HTML 的 `hidden` 属性里）。
 *
 * 加一个新 tab 时：改 `SETTINGS_TABS` 一行 + 两张 label 表 + `settingsPanelHtml.ts` 的 body
 * 表（漏前者.id、漏后者 = 编译红），无需回头改本文件。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  SETTINGS_TAB_ARIA_LABELS,
  SETTINGS_TAB_LABELS,
  isSettingsTab,
  settingsRootId,
} from '../settingsTabs.js';

describe('settingsTabs 选项卡单点定义（2026-10-24 收口）', () => {
  it('默认首页 = tab 表下标 0（此前该事实只在产线 HTML 的 hidden 属性里）', () => {
    expect(DEFAULT_SETTINGS_TAB).toBe(SETTINGS_TABS[0]);
    expect(DEFAULT_SETTINGS_TAB).toBe('memory');
  });

  it('root 容器 id 由 tab 派生，格式供 webview 侧 getElementById 对齐', () => {
    for (const tab of SETTINGS_TABS) {
      expect(settingsRootId(tab)).toBe(`${tab}-root`);
    }
  });

  it('可见名与无障碍名：每个 tab 都有非空值，且可见名互不重复（重复 = 用户分不清两个页）', () => {
    const labels = SETTINGS_TABS.map((tab) => SETTINGS_TAB_LABELS[tab]);
    expect(labels).toHaveLength(SETTINGS_TABS.length);
    labels.forEach((label) => expect(label.trim()).not.toBe(''));
    expect(new Set(labels).size).toBe(labels.length);

    const aria = SETTINGS_TABS.map((tab) => SETTINGS_TAB_ARIA_LABELS[tab]);
    aria.forEach((label) => expect(label.trim()).not.toBe(''));
  });

  it('isSettingsTab 收窄：全部 tab 为真，非 tab 字符串 / 空值一律为假', () => {
    // 假值全收过来不能放行——data-tab 是 DOM 属性，缺值时是 undefined
    SETTINGS_TABS.forEach((tab) => expect(isSettingsTab(tab)).toBe(true));
    expect(isSettingsTab('tools')).toBe(false); // 尚未落地的 tab：收窄后才不会「点了没反应」
    expect(isSettingsTab('MEMORY')).toBe(false);
    expect(isSettingsTab('')).toBe(false);
    expect(isSettingsTab(undefined)).toBe(false);
    expect(isSettingsTab(0)).toBe(false);
    expect(isSettingsTab(null)).toBe(false);
  });

  it('「安全」页漂移回归（2026-10-24）：tab 表必须含 security 且能被收窄', () => {
    // 改前：settingsPanel.switchTab 的形参联合是手写且漏了 'security' ⇒ 无法从命令跳转过去。
    // 守卫 = 任取一个 tab 都能被 `SettingsTab` 收窄为合法值（漏一个 ⇒ 本例与 switchTab 编译同时红）。
    expect(SETTINGS_TABS).toContain('security');
    expect(isSettingsTab('security')).toBe(true);
  });
});
