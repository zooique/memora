/**
 * 精灵端到端演示脚本
 *
 * 使用程序化 API（startSprite）代替 CLI readline，在命令窗中直接演示：
 *   1. 启动精灵 → 对话 → 记忆积累
 *   2. 文件变化 → FileWatcherTrigger 感知
 *   3. 仪表盘变化
 *
 * 用法：npx tsx scripts/demo.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startSprite } from '../src/index.js';

async function main() {
  console.log('=== Memora Sprite 端到端演示 ===\n');

  // 使用临时目录，不污染真实数据
  const demoDir = resolve(tmpdir(), 'memora-sprite-demo');
  mkdirSync(demoDir, { recursive: true });

  // 创建一些测试文件（用于 FileWatcherTrigger 感知）
  writeFileSync(resolve(demoDir, 'test-a.ts'), '// 测试文件 A\nexport const a = 1;\n');
  writeFileSync(resolve(demoDir, 'test-b.ts'), '// 测试文件 B\nexport const b = 2;\n');
  writeFileSync(resolve(demoDir, 'test-c.ts'), '// 测试文件 C\nexport const c = 3;\n');

  console.log(`工作目录：${demoDir}\n`);

  // 1. 启动精灵（使用真实 LLM 配置）
  console.log('1. 启动精灵...');
  const { agent, sprite, close } = await startSprite({ projectPath: demoDir });

  console.log('   ✅ 精灵已启动\n');

  // 2. 查看初始仪表盘
  console.log('2. 初始仪表盘：');
  console.log(sprite.formatDashboard());
  console.log();

  // 3. 第一轮对话：聊聊项目
  console.log('3. 第一轮对话：聊聊 Memora 项目...');
  console.log('───');
  console.log('用户：我在做一个叫 Memora 的 AI 记忆系统，它用 TypeScript 编写，零依赖内核');
  process.stdout.write('精灵：');
  for await (const chunk of agent.chat('我在做一个叫 Memora 的 AI 记忆系统，它用 TypeScript 编写，零依赖内核')) {
    if (chunk.type === 'text') {
      process.stdout.write(chunk.content);
    } else if (chunk.type === 'done') {
      process.stdout.write('\n');
    }
  }
  console.log('───\n');

  // 4. 第二轮对话：偏好
  console.log('4. 第二轮对话：表达偏好...');
  console.log('───');
  console.log('用户：我喜欢简洁优雅的代码，最讨厌过度设计。项目坚持自然生长原则');
  process.stdout.write('精灵：');
  for await (const chunk of agent.chat('我喜欢简洁优雅的代码，最讨厌过度设计。项目坚持自然生长原则')) {
    if (chunk.type === 'text') {
      process.stdout.write(chunk.content);
    } else if (chunk.type === 'done') {
      process.stdout.write('\n');
    }
  }
  console.log('───\n');

  // 5. 第三轮对话：问技术问题
  console.log('5. 第三轮对话：技术讨论...');
  console.log('───');
  console.log('用户：我们刚实现了 SpriteTrigger 接口和 FileWatcherTrigger，你觉得这个设计怎么样？');
  process.stdout.write('精灵：');
  for await (const chunk of agent.chat('我们刚实现了 SpriteTrigger 接口和 FileWatcherTrigger，你觉得这个设计怎么样？')) {
    if (chunk.type === 'text') {
      process.stdout.write(chunk.content);
    } else if (chunk.type === 'done') {
      process.stdout.write('\n');
    }
  }
  console.log('───\n');

  // 6. 查看仪表盘（应该有记忆积累了）
  console.log('6. 对话后仪表盘：');
  console.log(sprite.formatDashboard());
  console.log();

  // 7. 模拟文件变化（触发 FileWatcherTrigger）
  console.log('7. 模拟文件变化...');
  writeFileSync(resolve(demoDir, 'test-a.ts'), '// 文件 A 已修改\n' + Date.now());
  writeFileSync(resolve(demoDir, 'test-b.ts'), '// 文件 B 已修改\n' + Date.now());
  writeFileSync(resolve(demoDir, 'test-c.ts'), '// 文件 C 已修改\n' + Date.now());

  // 等待防抖 + 事件处理
  await new Promise(r => setTimeout(r, 2000));

  // 8. 再次查看仪表盘（应该有文件变化事件）
  console.log('8. 文件变化后仪表盘：');
  console.log(sprite.formatDashboard());
  console.log();

  // 9. 查看精灵配置
  console.log('9. 精灵配置：');
  console.log(sprite.formatConfig());
  console.log();

  // 10. 清理
  console.log('10. 关闭精灵...');
  await close();
  console.log('   ✅ 精灵已关闭\n');

  console.log('=== 演示完成 ===');
  console.log(`\n💡 提示：当前只有 CLI 界面（readline 命令窗）。`);
  console.log(`   IInteraction 接口已预留，未来可接入 Electron 壳提供可视化界面。`);
  console.log(`   详见：docs/实战使用说明.md`);
}

main().catch((err) => {
  console.error('演示失败:', err);
  process.exit(1);
});