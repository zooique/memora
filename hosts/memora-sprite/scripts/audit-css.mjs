/**
 * CSS 死代码扫描脚本
 * 扫描所有 CSS 文件中的选择器，对比 HTML/TS 中的实际引用，输出未使用的选择器
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const STYLES_DIR = 'src/electron/renderer/styles';
const RENDERER_DIR = 'src/electron/renderer';

// 递归获取所有文件
function getFiles(dir, ext) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getFiles(fullPath, ext));
    } else if (extname(fullPath) === ext) {
      files.push(fullPath);
    }
  }
  return files;
}

// 从 CSS 文件提取选择器
function extractSelectors(cssContent) {
  const selectors = new Set();
  // 匹配 .className 和 #idName 选择器（简化：只提取顶层选择器）
  const classMatches = cssContent.match(/\.[a-zA-Z_-][a-zA-Z0-9_-]*/g) || [];
  const idMatches = cssContent.match(/#[a-zA-Z_-][a-zA-Z0-9_-]*/g) || [];
  for (const s of classMatches) selectors.add(s);
  for (const s of idMatches) selectors.add(s);
  return selectors;
}

// 从 HTML/TS 文件提取引用的 class/id
function extractRefs(content) {
  const refs = new Set();
  // class="..." 或 class='...'
  const classMatches = content.match(/class=["']([^"']+)["']/g) || [];
  for (const m of classMatches) {
    const vals = m.replace(/class=["']/g, '').replace(/["']$/, '').split(/\s+/);
    for (const v of vals) refs.add('.' + v.trim());
  }
  // id="..." 或 id='...'
  const idMatches = content.match(/id=["']([^"']+)["']/g) || [];
  for (const m of idMatches) {
    const val = m.replace(/id=["']/g, '').replace(/["']$/, '').trim();
    refs.add('#' + val);
  }
  // TS 中的 className 添加
  const tsClassMatches = content.match(/className\s*[:=]\s*["']([^"']+)["']/g) || [];
  for (const m of tsClassMatches) {
    const vals = m.replace(/className\s*[:=]\s*["']/g, '').replace(/["']$/, '').split(/\s+/);
    for (const v of vals) refs.add('.' + v.trim());
  }
  // TS 中的 id 引用
  const tsIdMatches = content.match(/getElementById\(["']([^"']+)["']\)/g) || [];
  for (const m of tsIdMatches) {
    const val = m.replace(/getElementById\(["']/g, '').replace(/["']\)/, '').trim();
    refs.add('#' + val);
  }
  // TS 中的 querySelector 引用
  const qsMatches = content.match(/querySelector\(["']([^"']+)["']\)/g) || [];
  for (const m of qsMatches) {
    const sel = m.replace(/querySelector\(["']/g, '').replace(/["']\)/, '').trim();
    if (sel.startsWith('.') || sel.startsWith('#')) refs.add(sel);
  }
  return refs;
}

const cssFiles = getFiles(STYLES_DIR, '.css');
const htmlFiles = getFiles(RENDERER_DIR, '.html');
const tsFiles = getFiles(RENDERER_DIR, '.ts');

// 收集所有引用
const allRefs = new Set();
for (const f of htmlFiles) {
  const content = readFileSync(f, 'utf-8');
  for (const r of extractRefs(content)) allRefs.add(r);
}
for (const f of tsFiles) {
  const content = readFileSync(f, 'utf-8');
  for (const r of extractRefs(content)) allRefs.add(r);
}

// 对每个 CSS 文件，找出未使用的选择器
const results = [];
for (const cssFile of cssFiles) {
  const content = readFileSync(cssFile, 'utf-8');
  const selectors = extractSelectors(content);
  const unused = [];
  for (const sel of selectors) {
    if (!allRefs.has(sel)) {
      unused.push(sel);
    }
  }
  if (unused.length > 0) {
    results.push({ file: cssFile, unused });
  }
}

// 输出结果
for (const r of results) {
  console.log(`\n${r.file}`);
  console.log(`  未使用选择器 (${r.unused.length}): ${r.unused.join(', ')}`);
}

console.log(`\n总计 ${results.length} 个文件存在未使用选择器`);
