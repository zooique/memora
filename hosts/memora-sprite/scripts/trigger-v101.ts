/**
 * V-101 自然生长触发器
 *
 * 1. 补 20 条记忆到 100+（触发阈值）
 * 2. 构造语义相近但关键词不同的查询，展示关键词召回缺口
 *
 * 用法：npx tsx scripts/trigger-v101.ts
 */
import { startSprite } from '../src/index.js';

// 补充记忆（跨领域，确保语义多样性）
const EXTRA_MEMORIES: Array<[string, string, string]> = [
  // 生活与效率
  ['profile', '日程管理偏好', '用户使用番茄工作法，25分钟专注 + 5分钟休息，每天完成 8-12 个番茄'],
  ['profile', '读书习惯', '用户每周读一本书，偏爱非虚构类，读完会写 300 字摘要'],
  ['profile', '笔记系统', '用户用 Zettelkasten 卡片笔记法，每条笔记原子化，用双向链接关联'],
  ['profile', '旅行规划风格', '用户旅行前做详细攻略但留 30% 空白给意外发现，偏好深度游而非打卡'],
  ['profile', '咖啡偏好', '用户喜欢手冲浅烘单品豆，水温 92°C，粉水比 1:15'],
  // 更多技术领域
  ['insight', 'Python 数据处理', '用户用 Pandas 和 Polars 做数据分析，偏好 Polars 的惰性求值'],
  ['insight', 'Rust 内存模型', '用户理解 Rust 所有权、借用和生命周期，写过 unsafe 代码'],
  ['insight', 'DevOps 实践', '用户推崇 GitOps，用 ArgoCD 做声明式部署，所有配置版本化'],
  ['insight', '消息队列选型', '用户对比过 Kafka、RabbitMQ 和 NATS，认为 NATS 适合轻量级场景'],
  ['insight', '前端状态管理', '用户从 Redux 迁移到 Zustand，认为 boilerplate 减少 70%'],
  // 创作与表达
  ['insight', '诗歌创作', '用户写现代诗，受海子和顾城影响，追求意象的陌生化'],
  ['insight', '剧本结构', '用户研究过三幕剧和救猫咪节拍表，认为结构是创作的自由而非束缚'],
  ['insight', '非虚构写作', '用户偏好叙事性非虚构，用小说的技巧写真实故事'],
  // 健康与思维
  ['insight', '运动习惯', '用户每周跑步 3 次，每次 5 公里，配速 5:30'],
  ['insight', '思维模型', '用户收集思维模型（复利、反脆弱、第二序效应），用于决策分析'],
  ['insight', '睡眠优化', '用户关注睡眠质量，使用 90 分钟睡眠周期理论安排作息'],
  // 设计更多偏好
  ['profile', '配色偏好', '用户喜欢低饱和度配色，常用 Nord 和 Catppuccin 主题'],
  ['profile', '字体偏好', '用户编程用 JetBrains Mono，写作用霞鹜文楷，终端用 Iosevka'],
  ['profile', '编辑器偏好', '用户使用 VS Code 为主，Neovim 为辅，认为两者互补'],
  ['profile', '信息摄入', '用户通过 RSS 和 Newsletter 获取信息，拒绝算法推荐'],
];

// 语义相近但关键词不同的查询对
const SEMANTIC_QUERIES = [
  { query: '状态管理', expectKeywords: ['React', 'Redux', 'Zustand', '前端'], expectName: '前端状态管理' },
  { query: '代码质量', expectKeywords: ['测试', '审查', 'review', 'lint'], expectName: '测试驱动开发' },
  { query: '写作技巧', expectKeywords: ['小说', '创作', '描写', '叙事', '文笔'], expectName: '文笔风格' },
  { query: '时间管理', expectKeywords: ['番茄', '效率', '日程', '专注'], expectName: '日程管理偏好' },
  { query: '数据存储', expectKeywords: ['数据库', '索引', 'SQLite', '存储'], expectName: '数据库索引' },
  { query: '部署流程', expectKeywords: ['CI/CD', 'Docker', '自动化', 'GitOps', 'DevOps'], expectName: 'DevOps 实践' },
  { query: '程序设计', expectKeywords: ['函数式', 'DDD', '架构', '模式', '设计'], expectName: '函数式编程' },
  { query: '阅读习惯', expectKeywords: ['读书', '笔记', '摘要', '书籍'], expectName: '读书习惯' },
  { query: 'API 开发', expectKeywords: ['REST', 'GraphQL', '版本', '接口'], expectName: 'REST API 设计' },
  { query: '身心健康', expectKeywords: ['跑步', '运动', '睡眠', '冥想'], expectName: '运动习惯' },
];

