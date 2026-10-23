/**
 * 模块解析钩子：把 `vscode` 解析到冒烟用的 stub（供 verify-bundle-loadable.mjs 注入）
 *
 * 扩展宿主才提供 `vscode` 模块，node 里不存在 ⇒ 直接 import 产物必然失败。
 * 本钩子只把这一个外部标识重定向到生成的 stub 文件，其余解析原样透传，
 * 保证被验的仍是**真实产物本身**（不是另构建一份 alias 产物）。
 *
 * 由 `node:module` 的 `register()` 在独立 hooks 线程加载——故 stub 路径只能
 * 硬编码约定（`dist/.bundle-smoke/vscode-stub.mjs`），不能靠主脚本传参。
 */
/** stub 文件的固定落点（与主脚本 verify-bundle-loadable.mjs 约定一致） */
const STUB_URL = new URL('../dist/.bundle-smoke/vscode-stub.mjs', import.meta.url).href;

/**
 * @param specifier 被解析的模块标识
 * @param context 解析上下文
 * @param nextResolve 默认解析
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vscode') {
    return { url: STUB_URL, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
