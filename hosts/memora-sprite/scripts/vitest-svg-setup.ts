/**
 * Vitest SVG 全局类型补齐
 *
 * jsdom 未实现部分 SVG 元素类型（如 SVGPolygonElement、SVGCircleElement），
 * 导致渲染进程测试中 instanceof 检查报 ReferenceError。
 * 本文件在 vitest 启动时注入这些缺失的全局类型，确保测试正常执行。
 *
 * 注意：这些 mock 仅用于通过 instanceof 检查，
 * 实际 DOM 元素不会成为这些 mock 的实例（instanceof 返回 false），
 * 因此不会影响测试逻辑的正确性。
 */

// 需要补齐的 SVG 元素类型列表
const SVG_ELEMENT_TYPES = [
  'SVGPolygonElement',
  'SVGCircleElement',
  'SVGElement',
  'SVGGraphicsElement',
  'SVGGeometryElement',
] as const;

for (const name of SVG_ELEMENT_TYPES) {
  if (typeof globalThis[name as keyof typeof globalThis] === 'undefined') {
    (globalThis as Record<string, unknown>)[name] = class {};
  }
}