#!/usr/bin/env node
/**
 * pnpm 工具链钉版断言（`ENV-PNPM-1`）
 *
 * 存在的理由（2026-10-30 实锤：一次「修环境」把 1 红放大成 5 红）：
 *   宿主 `hosts/memora-vscode` 是**独立 pnpm 项目**（自带 `pnpm-lock.yaml`），但它的
 *   `package.json` 原先没有 `packageManager`。pnpm 10 的 manage-package-manager-versions
 *   **只读当前工作目录**的 `package.json`，不向上继承——实测同一时刻：仓库根读到 10.29.2
 *   （根有声明，自管版本），宿主目录读到 12.16.1（宿主无声明，落到机器全局 pnpm）。
 *   同一份门禁在两个 cwd 跑的是**两个大版本**。
 *
 *   后果不是「报个版本错」，是结构性的：
 *     ① 12.16.1 用 store `v11` + `pnpm-cache/v12`，本机存量只有 `v10` ⇒ `pnpm install --offline`
 *        报 `ERR_PNPM_NO_OFFLINE_META`；
 *     ② pnpm 重建依赖目录是**先删后建**，失败即留下空目录（实测失败后宿主 `node_modules` 为 0 项）；
 *     ③ 于是宿主 typecheck / test / build / dist 契约四步**同根连锁红**，而现场最先看到的是
 *        host:sync —— 归因被表象带走。
 *
 *   最毒的一次误判是**在错误的 cwd 读版本**：在仓库根跑 `pnpm --version` 得 10.29.2，就以为
 *   「声明版本已装好」，而门禁真正执行 `pnpm install` 的是宿主目录。判据必须落在**门禁实际 cwd**。
 *
 * 判据（任一命中即红）：
 *   ① **两处声明逐字相等**：宿主 `packageManager` 必须与根**完全一致**（含 sha512 后缀）。
 *      同一事实两处登记必漂移 ⇒ 用逐字相等把漂移变成红，而不是靠人记得同步。
 *   ② **实跑 == 声明**：在宿主 cwd 执行 `pnpm --version`，结果必须等于声明版本。这一条才真正
 *      对账「门禁会用哪个 pnpm」；① 只是把意图写下来，写下来不等于生效。
 *   ③ **射程下限**：根声明可解析、宿主有 `package.json`、`pnpm --version` 有输出——否则 ①②
 *      会建立在空集上恒绿（同族教训：闸门绿 ≠ 闸门在判）。
 *
 * 插点：`scripts/local-ci.mjs` 的 `toolchain:pnpm` 步，**排在所有步骤之前**（约 0.4s）。
 *   不挂进 host:sync：那一步失败时 `node_modules` 已被清空，再报版本错的代价已从 0.4s
 *   变成一次完整重装 + 四步连锁红。
 *
 * 用法：
 *   node scripts/verify-toolchain-pin.mjs             # 主跑
 *   node scripts/verify-toolchain-pin.mjs --self-test # 自检：纯函数注入变异，确认判据能红
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HOST_DIR = join(ROOT, 'hosts', 'memora-vscode');

/** 从 `pnpm@1.2.3+sha512.…` 抽版本段（容忍缺 sha 后缀） */
function versionOfDeclared(declared) {
  const m = /^pnpm@(?<v>\d+\.\d+\.\d+)(?:[+\-].*)?$/.exec(String(declared ?? '').trim());
  return m ? m.groups.v : '';
}

/** 从 `pnpm --version` 的输出抽版本段（可能带换行或告警尾串） */
function versionOfAmbient(output) {
  const m = /(?<v>\d+\.\d+\.\d+)/.exec(String(output ?? ''));
  return m ? m.groups.v : '';
}

/**
 * 判据本体（纯函数，便于自检注入）：入参全是已解析事实，返回问题列表；空数组 = 绿。
 *
 * @param {object} input
 * @param {string|undefined} input.rootDeclared 根 `package.json#packageManager` 原文
 * @param {string|undefined} input.hostDeclared 宿主 `package.json#packageManager` 原文
 * @param {string} input.ambient 宿主 cwd 下 `pnpm --version` 的原始 stdout（取不到传空串）
 */
