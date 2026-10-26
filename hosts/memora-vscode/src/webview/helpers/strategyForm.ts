/**
 * strategyForm — 角色策略键表单的收集语义（纯函数）
 *
 * 从 `scripts/rolesView.ts` 抽出（2026-10-26）。为什么与 `strategyKeyMeta.ts` 分开：
 * 两者的 `kind` **不同源**——本文件的 `StrategyFormCell['kind']` 是 5 值控件形态
 * （enum/number/text/multi/switch），元数据表只有 `control?: 'switch'` 一个覆盖标记，
 * 根本没有 kind 字段。合成一个文件会让人误以为是同一套枚举。
 *
 * DOM 读取与表单构建仍在 rolesView（依赖 document）；本文件只做「读到的原始值 → strategy 段」，
 * 因此保存链路的数据纪律可脱离 DOM 单测（守卫见 `__tests__/rolesKeyface.test.ts`）。
 */

/** 表单快照单元（收集 strategy 前的中间形态）：DOM 读取薄封装后的纯数据 */
export interface StrategyFormCell {
  /** 所属策略阶段 */
  stage: string;
  /** 键名 */
  key: string;
  /** 控件形态（switch = 布尔数字键的开关覆盖形态） */
  kind: 'enum' | 'number' | 'text' | 'multi' | 'switch';
  /** 控件原始值：enum/number/text=字符串（''=空格子）/ multi=勾选值数组 / switch=布尔 */
  raw: string | readonly string[] | boolean;
}

/**
 * 从表单快照收集 strategy 段（纯函数，保存链路可测）。
 *
 * 语义纪律（方案 §3）：
 *   - 空格子 = 不写入该键（保持「未声明」语义，不是写 0）；
 *   - 多选全不勾 = 不写入（空数组会被内核 isAskOn 判错，等价「未声明」）；
 *   - 开关未勾 = 不写入（selfReview 默认 0=关，未声明与 0 同语义，不固化 0）；
 *   - preserved：原文中键面未覆盖的键（内核新增键宿主未升级 / 未知键）原样并入，
 *     防止「整段替换 strategy」时静默丢数据（保真红线）。
 */
export function collectStrategyFromForm(
  cells: readonly StrategyFormCell[],
  preserved?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const c of cells) {
    let value: unknown;
    if (c.kind === 'multi') {
      const arr = [...(c.raw as readonly string[])];
      if (arr.length === 0) continue;
      value = arr;
    } else if (c.kind === 'switch') {
      if (c.raw !== true) continue;
      value = 1;
    } else {
      const s = (c.raw as string).trim();
      if (s === '') continue;
      if (c.kind === 'number') {
        // 输入框原文转数值；type=number 输入框坏值表现为 ''（上方已挡），此处再防 NaN
        const n = Number(s);
        if (!Number.isFinite(n)) continue;
        value = n;
      } else {
        value = s;
      }
    }
    (out[c.stage] ??= {})[c.key] = value;
  }
  // 键面未覆盖的原文键原样保留（透明保真，不静默丢弃）
  if (preserved) {
    for (const [stage, kv] of Object.entries(preserved)) {
      for (const [key, v] of Object.entries(kv)) {
        (out[stage] ??= {})[key] = v;
      }
    }
  }
  return out;
}
