const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Create directories if they don't exist
const dirs = [
  'src/assets/logo',
  'src/renderer/assets',
  'build/icons'
];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Our SVG logo
const svg = `
<svg width="1024" height="1024" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="48" height="48" fill="#000000"/>
  <path d="M14 10L14 38C14 39.1 14.9 40 16 40C17.1 40 18 39.1 18 38L18 26.4L33.6 10C34.8 8.6 36.8 8.8 37.8 10.1L37.8 10.1C38.8 11.3 38.6 13.3 37.2 14.5L22.7 30.5L32.4 38C33.6 38.9 33.9 40.6 33.1 41.8L33.1 41.8C32.2 43 30.5 43.3 29.3 42.5L14 30.5L14 10Z" fill="white"/>
</svg>
`;

async function generateLogo() {
  // Generate full-res master PNG
  await sharp(Buffer.from(svg))
    .png()
    .resize(1024, 1024)
    .toFile('src/assets/logo/kairon-logo.png');

  await sharp(Buffer.from(svg))
    .png()
    .resize(1024, 1024)
    .toFile('src/renderer/assets/kairon-logo.png');

  // Generate icons for electron-builder
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    await sharp(Buffer.from(svg))
      .png()
      .resize(size, size)
      .toFile(`build/icons/${size}x${size}.png`);
  }

  // Generate ICO file (Windows)
  await sharp(Buffer.from(svg))
    .resize(256, 256)
    .png()
    .toFile('build/icons/icon.png');

  await sharp('build/icons/icon.png')
    .toFile('build/icons/icon.ico');

  await sharp('build/icons/icon.png')
    .toFile('src/renderer/assets/favicon.ico');

  // Copy icon to main assets
  await fs.promises.copyFile('build/icons/icon.ico', 'src/assets/icon.ico');

  console.log('Logo assets generated successfully!');
}

generateLogo().catch(console.error);
