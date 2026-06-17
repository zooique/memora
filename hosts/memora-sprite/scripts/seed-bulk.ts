/**
 * 批量记忆种子脚本（V-101 触发：100+ 记忆）
 *
 * 植入 80+ 条记忆，涵盖编程、小说、设计、学习、工具等多个领域
 * 确保总记忆量达到 100+，触发向量召回增强
 *
 * 用法：npx tsx scripts/seed-bulk.ts
 */
import { startSprite } from '../src/index.js';

// 记忆种子数据
const TECH_INSIGHTS = [
  ['React Hooks 原理', '用户深入理解 React Hooks 闭包陷阱和 useRef 的底层原理'],
  ['Node.js Stream', '用户熟悉 Node.js Stream API，擅长处理大数据流场景'],
  ['TypeScript 泛型', '用户精通 TypeScript 泛型、条件类型和模板字面量类型'],
  ['数据库索引', '用户了解 B+Tree 索引原理，能在 SQLite 中正确使用复合索引'],
  ['Git 工作流', '用户偏好 trunk-based 开发，使用 rebase 而非 merge'],
  ['Docker 基础', '用户能用 Docker 容器化应用，编写多阶段 Dockerfile'],
  ['CI/CD 流水线', '用户有 GitHub Actions 配置经验，熟悉缓存策略和矩阵构建'],
  ['REST API 设计', '用户推崇 RESTful 风格，注重资源命名和状态码语义'],
  ['GraphQL 入门', '用户了解 GraphQL 的 query/mutation/subscription 模式'],
  ['WebSocket 实时通信', '用户有 WebSocket 实时推送经验，处理过断线重连'],
  ['CSS Grid 布局', '用户偏好 CSS Grid 做复杂布局，Flexbox 做组件内排列'],
  ['前端性能优化', '用户关注 Core Web Vitals，擅长懒加载和代码分割'],
  ['测试驱动开发', '用户坚持写测试，但不过度追求 100% 覆盖率'],
  ['错误处理模式', '用户喜欢 Result 类型模式，避免 try-catch 滥用'],
  ['函数式编程', '用户倾向不可变数据和纯函数，避免副作用'],
  ['事件驱动架构', '用户理解 EventEmitter 模式，在 Node.js 中大量使用'],
  ['微服务拆分', '用户认为微服务应按业务边界拆分，而非技术层'],
  ['API 版本管理', '用户偏好 URL 路径版本化（/v1/）而非 Header 版本'],
  ['日志最佳实践', '用户使用结构化日志（pino），每个日志带 correlation ID'],
  ['监控与告警', '用户了解 RED 和 USE 方法论，配置过 Prometheus 告警'],
  ['安全最佳实践', '用户注重输入校验、SQL 注入防护和 CSRF Token'],
  ['代码审查文化', '用户认为代码审查应以学习为目的，而非找茬'],
  ['文档即代码', '用户坚持文档与代码同仓库，用 Markdown 写 RFC'],
  ['依赖管理', '用户定期审计 npm 依赖，使用 Renovate 自动更新'],
  ['Monorepo 管理', '用户有 Turborepo 经验，了解 workspace 协议'],
];

const NOVEL_INSIGHTS = [
  ['人物弧光', '用户研究过英雄之旅和救赎弧光，注重角色成长的可信度'],
  ['场景描写', '用户偏好用五感描写场景，但控制在 3 句以内避免拖沓'],
  ['悬念设置', '用户擅长在章节末尾埋悬念，下一章开头再揭晓'],
  ['对话节奏', '用户认为对话应推动剧情，而非单纯的信息交换'],
  ['世界观构建', '用户推崇"冰山原则"——只展示 10%，但构思了 100%'],
  ['历史考据', '用户会查阅大量史料确保架空历史的内部逻辑自洽'],
  ['伏笔管理', '用户在 Notion 中维护伏笔清单，确保每条伏笔都有回收'],
  ['多线叙事', '用户尝试过双线叙事，主线与副线在第三章交汇'],
  ['反套路设计', '用户喜欢在经典套路中加反转，让读者预期落空又惊喜'],
  ['文笔风格', '用户推崇余华的简洁和张爱玲的精准，追求"一字千金"'],
  ['编辑技巧', '用户写完初稿后至少放一周再修改，用"冷眼"审视'],
  ['灵感来源', '用户的灵感多来自真实历史人物和民间传说'],
  ['读者预期管理', '用户认为好故事应"意料之外，情理之中"'],
  ['第一人称视角', '用户尝试过第一人称，但认为第三人称有限视角更适合'],
  ['情感描写', '用户偏好用动作和对话暗示情感，而非直接心理描写'],
];

