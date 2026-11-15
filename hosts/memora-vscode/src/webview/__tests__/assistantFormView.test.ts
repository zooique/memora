/**
 * 助手形态输入区（ASSISTANT-FORM）行为与作用域守卫
 *
 * 被测的四条差异（用户拍板）：
 * ① 占位文字换成助手文案、切回逐字还原；② #inputWrap 换品牌色描边/淡底；
 * ③ 输入框左侧显形助手图标；④ 上方一行小字说明形态 + 工作台入口。
 * 第五条（隐藏运行控制排）是**纯 CSS**，jsdom 不算样式，改由文末的源码级作用域守卫锁：
 * 除一条基线外，凡碰到 #inputBox / .assistant-mode / #assistantMode 的规则都必须带
 * `body[data-form='assistant']` 前缀 —— 漏前缀 = 漏到自助形态（这是本特性的唯一泄漏口）。
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

/** 取形态标识条 */
function modeBar(): HTMLElement {
  return document.getElementById('assistantModeBar') as HTMLElement;
}

/** 取输入框左侧图标 */
function modeIcon(): HTMLElement {
  return document.getElementById('assistantModeIcon') as HTMLElement;
}

describe('助手形态输入区（ASSISTANT-FORM）', () => {
  it('默认即自助形态：占位逐字保持骨架原值，标识条与图标不显形', () => {
    mountChatView();
    // 首帧形态由 body[data-form] 决定（生产由 buildHtml 写入，自助为缺省值）
    expect(document.body.dataset.form).toBe('self');
    expect(input().placeholder).toBe(SELF_PLACEHOLDER);
    expect(modeBar().hidden).toBe(true);
    expect(modeIcon().hidden).toBe(true);
  });

  it('收到 ui_form=assistant：占位换成助手文案，标识条与图标显形', () => {
    mountChatView();
    dispatch({ type: 'ui_form', form: 'assistant' });
    expect(document.body.dataset.form).toBe('assistant');
    expect(input().placeholder).toBe(ASSISTANT_PLACEHOLDER);
    expect(modeBar().hidden).toBe(false);
    expect(modeIcon().hidden).toBe(false);
  });

  it('切回自助形态：占位**逐字**还原（与骨架原文严格相等），标识条与图标重新隐去', () => {
    mountChatView();
    dispatch({ type: 'ui_form', form: 'assistant' });
    dispatch({ type: 'ui_form', form: 'self' });
    expect(document.body.dataset.form).toBe('self');
    // 严格相等而非包含：任何「脚本里再存一份自助文案」的写法都会在这里漂移暴露
    expect(input().placeholder).toBe(SELF_PLACEHOLDER);
    expect(modeBar().hidden).toBe(true);
    expect(modeIcon().hidden).toBe(true);
  });

  it('标识条上的工作台入口只上报意图（选座判据在宿主）', () => {
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
    /** 唯一豁免：包裹层基线（display:contents 不生成盒子，等价于「没有这一层」） */
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
        offenders.push(part);
      }
    }
    // 无前缀的泄漏规则必须为空（有则打印具体选择器，便于直接定位）
    expect(offenders).toEqual([]);
    // 基线必须存在且仅一条：改成两条说明有人在别处又开了无前缀口子
    expect(baselineCount).toBe(1);
  });
});
