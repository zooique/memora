/**
 * 召回默认值共享常量——单一真理源：`DEFAULT_MIN_FALLBACK` 被 role-pack 策略层与 memory
 * 召回层两个互不依赖的模块引用；role-pack 仅允许依赖 utils，故下沉此处避免重复定义。
 */

/** 召回保底下限默认值：语义召回不足时补足至该条数（0=关闭，默认 2） */
export const DEFAULT_MIN_FALLBACK = 2;