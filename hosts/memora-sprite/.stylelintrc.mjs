import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 绝对路径：README 明确 monorepo 下 relative 从 CWD 解析可能失效，故用 fileURLToPath 锚定。
// importFrom 让 csstools 插件把下列文件里的 :root 自定义属性视为「已知」，
// 对每一个被 lint 的文件（含孤立扫描的叶子文件）都生效 —— 无需 @import 内联、不污染运行时。
// tokens.css 持有全部 167 个跨文件 token；base/controls/utilities 兜底少量 foundation 级声明。
const TOKEN_SOURCES = [
  resolve(__dirname, 'src/electron/renderer/styles/foundation/tokens.css'),
  resolve(__dirname, 'src/electron/renderer/styles/foundation/base.css'),
  resolve(__dirname, 'src/electron/renderer/styles/foundation/controls.css'),
  resolve(__dirname, 'src/electron/renderer/styles/foundation/utilities.css'),
];

export default {
  plugins: ['stylelint-value-no-unknown-custom-properties'],
  rules: {
    // 主规则：抓「引用不存在的 --x token」（R13 / R13-bis 类 bug）。importFrom 提供已知 token 集。
    'csstools/value-no-unknown-custom-properties': [true, { importFrom: TOKEN_SOURCES }],
    // 抓 R14 类「重复基类漏删」（同文件内重复选择器；跨文件重复由 @import 聚合器层叠处理，非本规则范围）
    // 基础+增强规则有意同选择器拆分（markdown.css .md-code-inline 等）：明知故犯，关闭以免阻塞。
    // 若未来想重新启用，用 ['error'] 而非 ['warning']（本版本该规则不接受 warning 作 severity）。
    'no-duplicate-selectors': null,
    'declaration-block-no-duplicate-properties': [true, { ignore: ['consecutive-duplicates-with-different-values'] }],
    // .hidden / .sr-only 工具类有意 !important（必须覆盖其他 display）：明知故犯，关闭以免阻塞。
    'declaration-no-important': null,
    'color-no-invalid-hex': true,
    'no-empty-source': true,
  },
  ignoreFiles: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.min.css'],
};
