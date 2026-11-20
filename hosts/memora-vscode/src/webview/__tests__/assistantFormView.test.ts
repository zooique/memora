/**
 * 助手形态输入区（ASSISTANT-FORM）行为与作用域守卫
 *
 * 形态是**挂载常量**（HOSTED-UI-SEAT-DECOUPLE-1）：侧栏挂 self、托管页挂 assistant，
 * 换形态 = 换一个 webview 挂载，不再有运行时 ui_form 切换消息。被测差异：
 * ① 占位文字按形态取文案；② #inputWrap 换品牌色描边/淡底；③ 输入框左侧显形助手图标；
 * ④ 顶部身份条（助手模式 + 工作台入口）。
 * 显隐分工：图标仍走 JS hidden（挂载时 applyForm 写）；身份条与标题条**走 CSS**（jsdom 不算
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

  it('挂载 assistant 形态：占位换成助手文案，图标显形', () => {
    mountChatView('assistant');
    expect(document.body.dataset.form).toBe('assistant');
    expect(input().placeholder).toBe(ASSISTANT_PLACEHOLDER);
    expect(modeIcon().hidden).toBe(false);
  });

  it('两种形态各自挂载：自助占位逐字来自骨架原文，助手占位来自 l10n', () => {
    mountChatView('assistant');
    // 严格相等而非包含：任何「脚本里再存一份占位文案」的写法都会在这里漂移暴露
    expect(input().placeholder).toBe(ASSISTANT_PLACEHOLDER);
    expect(modeIcon().hidden).toBe(false);
    // 另起一次挂载 = 自助视图（形态是常量，不再原地翻面）
    mountChatView('self');
    expect(document.body.dataset.form).toBe('self');
    expect(input().placeholder).toBe(SELF_PLACEHOLDER);
    expect(modeIcon().hidden).toBe(true);
  });

  it('顶部身份条上的工作台入口只上报意图（选座判据在宿主）', () => {
    const { postMessage } = mountChatView('assistant');
    document.getElementById('assistantWorkbenchBtn')!.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'assistant_open_workbench' });
  });

  it('助手形态隐藏标题条「＋」（会话由助手安排），自助形态保留', () => {
    mountChatView('assistant');
    // 助手形态：不出现（防用户自己再开一条托管会话）
    expect((document.getElementById('newSessionBtn') as HTMLElement).hidden).toBe(true);
    // 另起自助视图：新建入口在
    mountChatView('self');
    expect((document.getElementById('newSessionBtn') as HTMLElement).hidden).toBe(false);
  });

  it('空态口径随形态隔离：自助角色空态不得泄漏进助手座位（2026-11-16 泄漏修复）', () => {
    // 自助视图：角色推送 → 空态角色化（正常形态）
    mountChatView('self');
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家' });
    expect(document.getElementById('emptyState')?.hidden).toBe(false);
    expect(document.getElementById('emptyTitle')?.textContent).toContain('共鸣小说家');
    // 助手视图：空态整块隐藏（新挂载无残余，不靠 hidden 藏上次自助渲染）
    mountChatView('assistant');
    expect(document.getElementById('emptyState')?.hidden).toBe(true);
    expect(document.getElementById('emptyTitle')?.textContent).not.toContain('共鸣小说家');
    // 助手形态下角色推送照常到达（宿主仍推 chat_role_pack 供消息头标签用）：
    // 空态不被重新渲染成角色卡
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家' });
    expect(document.getElementById('emptyState')?.hidden).toBe(true);
    // 回到自助视图：角色化空态成立（空态域内单点判形态）
    mountChatView('self');
    dispatch({ type: 'chat_role_pack', rolePack: '共鸣小说家' });
    expect(document.getElementById('emptyState')?.hidden).toBe(false);
    expect(document.getElementById('emptyTitle')?.textContent).toContain('共鸣小说家');
  });

  it('输入区减法口径：功能群保留、暂停键与状态行整行隐藏（11-16 拍板，11-19 圆环隐藏 + 11-20 整行隐藏两次收敛后的现行判据）', () => {
    // jsdom 不算样式 ⇒ 源码级守卫钉住减法边界，防回退到「一个不留」旧口径
    const css = readFileSync(join(__dirname, '..', 'styles', 'chatStyles.ts'), 'utf8');
    /** 助手形态作用域的 display:none 规则（选择器串 + 规则体） */
    const hiddenRules = [
      ...css.matchAll(/body\[data-form='assistant'\][^{}]*\{[^}]*display:\s*none/g),
    ].map((m) => m[0] as string);
    // 恢复面：功能群（skill/模型/润色/图片）不得在助手作用域隐藏
    const restored = hiddenRules.filter((r) => r.includes('.composer-left'));
    expect(restored).toEqual([]);
    // 减法面 ①：暂停键（运行控制）与状态行整行必须隐藏（同一规则的选择器组）。
    // 11-19 起左右两块（徽章群 / 占用圆环）已各自隐藏，行内无内容 ⇒ 11-20 收敛为整行隐藏；
    // 断言从「.composer-status」改为「.composer-row--status」是判据随形态演进，非放宽。
    const keptRule = hiddenRules.find(
      (r) => r.includes('#pauseBtn') && r.includes('.composer-row--status'),
    );
    expect(keptRule).toBeDefined();
    // 反向守卫：占用圆环自身仍须单独隐藏（整行隐藏的依据之一，撤销整行规则时它得兜住）
    expect(hiddenRules.some((r) => r.includes('#contextOccupancy'))).toBe(true);
    // 右对齐补偿已退役：左块恢复 ⇒ composer-row--main 回两端分布（不得再有 flex-end 覆盖）
    expect(css).not.toMatch(
      /body\[data-form='assistant'\][^{}]*\.composer-row--main[^{}]*flex-end/,
    );
  });

  it('助手形态轮次导航整条收起（2026-11-20 拍板）：与运行过程同规则组，self 形态不受影响', () => {
    // 源码级守卫：助手作用域的运行过程收起规则组须含 .round-nav；jsdom 无样式故读原文
    const css = readFileSync(join(__dirname, '..', 'styles', 'chatStyles.ts'), 'utf8');
    const processHide = [
      ...css.matchAll(/body\[data-form='assistant'\][^{}]*\{[^}]*display:\s*none\s*!important/g),
    ].map((m) => m[0] as string);
    const roundNavRule = processHide.find(
      (r) => r.includes('.round-nav') && r.includes('.process-flow'),
    );
    expect(roundNavRule).toBeDefined();
    // 反向守卫：裸 .round-nav（非后代、非 [hidden] 兜底）的隐藏规则必须带形态前缀——
    // 漏前缀 = 泄漏到 self 工作会话。排除 __track/__bar/__panel 等后代与 [hidden] 兜底。
    const stray = [...css.matchAll(/(?:^|\n)\s*([^\n]*\.round-nav[^\n{]*)\{[^}]*display:\s*none/g)]
      .map((m) => m[1] as string)
      .filter((sel) => /\.round-nav(?=\s|,|$|\[)/.test(sel))
      .filter((sel) => !sel.includes('[hidden]'))
      .filter((sel) => !sel.includes("body[data-form='assistant']"));
    expect(stray).toEqual([]);
  });

  it('助手形态生成中发送键恒为发送态（脱手模型，无停止■）', () => {
    mountChatView('assistant');
    // 生成中（running）+ 空输入：按钮禁用但仍是发送语义，不得变成停止方块
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' } });
    const send = document.getElementById('send') as HTMLButtonElement;
    expect(send.classList.contains('loading')).toBe(false);
    expect(send.title).toContain('Send');
    // 自助视图：同一运行态下是停止语义（形态进矩阵，挂载时定稿）
    mountChatView('self');
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' } });
    const selfSend = document.getElementById('send') as HTMLButtonElement;
    expect(selfSend.classList.contains('loading')).toBe(true);
    expect(selfSend.title).toContain('Stop');
  });

  it('助手形态隐藏待发送插话条（ASSISTANT-QUEUE-DEADKEY-1：无队列管理入口，不留死键）', () => {
    // jsdom 不算样式 ⇒ 源码级守卫钉住这条 display:none；漏掉则助手窗出现
    // 清空/删除按钮但 hostedSeat 对上行显式忽略 = 点了没反应的死键。
    const css = readFileSync(join(__dirname, '..', 'styles', 'chatStyles.ts'), 'utf8');
    expect(css).toMatch(
      /body\[data-form='assistant'\]\s+\.pending-queue-bar\s*\{[^}]*display:\s*none/,
    );
  });

  it('顶部状态签：助手座位运行中显形、自助视图不显示（微信「正在输入…」对应物）', () => {
    mountChatView('assistant');
    const state = document.getElementById('assistantState') as HTMLElement;
    // 首帧无轮在跑：清空不占位
    expect(state.hidden).toBe(true);
    expect(state.textContent).toBe('');

    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' } });
    expect(state.hidden).toBe(false);
    expect(state.textContent).toBe('Advancing…');

    // 收场清空
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'settled' } });
    expect(state.hidden).toBe(true);
    // 自助视图：即使有轮在跑也不显示托管状态签
    mountChatView('self');
    dispatch({ type: 'turn_update', rounds: [], state: { phase: 'running' } });
    const selfState = document.getElementById('assistantState') as HTMLElement;
    expect(selfState.hidden).toBe(true);
    expect(selfState.textContent).toBe('');
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

  it('消息流微信化：气泡面 + 过程隐藏 + 顶部状态签（源码级防回退）', () => {
    const html = readFileSync(join(__dirname, '..', 'panels', 'chatPanelHtml.ts'), 'utf8');
    // 状态节点必须在顶部身份条内（早于标题条），否则「顶部显示状态」无处落地
    expect(html).toContain('id="assistantState"');
    expect(html.indexOf('id="assistantState"')).toBeLessThan(html.indexOf('id="sessionTitleBar"'));

    const hiddenRules = [
      ...css.matchAll(/body\[data-form='assistant'\][^{}]*\{[^}]*display:\s*none/g),
    ].map((m) => m[0] as string);
    // 过程隐藏面：身份标签 / 运行块 / 过程流三类同条规则收起
    const processRule = hiddenRules.find(
      (r) =>
        r.includes('.msg-ai-label') && r.includes('.round-block') && r.includes('.process-flow'),
    );
    expect(processRule).toBeDefined();
    // 交互卡不是「运行过程」：提问卡不得被助手作用域隐藏（确认/授权在 dock 层另管）
    expect(css).not.toMatch(
      /body\[data-form='assistant'\][^{}]*\.ask-inline[^{}]*\{[^}]*display:\s*none/,
    );
    // 气泡面：AI 回复在助手作用域内改左侧气泡并给背景
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.msg\.assistant\s*\{[^}]*align-self:\s*flex-start/,
    );
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.msg\.assistant\s*\{[^}]*background:\s*var\(--surface-card\)/,
    );
  });

  it('同轮多段视觉合并（BUBBLE-MERGE-1）：只连相邻 assistant 段的圆角与内距，不碰底栏/数据', () => {
    // 前段：后面还紧跟 assistant 段时抹掉下圆角与下内距
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.round-group > \.msg\.assistant:has\(\+ \.msg\.assistant\)\s*\{[^}]*border-bottom-left-radius:\s*0[^}]*border-bottom-right-radius:\s*0[^}]*padding-bottom:\s*0/,
    );
    // 后段：紧跟 assistant 段时抹掉上圆角、压缩上内距（保留可读段距）
    expect(css).toMatch(
      /body\[data-form='assistant'\] \.round-group > \.msg\.assistant \+ \.msg\.assistant\s*\{[^}]*border-top-left-radius:\s*0[^}]*border-top-right-radius:\s*0[^}]*padding-top:\s*var\(--sp-2/,
    );
    // 反向守卫：圆角归零规则不得漏形态前缀（漏 = 泄漏到 self 形态的透明段）
    const stray = [
      ...css.matchAll(
        /([^\n{}]*\.msg\.assistant[^\n{}]*)\{[^}]*border-(?:top|bottom)-(?:left|right)-radius:\s*0/g,
      ),
    ]
      .map((m) => m[1] as string)
      .filter((sel) => !sel.includes("body[data-form='assistant']"));
    expect(stray).toEqual([]);
  });
});
