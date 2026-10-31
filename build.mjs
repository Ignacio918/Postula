import { build as bundle } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const authUrl = process.env.POSTULA_AUTH_URL || process.env.NEON_AUTH_BASE_URL || '';
const dataApiUrl = process.env.POSTULA_DATA_API_URL || process.env.NEON_DATA_API_URL || '';
const missing = [!authUrl && 'Neon Auth URL', !dataApiUrl && 'Neon Data API URL'].filter(Boolean);
if (missing.length) {
  console.warn(`Postula: ${missing.join(' and ')} not set; the deployed app will open in local-only mode.`);
}

const config = `window.POSTULA_AUTH_URL = ${JSON.stringify(authUrl)};\nwindow.POSTULA_DATA_API_URL = ${JSON.stringify(dataApiUrl)};\n`;
await writeFile('config.js', config, 'utf8');
await mkdir('dist', { recursive: true });
await mkdir('dist/assets', { recursive: true });
await bundle({ entryPoints: ['app.js'], outfile: 'dist/app.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
for (const file of ['index.html', 'styles.css', 'config.js']) {
  await copyFile(file, `dist/${file}`);
}
await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'dist/pdf.worker.min.mjs');
for (const file of ['postula-logo.svg', 'postula-icon.svg', 'postula-icon.png', 'postula-icon.ico', 'postula-shortcut.ico']) {
  await copyFile(`assets/${file}`, `dist/assets/${file}`);
}
console.log('Postula built into dist/ with the Neon SDK bundled locally.');
