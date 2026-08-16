/**
 * 召回默认值共享常量
 *
 * 单一真理源：`DEFAULT_MIN_FALLBACK`（召回保底下限默认值）被 role-pack 策略层
 * 与 memory 召回层两个互不依赖的模块引用。role-pack 仅允许依赖 utils（见
 * backend_layers_rules.md 依赖方向），故下沉到 utils 共享层，避免重复定义。
 *
 * 详见 memory-as-summary.md §4.7 召回保底（recall fallback）。
 */

/** 召回保底下限默认值：语义召回不足时补足至该条数（0=关闭，默认 2） */
export const DEFAULT_MIN_FALLBACK = 2;