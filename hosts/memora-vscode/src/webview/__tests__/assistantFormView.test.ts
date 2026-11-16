/**
 * 助手形态输入区（ASSISTANT-FORM）行为与作用域守卫
 *
 * 被测的四条差异（用户拍板）：
 * ① 占位文字换成助手文案、切回逐字还原；② #inputWrap 换品牌色描边/淡底；
 * ③ 输入框左侧显形助手图标；④ 顶部身份条（助手模式 + 工作台入口，2026-11-16 从
 * 输入框上方移到面板顶部）。
 * 显隐分工：图标仍走 JS hidden（applyForm 翻）；身份条与标题条**走 CSS**（jsdom 不算
 * 样式），改由文末的源码级作用域守卫锁：除两条基线外，凡碰到 #inputBox / .assistant-mode /
 * #assistantMode 的规则都必须带 `body[data-form='assistant']` 前缀 —— 漏前缀 = 漏到
 * 自助形态（这是本特性的唯一泄漏口）。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 生产骨架里的自助占位原文（夹具与之同文；l10n 在测试环境下返回键原文） */
const SELF_PLACEHOLDER =
  '@ to reference files, / to pick a skill; Enter to send, Shift+Enter for newline';

/** 助手形态占位文案的源键（bundle 译文在 zh-cn，测试环境 bundle 未加载 ⇒ t() 回源键） */
const ASSISTANT_PLACEHOLDER = 'Tell the assistant what you want done';

/** 取输入框（每次现取：mountChatView 会整块重建 body） */
function input(): HTMLTextAreaElement {
  return document.getElementById('input') as HTMLTextAreaElement;
}

/** 取输入框左侧图标 */
function modeIcon(): HTMLElement {
  return document.getElementById('assistantModeIcon') as HTMLElement;
}

describe('助手形态输入区（ASSISTANT-FORM）', () => {
  it('默认即自助形态：占位逐字保持骨架原值，图标不显形', () => {
    mountChatView();
    // 首帧形态由 body[data-form] 决定（生产由 buildHtml 写入，自助为缺省值）
    expect(document.body.dataset.form).toBe('self');
    expect(input().placeholder).toBe(SELF_PLACEHOLDER);
    expect(modeIcon().hidden).toBe(true);
  });

  it('收到 ui_form=assistant：占位换成助手文案，图标显形', () => {
    mountChatView();
    dispatch({ type: 'ui_form', form: 'assistant' });
    expect(document.body.dataset.form).toBe('assistant');
    expect(input().placeholder).toBe(ASSISTANT_PLACEHOLDER);
    expect(modeIcon().hidden).toBe(false);
  });

  it('切回自助形态：占位**逐字**还原（与骨架原文严格相等），图标重新隐去', () => {
    mountChatView();
    dispatch({ type: 'ui_form', form: 'assistant' });
    dispatch({ type: 'ui_form', form: 'self' });
    expect(document.body.dataset.form).toBe('self');
    // 严格相等而非包含：任何「脚本里再存一份自助文案」的写法都会在这里漂移暴露
    expect(input().placeholder).toBe(SELF_PLACEHOLDER);
    expect(modeIcon().hidden).toBe(true);
  });

  it('顶部身份条上的工作台入口只上报意图（选座判据在宿主）', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'ui_form', form: 'assistant' });
    document.getElementById('assistantWorkbenchBtn')!.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'assistant_open_workbench' });
  });

  it('助手形态隐藏标题条「＋」（会话由助手安排），切回自助即恢复', () => {
    mountChatView();
    const newSessionBtn = document.getElementById('newSessionBtn') as HTMLElement;
    // 自助形态：新建入口在
    expect(newSessionBtn.hidden).toBe(false);
    dispatch({ type: 'ui_form', form: 'assistant' });
    // 助手形态：不出现（防用户自己再开一条托管会话）
    expect(newSessionBtn.hidden).toBe(true);
    dispatch({ type: 'ui_form', form: 'self' });
    expect(newSessionBtn.hidden).toBe(false);
  });

  it('空态口径随形态隔离：自助角色空态不得泄漏进助手座位（2026-11-16 泄漏修复）', () => {
    mountChatView();
    // 自助形态下角色推送 → 空态角色化（正常形态）
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家' });
    expect(document.getElementById('emptyState')?.hidden).toBe(false);
    expect(document.getElementById('emptyTitle')?.textContent).toContain('共鸣小说家');
    // 切助手形态：空态整块隐藏 + 上次自助渲染的角色文案**清除**（不留残余，不靠 hidden 藏）
    dispatch({ type: 'ui_form', form: 'assistant' });
    expect(document.getElementById('emptyState')?.hidden).toBe(true);
    expect(document.getElementById('emptyTitle')?.textContent).not.toContain('共鸣小说家');
    // 助手形态下角色推送照常到达（宿主仍推 chat_role_pack 供消息头标签用）：
    // 空态不被重新渲染成角色卡
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家' });
    expect(document.getElementById('emptyState')?.hidden).toBe(true);
    // 切回自助：角色化空态恢复（空态域内单点判形态，切回即重裁决）
    dispatch({ type: 'ui_form', form: 'self' });
    expect(document.getElementById('emptyState')?.hidden).toBe(false);
    expect(document.getElementById('emptyTitle')?.textContent).toContain('共鸣小说家');
  });

  it('助手形态下托管草稿提示不投影（草稿提示是自助会话语义）', () => {
    mountChatView();
    dispatch({ type: 'ui_form', form: 'assistant' });
    // 助手座位收到「draft + managed」标题推送：不得出现「回到我自己」提示行
    dispatch({ type: 'session_title', title: '新会话', draft: true, defaultMode: 'managed' });
    expect(document.querySelector('.empty-mode-hint')).toBeNull();
  });

  it('输入区减法口径（2026-11-16 拍板）：只去暂停键与徽章群，模型/skill/图片/占用圆环保留', () => {
    // jsdom 不算样式 ⇒ 源码级守卫钉住减法边界，防回退到「一个不留」旧口径
    const css = readFileSync(join(__dirname, '..', 'styles', 'chatStyles.ts'), 'utf8');
    /** 助手形态作用域的 display:none 规则（选择器串 + 规则体） */
    const hiddenRules = [...css.matchAll(/body\[data-form='assistant'\][^{}]*\{[^}]*display:\s*none/g)].map(
      (m) => m[0] as string,
    );
    // 恢复面：功能群（skill/模型/润色/图片）与状态行整行不得在助手作用域隐藏
    const restored = hiddenRules.filter((r) => r.includes('.composer-left') || r.includes('.composer-row--status'));
    expect(restored).toEqual([]);
    // 减法面：暂停键（运行控制）与徽章群（角色/能力）必须隐藏（同一规则的选择器组）
    const keptRule = hiddenRules.find((r) => r.includes('#pauseBtn') && r.includes('.composer-status'));
    expect(keptRule).toBeDefined();
    // 右对齐补偿已退役：左块恢复 ⇒ composer-row--main 回两端分布（不得再有 flex-end 覆盖）
    expect(css).not.toMatch(/body\[data-form='assistant'\][^{}]*\.composer-row--main[^{}]*flex-end/);
  });

  it('助手形态生成中发送键恒为发送态（脱手模型，无停止■）', () => {
    mountChatView();
    dispatch({ type: 'ui_form', form: 'assistant' });
    // 生成中（running）+ 空输入：按钮禁用但仍是发送语义，不得变成停止方块
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' } });
    const send = document.getElementById('send') as HTMLButtonElement;
    expect(send.classList.contains('loading')).toBe(false);
    expect(send.title).toContain('Send');
    // 切回自助：同一运行态下恢复停止语义（形态进矩阵，切换重算）
    dispatch({ type: 'ui_form', form: 'self' });
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.title).toContain('Stop');
  });
});

