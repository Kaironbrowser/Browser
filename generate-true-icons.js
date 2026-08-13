const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Your original SVG file
const svgPath = path.join(__dirname, 'src', 'renderer', 'assets', 'image_2026-06-30_204850908.svg');
const masterPngPath = path.join(__dirname, 'src', 'assets', 'logo', 'kairon-master.png');
const buildIconsDir = path.join(__dirname, 'build', 'icons');

// Clean existing build/icons
if (fs.existsSync(buildIconsDir)) {
  fs.rmSync(buildIconsDir, { recursive: true, force: true });
}
fs.mkdirSync(buildIconsDir, { recursive: true });

async function generateMaster() {
  console.log('Generating master 1024x1024 PNG from SVG...');
  await sharp(svgPath)
    .resize(1024, 1024)
    .png({ quality: 100 })
    .toFile(masterPngPath);

  console.log('Running electron-icon-builder...');
  execSync('npx electron-icon-builder --input=src/assets/logo/kairon-master.png --output=build/icons --flatten', {
    cwd: __dirname,
    stdio: 'inherit'
  });

  // Move files from build/icons/icons up to build/icons
  const iconsSubDir = path.join(buildIconsDir, 'icons');
  if (fs.existsSync(iconsSubDir)) {
    const files = fs.readdirSync(iconsSubDir);
    for (const file of files) {
      fs.renameSync(path.join(iconsSubDir, file), path.join(buildIconsDir, file));
    }
    fs.rmSync(iconsSubDir, { recursive: true });
  }

  // Copy to src/assets for BrowserWindow
  fs.copyFileSync(path.join(buildIconsDir, 'icon.ico'), path.join(__dirname, 'src', 'assets', 'icon.ico'));
  fs.copyFileSync(path.join(buildIconsDir, 'icon.ico'), path.join(__dirname, 'src', 'renderer', 'assets', 'favicon.ico'));

  // Also copy your original SVG to src/renderer/assets/kairon-logo.svg for use in index.html
  fs.copyFileSync(svgPath, path.join(__dirname, 'src', 'renderer', 'assets', 'kairon-logo.svg'));

  console.log('✅ All icons regenerated successfully!');
}

generateMaster().catch(err => {
  console.error('❌ Icon generation failed:', err);
  process.exit(1);
});
