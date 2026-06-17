/**
 * P1 验证脚本：V-101 记忆召回 + V-103 角色匹配 + V-102 归档反馈
 *
 * 用法：npx tsx scripts/verify-p1.ts
 */
import { startSprite } from '../src/index.js';

async function main() {
  console.log('=== P1 验证：记忆召回 + 角色匹配 + 归档反馈 ===\n');

  const { agent, sprite, close } = await startSprite();

  console.log('初始仪表盘：');
  console.log(sprite.formatDashboard());
  console.log('───\n');

  // ── V-103: 角色自动匹配 ──
  console.log('【V-103】角色自动匹配测试...');
  console.log('用户：我最近在学 Rust，感觉 ownership 好难理解');
  process.stdout.write('精灵：');
  for await (const chunk of agent.chat('我最近在学 Rust，感觉 ownership 好难理解')) {
    if (chunk.type === 'text') process.stdout.write(chunk.content);
    else if (chunk.type === 'done') process.stdout.write('\n');
  }
  console.log('───\n');

  // ── V-101: 记忆召回 ──
  console.log('【V-101】记忆召回测试...');
  console.log('用户：我之前跟你聊过我对 React 的了解程度，还记得吗？');
  process.stdout.write('精灵：');
  for await (const chunk of agent.chat('我之前跟你聊过我对 React 的了解程度，还记得吗？')) {
    if (chunk.type === 'text') process.stdout.write(chunk.content);
    else if (chunk.type === 'done') process.stdout.write('\n');
  }
  console.log('───\n');

  // ── 跨领域召回 ──
  console.log('【V-101】跨领域召回测试...');
  console.log('用户：作为一个既写代码又写小说的人，你觉得我的共同特质是什么？');
  process.stdout.write('精灵：');
  for await (const chunk of agent.chat('作为一个既写代码又写小说的人，你觉得我的共同特质是什么？')) {
    if (chunk.type === 'text') process.stdout.write(chunk.content);
    else if (chunk.type === 'done') process.stdout.write('\n');
  }
  console.log('───\n');

  // ── V-102: 归档反馈（多轮对话产生积累） ──
  console.log('【V-102】归档反馈测试...');
  console.log('用户：我最近在重构 Memora 的记忆系统，想把原来的关键词匹配改成向量搜索');
  process.stdout.write('精灵：');
  for await (const chunk of agent.chat('我最近在重构 Memora 的记忆系统，想把原来的关键词匹配改成向量搜索')) {
    if (chunk.type === 'text') process.stdout.write(chunk.content);
    else if (chunk.type === 'done') process.stdout.write('\n');
  }
  console.log('───\n');

  // ── 最终仪表盘 ──
  console.log('【最终仪表盘】');
  console.log(sprite.formatDashboard());
  console.log();

  // ── 查看新增记忆 ──
  console.log('【新增记忆】对话后产生的 insight：');
  const all = sprite.listMemories();
  const insights = all.filter(m => m.source === 'insight');
  console.log(`   insight 共 ${insights.length} 条（对话可能产生新的提炼）`);

  console.log('\n=== 验证完成 ===\n');
  console.log('💡 启动精灵继续交互：npx tsx src/index.ts');

  await close();
}

main().catch((err) => {
  console.error('验证失败:', err);
  process.exit(1);
});