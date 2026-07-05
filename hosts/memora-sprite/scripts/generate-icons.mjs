/**
 * 图标生成脚本
 * 从 assets/icon.svg 生成多尺寸PNG图标和Windows ico文件
 * 输出到 build/icons/ 目录供 electron-builder 使用
 */
import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const svgPath = join(projectRoot, 'assets', 'icon.svg');
const outputDir = join(projectRoot, 'build', 'icons');

// 需要生成的图标尺寸（electron-builder 标准尺寸集）
const sizes = [16, 24, 32, 48, 64, 128, 256, 512];

// 确保输出目录存在
mkdirSync(outputDir, { recursive: true });

// 读取SVG源文件
const svgBuffer = readFileSync(svgPath);

console.log('🎨 开始生成 Memora Sprite 图标...\n');

// 生成各尺寸PNG
for (const size of sizes) {
  const pngPath = join(outputDir, `${size}x${size}.png`);
  await sharp(svgBuffer)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(pngPath);
  console.log(`  ✓ ${size}x${size}.png`);
}

// 生成主图标文件（512x512，用于Windows）
const mainIconPath = join(outputDir, 'icon.png');
await sharp(svgBuffer)
  .resize(512, 512, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  })
  .png()
  .toFile(mainIconPath);
console.log(`  ✓ icon.png (512x512)`);

// 生成favicon（用于Web调试通道）
const faviconPath = join(projectRoot, 'assets', 'favicon.png');
await sharp(svgBuffer)
  .resize(32, 32, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  })
  .png()
  .toFile(faviconPath);
console.log(`  ✓ favicon.png (32x32)`);

// 生成托盘图标（使用纯色简化版，16x16更清晰）
const traySvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#89b4fa"/>
      <stop offset="100%" stop-color="#f5c2e7"/>
    </linearGradient>
  </defs>
  <circle cx="8" cy="8" r="7" fill="url(#g)" opacity="0.9"/>
  <circle cx="8" cy="8" r="2.5" fill="#fff"/>
</svg>
`;
const trayIconPath = join(outputDir, 'tray.png');
await sharp(Buffer.from(traySvg))
  .resize(16, 16)
  .png()
  .toFile(trayIconPath);
console.log(`  ✓ tray.png (16x16)`);

// 生成托盘图标@2x（高DPI）
const trayIcon2xPath = join(outputDir, 'tray@2x.png');
await sharp(Buffer.from(traySvg))
  .resize(32, 32)
  .png()
  .toFile(trayIcon2xPath);
console.log(`  ✓ tray@2x.png (32x32)`);

console.log('\n✅ 图标生成完成！输出目录:', outputDir);