const DESIGN_PREFS = [
  ['追求简洁', '用户认为"少即是多"，代码和设计都应如此'],
  ['反对过度设计', '用户坚持"你不需要它"原则，不为未来需求写代码'],
  ['自然生长', '用户遵循"三次法则"——第三次出现才抽抽象'],
  ['本地优先', '用户偏好本地工具，数据主权高于云服务便利'],
  ['命令行美学', '用户认为 CLI 比 GUI 更高效、更优雅'],
  ['开源精神', '用户认同开源文化，愿意回馈社区'],
  ['持续交付', '用户认为部署应自动化，手动部署是技术债务'],
  ['渐进增强', '用户推崇渐进增强而非大爆炸式重构'],
  ['约定优于配置', '用户喜欢 Rails 式的约定优于配置哲学'],
  ['可观测性', '用户认为日志、指标、追踪是系统必备而非可选项'],
  ['不可变基础设施', '用户理解不可变部署的价值，避免手动修补服务器'],
  ['领域驱动设计', '用户认同 DDD 核心思想，但认为不应教条化'],
  ['技术债务管理', '用户定期偿还技术债务，认为债务会利滚利'],
  ['向后兼容', '用户认为 API 变更应向后兼容，破坏性变更需版本号'],
  ['实用主义', '用户是实用主义者——完美是好的敌人'],
];

async function main() {
  console.log('=== 批量记忆种子植入（V-101 触发） ===\n');

  const { sprite, close } = await startSprite();

  // 1. 查看初始记忆数
  const initial = sprite.listMemories();
  console.log(`初始记忆数：${initial.length}`);
  console.log();

  // 2. 批量植入技术洞察
  console.log(`植入 ${TECH_INSIGHTS.length} 条技术洞察...`);
  for (const [name, content] of TECH_INSIGHTS) {
    sprite.upsertMemory('insight', name, content);
  }
  console.log(`   ✅ 完成`);

  // 3. 批量植入小说洞察
  console.log(`植入 ${NOVEL_INSIGHTS.length} 条小说洞察...`);
  for (const [name, content] of NOVEL_INSIGHTS) {
    sprite.upsertMemory('insight', name, content);
  }
  console.log(`   ✅ 完成`);

  // 4. 批量植入设计偏好
  console.log(`植入 ${DESIGN_PREFS.length} 条设计偏好...`);
  for (const [name, content] of DESIGN_PREFS) {
    sprite.upsertMemory('profile', name, content);
  }
  console.log(`   ✅ 完成`);

  // 5. 验证总数
  const all = sprite.listMemories();
  console.log(`\n总记忆数：${all.length}`);
  console.log(all.length >= 100 ? '   ✅ 已触发 V-101 阈值（100+）' : '   ⚠️ 未达阈值');

  // 6. 按 source 统计
  const sources = new Map<string, number>();
  for (const m of all) {
    sources.set(m.source, (sources.get(m.source) ?? 0) + 1);
  }
  console.log('\n按来源统计：');
  for (const [s, c] of sources) {
    console.log(`   ${s}: ${c} 条`);
  }

  // 7. 搜索测试
  const inspector = sprite.agent.memory;
  if (inspector) {
    console.log('\n搜索测试：');
    for (const q of ['React', '小说', '简洁', 'TypeScript', '历史']) {
      const hits = inspector.search(q, 3);
      console.log(`   "${q}" → ${hits.length} 条`);
    }
  }

  console.log('\n=== 批量种子植入完成 ===');
  await close();
}

main().catch((err) => {
  console.error('失败:', err);
  process.exit(1);
});