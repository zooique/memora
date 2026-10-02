/**
 * rolesKeyface 测试 — 键面一致性守卫 + 表单收集纯函数（RP-EDIT-1）
 *
 * 守卫背景：内核对未知策略键只报 warning（validator.ts 未知键非 error），「键名拼错」
 * 是纯静默失败——唯一能抓住它的网就是本文件的双向一致守卫：
 *   - 内核 describeStrategyKeys() 加键、webview STRATEGY_KEY_META 漏翻译 → 测试红（提示补标签）；
 *   - webview 映射拼错键名（内核无此键）→ 测试红。
 * 内核侧键面派生正确性（枚举/区间/0 哨兵折算）锁定在
 * src/role-pack/__tests__/strategyKeys.test.ts，本文件只管「两侧键集对齐 + 元数据完整」。
 *
 * 附带锁定 collectStrategyFromForm 收集语义（保存链路的数据纪律，方案 §3）：
 * 空格子不写入 / 多选全不勾不写入 / 开关未勾不写入 / 键面未覆盖的原文键原样并入。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { describeStrategyKeys } from '@zooique/memora';
import {
  STRATEGY_KEY_META,
  collectStrategyFromForm,
  type StrategyFormCell,
} from '../scripts/rolesView.js';

describe('键面一致性守卫（RP-EDIT-1 核心护栏）', () => {
  /** 内核键面键集（stage.key 复合键；键名跨阶段唯一，plain key 亦不撞） */
  const kernelFaces = describeStrategyKeys();
  const kernelKeys = new Set(kernelFaces.map((f) => `${f.stage}.${f.key}`));
  const kernelPlainKeys = new Set(kernelFaces.map((f) => f.key));
  /** webview 中文映射键集 */
  const metaKeys = new Set(Object.keys(STRATEGY_KEY_META));

  it('内核键面 ↔ webview STRATEGY_KEY_META 键集合双向相等（双向漂移都红）', () => {
    // 方向一：内核有、webview 没翻译 → 提示补中文标签
    const missingInMeta = [...kernelPlainKeys].filter((k) => !metaKeys.has(k));
    expect(
      missingInMeta,
      `内核键面新增了键但 webview STRATEGY_KEY_META 缺少中文标签：[${missingInMeta.join(', ')}]。请在 rolesView.ts 的 STRATEGY_KEY_META 补 label/tip（缺失时 UI 兜底显示英文键名）。`,
    ).toEqual([]);
    // 方向二：webview 写了、内核没有 → 键名拼错或已删除
    const extraInMeta = [...metaKeys].filter((k) => !kernelPlainKeys.has(k));
    expect(
      extraInMeta,
      `webview STRATEGY_KEY_META 存在内核键面中没有的键（拼错或已删）：[${extraInMeta.join(', ')}]。`,
    ).toEqual([]);
  });

  it('前置自证（防假绿）：两侧键集均非空且含已知键', () => {
    expect(kernelKeys.size).toBeGreaterThan(0);
    expect(metaKeys.size).toBeGreaterThan(0);
    expect(kernelPlainKeys.has('stepBudget')).toBe(true);
    expect(metaKeys.has('stepBudget')).toBe(true);
  });

  it('每个映射条目 label/tip 非空（渲染降级线以上）', () => {
    for (const [key, entry] of Object.entries(STRATEGY_KEY_META)) {
      expect(entry.label.trim(), `${key}.label 不得为空`).not.toBe('');
      expect(entry.tip.trim(), `${key}.tip 不得为空（悬停含义是本功能核心交付）`).not.toBe('');
    }
  });

  it('askOn 的 optionLabels 覆盖内核 ASK_TRIGGERS 全部选项（多选UI 不露英文原文）', () => {
    const face = kernelFaces.find((f) => f.key === 'askOn');
    const labels = STRATEGY_KEY_META['askOn']?.optionLabels ?? {};
    for (const opt of face?.options ?? []) {
      expect(labels[opt], `askOn 选项 ${opt} 缺少中文映射`).toBeTruthy();
    }
  });

  it('每个 number 键必须带 range（NUM-HINT-1 实时检测的前提）', () => {
    // 编辑表单的输入超限红框（rolesStyles :out-of-range）依赖 buildFormRow 写入的
    // input[min]/max——键面 range 缺失 = 红框对该键静默失效（只剩保存时内核拦截）。
    // 内核 describeStrategyKeys 防御分支（无 range 数值键，当前无实例）若被触发，
    // 本守卫即红：逼新增数值键在 STRATEGY_KEY_RULES 声明区间，而非放开 UI 降级。
    const missing = kernelFaces
      .filter((f) => f.kind === 'number' && !f.range)
      .map((f) => `${f.stage}.${f.key}`);
    expect(
      missing,
      `number 键缺少 range（输入超限红框将静默失效）：[${missing.join(', ')}]。请在内核 STRATEGY_KEY_RULES 为该键补 intRange 区间。`,
    ).toEqual([]);
  });
});

describe('collectStrategyFromForm —— 表单收集语义（方案 §3）', () => {
  /** 快捷构造 */
  const cell = (
    stage: string,
    key: string,
    kind: StrategyFormCell['kind'],
    raw: StrategyFormCell['raw'],
  ): StrategyFormCell => ({ stage, key, kind, raw });

  it('空格子不写入（保持「未声明」语义，不是写 0/空串）', () => {
    const out = collectStrategyFromForm([
      cell('act', 'temperature', 'number', ''),
      cell('prepare', 'summaryFocus', 'text', '   '),
      cell('act', 'toolMode', 'enum', ''),
      cell('global', 'stepBudget', 'number', '100'),
    ]);
    // stepBudget 属 global 阶段（STRATEGY_KEY_RULES.global），非 act
    expect(out).toEqual({ global: { stepBudget: 100 } });
  });

  it('数值转数字、文本保留字符串、enum 写字符串', () => {
    const out = collectStrategyFromForm([
      cell('global', 'stepBudget', 'number', '200'),
      cell('act', 'temperature', 'number', '0.7'),
      cell('prepare', 'summaryFocus', 'text', 'code'),
      cell('act', 'toolReadonly', 'enum', 'readonly'),
    ]);
    expect(out).toEqual({
      global: { stepBudget: 200 },
      act: { temperature: 0.7, toolReadonly: 'readonly' },
      prepare: { summaryFocus: 'code' },
    });
  });

  it('multi：有勾选写数组、全不勾不写入（空数组会被内核 isAskOn 判错）', () => {
    const filled = collectStrategyFromForm([
      cell('global', 'askOn', 'multi', ['ambiguity', 'confirm']),
    ]);
    expect(filled).toEqual({ global: { askOn: ['ambiguity', 'confirm'] } });
    const emptied = collectStrategyFromForm([cell('global', 'askOn', 'multi', [])]);
    expect(emptied).toEqual({});
  });

  it('switch：勾选写 1、未勾不写入（selfReview 默认 0=关，同语义不固化 0）', () => {
    expect(collectStrategyFromForm([cell('reflect', 'selfReview', 'switch', true)])).toEqual({
      reflect: { selfReview: 1 },
    });
    expect(collectStrategyFromForm([cell('reflect', 'selfReview', 'switch', false)])).toEqual({});
  });

  it('preserved：键面未覆盖的原文键原样并入（整段替换不静默丢数据）', () => {
    const out = collectStrategyFromForm([cell('global', 'stepBudget', 'number', '100')], {
      act: { futureKey: 'keep-me' },
    });
    expect(out).toEqual({
      global: { stepBudget: 100 },
      act: { futureKey: 'keep-me' },
    });
  });
});
