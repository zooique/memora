/**
 * nut-js Spike 验证脚本 —— Phase 4 自动粘贴可行性验证
 *
 * 用途：验证 @nut-tree-fork/nut-js 在当前环境（Node 24 + Windows）的 4 个核心 API 可用性
 * 运行：node scripts/spike-nut-js.mjs
 *
 * 验证项：
 *   1. getActiveWindow() —— 获取前台窗口句柄（Phase 4 步骤 1）
 *   2. setFocus() —— 恢复焦点到原窗口（Phase 4 步骤 4）
 *   3. keyboard.pressKey/releaseKey —— 模拟按键（Phase 4 步骤 5/6 的 Esc/Ctrl+V）
 *   4. keyboard.type —— 逐字符输入（验证 API 可用性，Phase 4 实际用 Ctrl+V 粘贴）
 *
 * 通过标准：4 项全部输出 ✓ 且无异常退出
 * 失败处理：任一 API 抛异常则输出 ✗ + 错误信息，exit code 1
 */
import { getActiveWindow, keyboard, Key } from '@nut-tree-fork/nut-js';

console.log('=== nut-js Spike 验证开始 ===\n');

try {
  // 验证 1：getActiveWindow —— 获取当前前台窗口
  const win = await getActiveWindow();
  const title = await win.title;  // getter 返回 Promise
  const region = await win.region;  // getter 返回 Promise
  console.log(`[1/4] getActiveWindow ✓`);
  console.log(`  标题: ${title}`);
  console.log(`  区域: x=${region.x} y=${region.y} w=${region.width} h=${region.height}`);

  // 验证 2：3 秒后恢复焦点（请在此期间切换到记事本/编辑器验证焦点恢复）
  console.log('\n[2/4] 3 秒后恢复焦点，请切换到其他窗口（如记事本）...');
  await new Promise(r => setTimeout(r, 3000));
  await win.focus();  // API 名为 focus() 非 setFocus()
  console.log(`  focus ✓（焦点应已回到原窗口）`);

  // 验证 3：keyboard.pressKey —— 模拟单键按下（Phase 4 的 Esc 前置）
  await new Promise(r => setTimeout(r, 500));
  await keyboard.pressKey(Key.A);
  await keyboard.releaseKey(Key.A);
  console.log('\n[3/4] keyboard.pressKey(A) ✓（应在原窗口看到输入了一个 "a"）');

  // 验证 4：keyboard.type —— 逐字符输入（验证 API 可用性）
  await keyboard.type(' nut-js-OK');
  console.log('[4/4] keyboard.type ✓（应看到 " nut-js-OK" 被输入）');

  console.log('\n=== 全部通过 ===');
} catch (err) {
  console.error('\n=== 验证失败 ===');
  console.error(err);
  process.exit(1);
}