export function auditToolchain({ rootDeclared, hostDeclared, ambient }) {
  const issues = [];
  const expected = versionOfDeclared(rootDeclared);
  const actual = versionOfAmbient(ambient);

  // 判据③ 射程下限（先查：声明解析不出来时 ①② 会静默变绿）
  if (!expected) {
    issues.push(
      `根 package.json#packageManager 缺失或无法解析：${JSON.stringify(rootDeclared ?? null)}`,
    );
  }

  // 判据① 两处声明逐字相等
  if (!hostDeclared) {
    issues.push(
      '宿主 hosts/memora-vscode/package.json 未声明 packageManager —— 宿主是独立 pnpm 项目' +
        '（自带 pnpm-lock.yaml），不声明就只能用机器全局 pnpm，版本随机器变' +
        '（2026-10-30 实测同一时刻根 10.29.2 / 宿主 12.16.1）。' +
        `处置：把根的那一行原样复制过去：${JSON.stringify(rootDeclared ?? 'pnpm@<版本>')}`,
    );
  } else if (rootDeclared && hostDeclared !== rootDeclared) {
    issues.push(
      `宿主声明 ${hostDeclared} 与根声明 ${rootDeclared} 不一致——同一事实两处登记，必须逐字相等`,
    );
  }

  // 判据② 门禁实际 cwd 的实跑版本 == 声明版本
  if (!actual) {
    issues.push(
      '宿主 cwd 执行 `pnpm --version` 未取到版本——pnpm 不在 PATH，或该目录的 packageManager ' +
        '无法解析（后者会尝试联网拉取声明版本，离线环境必失败）',
    );
  } else if (expected && actual !== expected) {
    issues.push(
      `宿主 cwd 实跑 pnpm ${actual} ≠ 声明 ${expected}。这不是代码回归，是工具链未对齐；` +
        '直接跑 host:sync 会让 pnpm 先删 node_modules 再失败，宿主四步连锁红。' +
        `处置：装声明版本（npm i -g pnpm@${expected}），或确认 manage-package-manager-versions 未被关掉`,
    );
  }

  return issues;
}

/** 读取某个 package.json 的 packageManager（文件缺失或字段缺失一律 undefined） */
function readDeclared(pkgPath) {
  if (!existsSync(pkgPath)) return undefined;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).packageManager;
  } catch {
    return undefined;
  }
}

/** 在宿主 cwd 取实跑版本（命令固定不参数化；stderr 丢弃，避免 pnpm 告警污染版本串） */
function readAmbientVersion(cwd) {
  try {
    return execSync('pnpm --version', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function loadReal() {
  return {
    rootDeclared: readDeclared(join(ROOT, 'package.json')),
    hostDeclared: readDeclared(join(HOST_DIR, 'package.json')),
    ambient: readAmbientVersion(HOST_DIR),
  };
}

/**
 * 自检：以**真实文件**为基线注入变异。实跑版本可注入（纯函数入参），故 ② 的变异体直接换 ambient。
 * 每条变异都必须被「对应的那条判据」捕获——只求「有报错」会掩盖判据错位。
 */
function selfTest() {
  const base = loadReal();
  const expected = versionOfDeclared(base.rootDeclared);
  const cases = [
    {
      label: '① 宿主未声明 packageManager',
      mutate: (d) => {
        d.hostDeclared = undefined;
      },
      expect: '未声明 packageManager',
    },
    {
      label: '① 宿主与根声明漂移',
      mutate: (d) => {
        d.hostDeclared = `pnpm@${expected.replace(/\d+$/, '0')}+sha512.drift`;
      },
      expect: '不一致',
    },
    {
      label: '② 宿主 cwd 实跑 ≠ 声明',
      mutate: (d) => {
        d.ambient = '0.0.1';
      },
      expect: '实跑 pnpm',
    },
    {
      label: '② 取不到实跑版本',
      mutate: (d) => {
        d.ambient = '';
      },
      expect: '未取到版本',
    },
    {
      label: '③ 根声明不可解析',
      mutate: (d) => {
        d.rootDeclared = 'pnpm@latest';
      },
      expect: '无法解析',
    },
  ];
  let allOk = true;
  for (const c of cases) {
    // 深拷贝：每个变异体互不污染（入参全是 JSON 形状，用 JSON 往返即可）
    const data = JSON.parse(JSON.stringify(base));
    c.mutate(data);
    const issues = auditToolchain(data);
    const hit = issues.some((s) => s.includes(c.expect));
    console.log(
      `  ${hit ? '✅' : '❌'} ${c.label}${hit ? ' 被捕获' : ` 未被捕获（实际：${issues[0] ?? '无问题'}）`}`,
    );
    if (!hit) allOk = false;
  }
  // 反例控制：真实文件必须绿（防过度拦截——把正常的机器判成环境坏，等于制造新的假红）
  const clean = auditToolchain(base);
  const cleanOk = clean.length === 0;
  console.log(
    `  ${cleanOk ? '✅' : '❌'} 反例：真实文件${cleanOk ? '保持全绿' : `被误报：${clean.join(' / ')}`}`,
  );
  if (!cleanOk) allOk = false;
  console.log(allOk ? '\n✅ 自检通过：工具链各判据均可捕获变异' : '\n❌ 自检失败：存在失明判据');
  return allOk ? 0 : 1;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const data = loadReal();
  const issues = auditToolchain(data);
  if (issues.length === 0) {
    console.log(
      `✅ [toolchain-pin] 工具链已确定：pnpm ${versionOfDeclared(data.rootDeclared)} —— ` +
        `根声明 = 宿主声明 = 宿主 cwd 实跑（${data.ambient}）`,
    );
    return 0;
  }
  console.error('❌ [toolchain-pin] 工具链未对齐（这不是代码回归）：');
  for (const s of issues) console.error(`   - ${s}`);
  return 1;
}

process.exit(main());
