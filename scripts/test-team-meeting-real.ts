/**
 * run_team_meeting 可行性验证（探索方案 A · 工具内调 LLM）
 *
 * 验证：把「小组会议」从「task_table + 装配视角切换（T1）」三层叠加，简化为
 * 一个独立工具 run_team_meeting —— 在一次 LLM 调用里注入 N 个角色 persona 全文，
 * 让模型以各角色视角评估同一议题，最后组长视角汇总。
 *
 * 真机实证结论（2026-09-16）：三视角（白话方案设计师 / 共鸣小说家 / memora 助手）
 * 各自观点真实体现角色设定差异（小说家用"人物/内核/风格记忆·设定圣经"、设计师用
 * "种子/最小单元/白话总览/可开发性"、助手讲"跨会话连续性/偏好/隐私噪音成本"）。
 * 技术可行性成立 → 详细结论见 docs/run_team_meeting-探索方案.md §5。
 *
 * 用例：
 *   npx tsx scripts/test-team-meeting-real.ts
 *
 * 环境：三元组 MEMORA_MODEL / MEMORA_BASE_URL / MEMORA_API_KEY
 *       （或 .memora/config.json 占位展开；本脚本直接读环境变量）
 */
import { createProviderFromConfig } from '../src/llm/factory.js';

/** 探针主体：多角色 persona 注入 + 各视角评估（run_team_meeting 最小可验证形态） */
async function probeTeamMeeting(): Promise<void> {
  console.log('━'.repeat(70));
  console.log('run_team_meeting 可行性：多角色 persona 注入 + 各视角评估');
  console.log('━'.repeat(70));

  // 用真实角色包源目录装载 rolePackManager（configDir = 项目根，role-packs 为其子目录）
  const { RolePackManager } = await import('../src/role-pack/rolePackManager.js');
  const manager = new RolePackManager(process.cwd());
  await manager.load('memora助手');
  // 组：组长=设计师，组员=小说家、助手（视角差异鲜明，便于判定「各视角体现角色设定」）
  manager.setRolePackTeams([
    { leader: '白话方案设计师', members: ['共鸣小说家', 'memora助手'] },
  ]);

  // 取三个角色的 persona 全文（buildSystemPrompt 返回 persona+L1技能，模拟 run_team_meeting 拼接源）
  const roles = ['白话方案设计师', '共鸣小说家', 'memora助手'];
  const personaTexts = roles.map((r) => ({ name: r, text: manager.buildSystemPrompt(r) }));
  console.log(`  装载角色：${roles.join(' / ')}`);
  console.log(`  persona 字符：${personaTexts.map((p) => `${p.name}=${p.text.length}`).join(' / ')}\n`);

  // 拼多角色 system prompt（run_team_meeting 形态）
  const topic = '「该不该给一个创意写作工具加记忆功能？」';
  const meetingPrompt =
    '请以以下三个角色的设定与专业视角，分别独立评估议题 ' + topic + '，给出各自的立场与理由（每个视角一段），最后以组长「白话方案设计师」视角做简短汇总。\n\n' +
    '── 角色1（组长）名称：白话方案设计师 ──\n' + (personaTexts[0]?.text ?? '') +
    '\n\n── 角色2（组员）名称：共鸣小说家 ──\n' + (personaTexts[1]?.text ?? '') +
    '\n\n── 角色3（组员）名称：memora 助手 ──\n' + (personaTexts[2]?.text ?? '');

  // 真实 LLM 单次调用（工具内调 LLM 形态）
  const provider = createProviderFromConfig('real', {
    model: process.env['MEMORA_MODEL'] ?? 'mimo-v2.5',
    baseUrl: process.env['MEMORA_BASE_URL'] ?? 'https://api.xiaomimimo.com/v1',
    apiKey: process.env['MEMORA_API_KEY'] ?? '',
  });
  console.log('  📤 一次调用注入 3 个角色 persona，请 LLM 各视角评估 + 组长汇总\n');
  let response = '';
  const start = Date.now();
  for await (const chunk of provider.chat([
    { role: 'system', content: meetingPrompt },
    { role: 'user', content: '请给出各角色观点的正式评估。' },
  ])) {
    if (chunk.content) response += chunk.content;
  }
  const duration = Date.now() - start;
  console.log(`  ⏱️ 单次调用耗时：${duration}ms\n`);

  // 判定：响应是否出现各角色视角 marks，且内容体现角色设定差异
  console.log('  ── LLM 产出 ──');
  console.log('  ' + response.replace(/\n/g, '\n  '));

  const hasDesigner = /白话方案设计师|方案设计师/.test(response) || /种子|最小单元/.test(response);
  const hasNovelist = /共鸣小说家|小说家/.test(response) || /共鸣|人心|人性|冲突/.test(response);
  const hasAssistant = /memora 助手|助手/.test(response) || /通用|协助/.test(response);
  const ok = hasDesigner && hasNovelist && response.length > 200;
  console.log('\n' + '━'.repeat(70));
  console.log(`  判定：设计师视角=${hasDesigner ? '✓' : '✗'} · 小说家视角=${hasNovelist ? '✓' : '✗'} · 助手视角=${hasAssistant ? '✓' : '✗'}`);
  console.log(`  产出长度=${response.length} ${ok ? '→ ✅ 多角色视角真实注入，各视角差异可辨' : '→ ❌ 未达预期判断'}`);
  console.log('━'.repeat(70));
}

// ─── 退出清理（Node 24 + Windows fetch stream 关闭顺序问题） ───
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`💥 未捕获异常：${msg}\n`);
  process.exit(1);
});

probeTeamMeeting()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`💥 探针失败：${msg}\n`);
    process.exit(1);
  });