async function main() {
  console.log('=== V-101 自然生长触发 ===\n');
  console.log('目标：证明 100+ 记忆下，关键词召回存在语义缺口，需要向量召回补强\n');

  const { sprite, close } = await startSprite();

  // ─── Step 1: 补记忆到 100+ ───
  const storage = sprite.agent.storage;
  const beforeCount = storage?.count() ?? 0;
  console.log(`Step 1: 当前记忆数 ${beforeCount}`);

  if (beforeCount < 100) {
    console.log(`植入 ${EXTRA_MEMORIES.length} 条补充记忆...`);
    for (const [source, name, content] of EXTRA_MEMORIES) {
      sprite.upsertMemory(source, name, content);
    }
    const afterCount = storage?.count() ?? 0;
    console.log(`   ✅ 植入后记忆数：${afterCount} ${afterCount >= 100 ? '（已触发 V-101 阈值）' : ''}`);
  } else {
    console.log('   已满足 100+ 阈值，跳过植入');
  }

  const inspector = sprite.agent.memory;
  if (!inspector) {
    console.log('❌ 记忆检视器不可用');
    await close();
    return;
  }

  // ─── Step 2: 语义查询对比 ───
  console.log('\nStep 2: 语义查询对比测试');
  console.log('─'.repeat(60));

  let totalQueries = 0;
  let keywordMisses = 0;

  for (const { query, expectKeywords, expectName } of SEMANTIC_QUERIES) {
    totalQueries++;
    const results = inspector.search(query, 10);

    // 检查：期望的记忆名是否在结果中
    const foundByName = results.some(r => r.name === expectName);
    // 检查：是否有任何包含期望关键词的结果
    const foundByKeyword = results.some(r =>
      r.content && expectKeywords.some(kw => r.content.toLowerCase().includes(kw.toLowerCase()))
    );

    const status = foundByName ? '✅' : foundByKeyword ? '⚠️' : '❌';
    if (!foundByName && !foundByKeyword) keywordMisses++;

    console.log(`${status} 查询"${query}" → 期望命中"${expectName}"`);
    if (results.length > 0) {
      console.log(`   实际 Top 3: ${results.slice(0, 3).map(r => r.name).join(' | ')}`);
    } else {
      console.log('   实际结果: (无结果)');
    }
    if (!foundByName && !foundByKeyword) {
      console.log('   🔴 关键词召回缺口：语义相关但无关键词重叠');
    }
    console.log();
  }

  // ─── Step 3: 统计 ───
  console.log('─'.repeat(60));
  console.log('\nStep 3: 统计');
  const recallRate = ((totalQueries - keywordMisses) / totalQueries * 100).toFixed(1);
  console.log(`   总查询数：${totalQueries}`);
  console.log(`   关键词命中：${totalQueries - keywordMisses}`);
  console.log(`   关键词遗漏：${keywordMisses}`);
  console.log(`   关键词召回率：${recallRate}%`);

  if (keywordMisses > 0) {
    console.log(`\n   🔴 V-101 自然生长已触发！`);
    console.log(`   在 ${totalQueries} 个语义查询中，${keywordMisses} 个因无关键词重叠而遗漏。`);
    console.log(`   这证明了纯关键词召回的局限性——需要向量相似度召回作为补充通道。`);
  } else {
    console.log(`\n   🟢 所有语义查询均被关键词召回覆盖，暂无向量召回需求。`);
  }

  console.log('\n=== V-101 触发验证完成 ===');
  await close();
}

main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});