describe('助手形态样式作用域守卫（漏前缀 = 漏到自助形态）', () => {
  /** 生产样式源码（去注释：注释里会出现示例选择器，会干扰逐条比对） */
  const css = readFileSync(join(__dirname, '..', 'styles', 'chatStyles.ts'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('凡碰到助手形态专有节点/类的规则，除基线外都必须带 body[data-form=assistant] 前缀', () => {
    /** 助手形态专有标识（出现即属本特性） */
    const assistantOnly = /#inputBox|\.assistant-mode|#assistantMode/;
    /** 允许的作用域前缀（前缀匹配：前缀之后还跟着后代选择器是正常形态） */
    const scoped = /^body\[data-form=['"]assistant['"]\](\s|$)/;
    /** 基线豁免（显隐与布局的自助形态默认值，均为「无规则时的自然态」的显式化）：
     * ① 包裹层 display:contents（不生成盒子，等价于「没有这一层」）；
     * ② 顶部身份条 display:none（显隐全走 CSS 的默认隐藏面，hidden 属性机制已退役） */
    let baselineCount = 0;
    const offenders: string[] = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (match[1] as string).trim();
      const body = match[2] as string;
      if (!assistantOnly.test(selector)) continue;
      for (const part of selector.split(',').map((s) => s.trim())) {
        if (scoped.test(part)) continue;
        if (part === '#inputBox' && /display:\s*contents/.test(body)) {
          baselineCount += 1;
          continue;
        }
        if (part === '.assistant-mode-bar' && /display:\s*none/.test(body)) {
          baselineCount += 1;
          continue;
        }
        offenders.push(part);
      }
    }
    // 无前缀的泄漏规则必须为空（有则打印具体选择器，便于直接定位）
    expect(offenders).toEqual([]);
    // 基线必须存在且仅两条：改成三条说明有人在别处又开了无前缀口子
    expect(baselineCount).toBe(2);
  });
});
