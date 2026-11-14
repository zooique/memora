/**
 * 会话记录的角色包名 · 读侧归一化（**纯函数，判据单点**）
 *
 * 为什么单独一个文件：本判据有两类消费面——会话读取口（`sessionRolePack.ts`，带 vscode 文案）
 * 与主控清单工具（`workSessionTools.ts`，被 node 单测直接 import）。后者的测试只 mock 了
 * `vscode` 的最小面，若从 `sessionRolePack.ts` 借这个函数，会把该模块的模块级 l10n 取值一起拖进来
 * （测试直接红）。所以判据放在**零依赖**模块里，两边共用同一份实现，不各写一套 trim / 空串判断。
 */

/**
 * 把元数据原值收敛成「有名字 / 没有名字」
 *
 * 空串与纯空白都算**没有记录**，不是「默认包」——默认包的解析在装配链兜底，
 * 读侧不得替用户造一个选择记录。
 *
 * @param raw 元数据里的原值（类型不可信）
 * @returns 去空白后的名字；非字符串 / 空串 / 纯空白一律 `undefined`
 */
export function normalizeRolePackName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
