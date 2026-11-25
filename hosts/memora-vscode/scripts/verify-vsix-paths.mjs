/**
 * vsix 路径塌缩守卫（打包后检查）
 *
 * 背景（0.13.0 发版实证）：VS Marketplace 服务端解析 vsix 条目路径时按单字节编码
 * 解读 UTF-8 字节，非 ASCII 逐字节变成 '?'。于是「同字节数的两个中文目录」会塌缩成
 * 同一个键，服务端建索引时抛
 *   An item with the same key has already been added
 * 导致发布失败——而本地 vsce package、Open VSX（Java 侧）都不会报错，故障只在
 * Marketplace 那一步暴露，且已经消耗掉一个不可重发的版本号。
 *
 * 典型样本：role-packs/共鸣小说家 与 role-packs/匠码工程师 都是 5 个中文字
 * （UTF-8 各 15 字节），塌缩后同为 15 个 '?'，撞在 rules.md / persona.md / manifest.json。
 *
 * 本脚本在打包之后复现同一塌缩，撞车即 exit 1，把故障前移到本地/CI 打包步。
 * 判据只认「塌缩后重复」：单个非 ASCII 路径不报（存量中文角色包本就合法）。
 */
import yauzl from 'yauzl';

/** zip 条目名中非 ASCII 字节的上界（0x7F 之后按 ASCII 不可表示处理） */
const ASCII_MAX = 0x7f;

/**
 * 模拟 Marketplace 的路径塌缩：逐字节扫描 UTF-8 编码，超过 ASCII 的一律替换为 '?'
 * @param {string} name zip 条目名（含目录分隔符 /）
 * @returns {string} 塌缩后的字典键
 */
function collapseKey(name) {
  /** 条目名的 UTF-8 字节序列 */
  const bytes = Buffer.from(name, 'utf8');
  /** 逐字节还原出的塌缩字符串 */
  let collapsed = '';
  for (const byte of bytes) {
    collapsed += byte > ASCII_MAX ? '?' : String.fromCharCode(byte);
  }
  return collapsed;
}

/**
 * 打开 vsix 并逐条收集，最后输出撞车报告
 * @param {string} vsixPath vsix 文件路径
 */
function run(vsixPath) {
  yauzl.open(vsixPath, { lazyEntries: true }, (openErr, zipfile) => {
    if (openErr) {
      console.error(`[vsix-paths] 无法打开 ${vsixPath}: ${openErr.message}`);
      process.exit(1);
    }

    /** 塌缩键 -> 原始条目名列表 */
    const buckets = new Map();

    zipfile.on('entry', (entry) => {
      // 目录条目本身不产生文件键，跳过
      if (!entry.fileName.endsWith('/')) {
        /** 当前条目的塌缩键 */
        const key = collapseKey(entry.fileName);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(entry.fileName);
      }
      zipfile.readEntry();
    });

    zipfile.on('end', () => {
      /** 塌缩后撞车的键组（同一键挂两个以上条目） */
      const conflicts = [...buckets].filter(([, names]) => names.length > 1);
      if (conflicts.length === 0) {
        console.log(`[vsix-paths] OK：${buckets.size} 个文件条目，无塌缩冲突`);
        return;
      }
      console.error(
        `[vsix-paths] 发现 ${conflicts.length} 组塌缩冲突（Marketplace 会以此拒绝整包）：`,
      );
      for (const [key, names] of conflicts) {
        console.error(`  塌缩键 ${key}`);
        for (const name of names) console.error(`    - ${name}`);
      }
      console.error(
        '[vsix-paths] 修法：把冲突的目录/文件名改成 ASCII（manifest.json 的 name 仍是权威身份，改目录名不影响角色 ID）',
      );
      process.exit(1);
    });

    zipfile.on('error', (readErr) => {
      console.error(`[vsix-paths] 读取 ${vsixPath} 失败: ${readErr.message}`);
      process.exit(1);
    });

    zipfile.readEntry();
  });
}

/** 目标 vsix 路径（默认取 package 脚本的产物名） */
const target = process.argv[2] ?? 'memora-vscode.vsix';
run(target);
