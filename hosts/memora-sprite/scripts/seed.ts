/**
 * 记忆种子脚本
 *
 * 塞入编程 + 小说写作 + 设计偏好三类记忆，验证 CRUD 和召回
 *
 * 用法：npx tsx scripts/seed.ts
 */
import { startSprite } from '../src/index.js';

async function main() {
  console.log('=== 记忆种子植入 ===\n');

  // 1. 启动精灵
  const { sprite, close } = await startSprite();

  console.log('1. 植入编程相关记忆...');
  const prog1 = sprite.upsertMemory('insight', 'React经验', '用户有 3 年 React 开发经验，熟悉 hooks、状态管理、SSR 和 Next.js');
  const prog2 = sprite.upsertMemory('insight', 'TypeScript偏好', '用户偏好严格 TypeScript strict 模式，喜欢用 zod 做运行时校验');
  const prog3 = sprite.upsertMemory('insight', '项目架构风格', '用户推崇三层架构：内核零依赖 → 宿主注入实现 → CLI 薄层');
  console.log(`   ${prog1}`);
  console.log(`   ${prog2}`);
  console.log(`   ${prog3}`);

  console.log('\n2. 植入小说写作相关记忆...');
  const novel1 = sprite.upsertMemory('insight', '小说项目', '用户正在写一本架空历史小说，主角是铁匠出身，故事发生在类似宋朝的朝代');
  const novel2 = sprite.upsertMemory('insight', '角色设定', '主角萧铁心，性格内敛坚韧，从铁匠学徒成长为将领。反派是朝廷权臣贾似道');
  const novel3 = sprite.upsertMemory('insight', '写作节奏', '用户偏好张弛有度的叙事节奏，每章 3000-5000 字，对话占比约 40%');
  console.log(`   ${novel1}`);
  console.log(`   ${novel2}`);
  console.log(`   ${novel3}`);

  console.log('\n3. 植入设计偏好...');
  const pref1 = sprite.upsertMemory('profile', '用户身份', '用户叫萧然，既是全栈开发者也是小说作家，两种身份经常切换');
  const pref2 = sprite.upsertMemory('profile', '代码审美', '用户喜欢简洁优雅的代码，反对过度设计，坚持自然生长原则');
  const pref3 = sprite.upsertMemory('profile', '写作审美', '用户偏好克制的文风，不喜欢堆砌辞藻，认为好故事胜于好文笔');
  const pref4 = sprite.upsertMemory('profile', '工具偏好', '用户喜欢命令行工具，偏好本地优先的方案，注重隐私和数据主权');
  console.log(`   ${pref1}`);
  console.log(`   ${pref2}`);
  console.log(`   ${pref3}`);
  console.log(`   ${pref4}`);

  console.log('\n4. 验证：列出所有记忆...');
  const all = sprite.listMemories();
  console.log(`   共 ${all.length} 条记忆：`);
  for (const m of all) {
    console.log(`   [${m.source}] ${m.name}`);
  }

  console.log('\n5. 验证：搜索 "React"...');
  const inspector = sprite.agent.memory;
  if (inspector) {
    const hits = inspector.search('React');
    console.log(`   找到 ${hits.length} 条结果：`);
    for (const h of hits) {
      console.log(`   [${h.name}] ${h.contentPreview}`);
    }
  }

  console.log('\n6. 验证：搜索 "小说"...');
  if (inspector) {
    const hits = inspector.search('小说');
    console.log(`   找到 ${hits.length} 条结果：`);
    for (const h of hits) {
      console.log(`   [${h.name}] ${h.contentPreview}`);
    }
  }

  console.log('\n=== 种子植入完成 ===');
  console.log('\n💡 现在启动精灵就可以基于这些记忆对话了：');
  console.log('   npx tsx src/index.ts');
  console.log('   > 帮我设计一个 React 状态管理方案');
  console.log('   > 我的小说第三章该怎么写，主角刚遇到反派');

  await close();
}

main().catch((err) => {
  console.error('种子植入失败:', err);
  process.exit(1);
});