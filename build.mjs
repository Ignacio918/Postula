import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const authUrl = process.env.POSTULA_AUTH_URL || process.env.NEON_AUTH_BASE_URL || '';
const dataApiUrl = process.env.POSTULA_DATA_API_URL || process.env.NEON_DATA_API_URL || '';
const missing = [!authUrl && 'Neon Auth URL', !dataApiUrl && 'Neon Data API URL'].filter(Boolean);
if (missing.length) {
  console.warn(`Postula: ${missing.join(' and ')} not set; the deployed app will open in local-only mode.`);
}

const config = `window.POSTULA_AUTH_URL = ${JSON.stringify(authUrl)};\nwindow.POSTULA_DATA_API_URL = ${JSON.stringify(dataApiUrl)};\n`;
await writeFile('config.js', config, 'utf8');
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'auth.js', 'config.js']) {
  await copyFile(file, `dist/${file}`);
}
console.log('Postula built into dist/.');
