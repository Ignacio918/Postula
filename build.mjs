import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const required = ['POSTULA_AUTH_URL', 'POSTULA_DATA_API_URL'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.warn(`Postula: ${missing.join(', ')} not set; the deployed app will open in local-only mode.`);
}

const config = `window.POSTULA_AUTH_URL = ${JSON.stringify(process.env.POSTULA_AUTH_URL || '')};\nwindow.POSTULA_DATA_API_URL = ${JSON.stringify(process.env.POSTULA_DATA_API_URL || '')};\n`;
await writeFile('config.js', config, 'utf8');
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'auth.js', 'config.js']) {
  await copyFile(file, `dist/${file}`);
}
console.log('Postula built into dist/.');
