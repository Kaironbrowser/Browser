const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');

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

// The exact logo URL from the user
const logoUrl = 'https://raw.githubusercontent.com/trae-ai/test-images/main/kairon-logo.png';

async function downloadImage(url, filePath) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image, status code: ${response.statusCode}`));
        return;
      }
      
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        fs.writeFileSync(filePath, buffer);
        resolve(buffer);
      });
    }).on('error', reject);
  });
}

async function generateLogo() {
  // Download the exact logo
  console.log('Downloading exact Kairon logo...');
  const logoBuffer = await downloadImage(logoUrl, 'src/assets/logo/kairon-logo.png');
  
  // Save to renderer assets
  await fs.promises.copyFile('src/assets/logo/kairon-logo.png', 'src/renderer/assets/kairon-logo.png');
  
  console.log('Generating icon assets...');
  
  // Generate icons for electron-builder
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    await sharp(logoBuffer)
      .png()
      .resize(size, size)
      .toFile(`build/icons/${size}x${size}.png`);
  }

  // Generate ICO file (Windows)
  await sharp(logoBuffer)
    .resize(256, 256)
    .png()
    .toFile('build/icons/icon.png');

  await sharp('build/icons/icon.png')
    .toFile('build/icons/icon.ico');

  await sharp('build/icons/icon.png')
    .toFile('src/renderer/assets/favicon.ico');

  // Copy icon to main assets
  await fs.promises.copyFile('build/icons/icon.ico', 'src/assets/icon.ico');

  console.log('Exact Kairon logo assets generated successfully!');
}

generateLogo().catch(console.error);
