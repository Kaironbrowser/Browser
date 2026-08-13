const sharp = require('sharp');
const path = require('path');

// Path to your SVG file
const svgPath = path.join(__dirname, 'src', 'assets', 'logo', 'kairon-logo.svg');

async function generateMasterPng() {
  await sharp(svgPath)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(__dirname, 'src', 'assets', 'logo', 'kairon-logo.png'));
  
  console.log('Generated master kairon-logo.png at 1024x1024!');
}

generateMasterPng().catch(console.error);
