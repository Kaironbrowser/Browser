const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Path to your SVG file
const svgPath = path.join(__dirname, 'src', 'assets', 'logo', 'kairon-logo.svg');

// Create build/icons directory if it doesn't exist
const buildIconsDir = path.join(__dirname, 'build', 'icons');
if (!fs.existsSync(buildIconsDir)) {
  fs.mkdirSync(buildIconsDir, { recursive: true });
}

// Generate all required sizes
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function generateIcons() {
  console.log('Generating icons from SVG...');
  
  for (const size of sizes) {
    await sharp(svgPath)
      .resize(size, size)
      .png()
      .toFile(path.join(buildIconsDir, `${size}x${size}.png`));
    console.log(`Generated ${size}x${size}.png`);
  }

  // Generate icon.ico for Windows
  await sharp(svgPath)
    .resize(256, 256)
    .png()
    .toFile(path.join(buildIconsDir, 'icon.png'));
  
  await sharp(path.join(buildIconsDir, 'icon.png'))
    .toFile(path.join(buildIconsDir, 'icon.ico'));
  
  console.log('Generated icon.ico');

  // Copy to renderer assets for favicon
  const rendererAssetsDir = path.join(__dirname, 'src', 'renderer', 'assets');
  await fs.promises.copyFile(
    path.join(buildIconsDir, 'icon.ico'), 
    path.join(rendererAssetsDir, 'favicon.ico')
  );
  
  await fs.promises.copyFile(
    svgPath,
    path.join(rendererAssetsDir, 'kairon-logo.svg')
  );
  
  console.log('Copied assets to src/renderer/assets');
  console.log('All icons generated successfully!');
}

generateIcons().catch(console.error);
