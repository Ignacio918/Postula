import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const input = process.argv[2];
if (!input) {
  console.error('Uso: npm run agent -- <postula-agent-config.json | postula-agent-batch.json>');
  process.exit(2);
}

const root = process.cwd();
const workDir = path.join(root, '.postula-agent');
const profileFile = path.resolve(input);
const payload = JSON.parse(await readFile(profileFile, 'utf8'));
const profile = payload.profile || {};
const settings = payload.settings || payload;
const minimumMatch = Number(settings.minimumMatch || payload.autoThreshold || 80);
const dailyLimit = Math.max(1, Math.min(20, Number(settings.dailyLimit || payload.dailyLimit || 5)));
const stateFile = path.join(workDir, 'state.json');
const resultFile = path.join(workDir, 'results.json');
const state = await readJson(stateFile, { applied: [], attempted: [], date: '', submittedToday: 0, attemptedToday: 0 });
state.applied ||= [];
state.attempted ||= [];
state.pending ||= [];
for (const application of payload.applications || []) {
  if (application.jobId && ['Enviada', 'Entrevista', 'Seguimiento'].includes(application.status) && !state.applied.includes(application.jobId)) state.applied.push(application.jobId);
}
const isBatch = Array.isArray(payload.jobs) && payload.jobs.length > 0;
const intervalMinutes = Math.max(15, Math.min(1440, Number(settings.intervalMinutes || 60)));
const stop = new Set('the and for with from that this your you our are can will have has into about role work team experience design designer product user users their they them as an a to of in on or is be we it by at across using use years strong ability skills what who all not'.split(' '));

if (!profile.name || !profile.email || !profile.roles || !(profile.resume || profile.experience) || !(profile.greenhouse || profile.lever)) {
  console.error('Faltan nombre, email, puestos objetivo o contenido de CV en la configuración de Postula.');
  process.exit(2);
}

await mkdir(workDir, { recursive: true });
await mkdir(path.join(workDir, 'resumes'), { recursive: true });
const context = await chromium.launchPersistentContext(path.join(workDir, 'browser-profile'), {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});
const pdfBrowser = await chromium.launch({ headless: true });
let keepRunning = true;
while (keepRunning) {
  const today = localDate();
  if (state.date !== today) Object.assign(state, { date: today, submittedToday: 0, attemptedToday: 0 });
  let jobs;
  try { jobs = isBatch ? payload.jobs : await discoverJobs(profile); }
  catch (error) {
    console.error(`No pude consultar las fuentes: ${error.message || error}`);
    if (isBatch) break;
    await wait(intervalMinutes);
    continue;
  }
  const candidates = jobs
    .filter((job) => inScope(job, profile))
    .map((job) => ({ ...job, match: Number(job.score ?? scoreJob(job, profile)) }))
    .filter((job) => job.match >= minimumMatch && !state.applied.includes(job.id) && !state.attempted.includes(job.id) && !state.pending.includes(job.id))
    .sort((a, b) => b.match - a.match)
    .slice(0, Math.max(0, dailyLimit - Math.max(state.submittedToday, state.attemptedToday)));
  const previousResults = await readJson(resultFile, { results: [] });
  const results = previousResults.results || [];
  const cycleResults = [];
  if (!candidates.length) console.log(`Sin ofertas nuevas por encima de ${minimumMatch}%.`);
  else console.log(`Agente Postula · ${candidates.length} candidaturas · encaje mínimo ${minimumMatch}% · máximo diario ${dailyLimit}`);

  for (const job of candidates) {
  const result = { jobId: job.id, company: job.company, role: job.role, url: job.url, match: job.match, at: new Date().toISOString() };
  let page;
  try {
    page = await context.newPage();
    const cvPath = await createResumePdf(pdfBrowser, job, profile, workDir);
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    if (await hasBlocker(page)) {
      result.status = 'needs_attention';
      result.reason = 'El sitio muestra un CAPTCHA, una verificación o un control que requiere intervención.';
    } else {
      const form = await openApplicationForm(page);
      const filled = await fillKnownFields(form, profile, cvPath);
      if (await hasBlocker(page)) {
        result.status = 'needs_attention';
        result.reason = 'El sitio requiere verificación manual.';
      } else if (filled.missing.length) {
        result.status = 'needs_attention';
        result.reason = `Campos obligatorios que no pude completar con tu perfil: ${filled.missing.join('; ')}`;
      } else {
        const submit = form.locator('button[type="submit"],input[type="submit"]');
        if (await submit.count() !== 1) {
          result.status = 'needs_attention';
          result.reason = 'No pude identificar un único botón de envío seguro.';
        } else {
          const approved = await confirmSubmission(job);
          if (!approved) {
            result.status = 'needs_attention';
            result.reason = 'Formulario completo; falta confirmación manual para enviar la postulación.';
          } else {
            state.attempted.push(job.id);
            state.attemptedToday += 1;
            await writeFile(stateFile, JSON.stringify(state, null, 2));
            await submit.first().click({ timeout: 10000 });
            await page.waitForTimeout(2500);
            if (await hasBlocker(page)) {
              result.status = 'needs_attention';
              result.reason = 'El portal pidió una verificación antes de confirmar el envío.';
            } else if (await hasConfirmation(page)) {
              result.status = 'submitted';
              state.applied.push(job.id);
              state.submittedToday += 1;
            } else {
              result.status = 'submitted_unconfirmed';
              result.reason = 'Se envió el formulario, pero el portal no mostró una confirmación reconocible. Revisá la página abierta.';
            }
          }
        }
      }
    }
  } catch (error) {
    result.status = 'error';
    result.reason = String(error?.message || error).slice(0, 400);
  }
  results.push(result);
  cycleResults.push(result);
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  await writeFile(resultFile, JSON.stringify({ date: today, results }, null, 2));
  console.log(`${result.status.padEnd(22)} ${job.company} · ${job.role}${result.reason ? ` — ${result.reason}` : ''}`);
    if (page && result.status !== 'needs_attention' && result.status !== 'submitted_unconfirmed') await page.close().catch(() => {});
  }
  if (cycleResults.some((result) => ['needs_attention', 'submitted_unconfirmed'].includes(result.status))) {
    console.log('Dejé el navegador abierto en los casos pendientes. Revisalos en el portal; el agente no va a adivinar respuestas ni resolver verificaciones.');
    for (const result of cycleResults.filter((entry) => entry.status === 'needs_attention')) {
      if (!state.pending.includes(result.jobId)) state.pending.push(result.jobId);
    }
    await writeFile(stateFile, JSON.stringify(state, null, 2));
    if (isBatch) keepRunning = false;
  }
  if (isBatch) keepRunning = false;
  else if (keepRunning) {
    await writeFile(stateFile, JSON.stringify(state, null, 2));
    console.log(`Próxima búsqueda en ${intervalMinutes} minutos. Dejá esta terminal y el navegador abiertos; Ctrl+C detiene el agente.`);
    await wait(intervalMinutes);
  }
}
await pdfBrowser.close();
await context.close();
console.log(`Resultado local: ${resultFile}`);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function wait(minutes) { await new Promise((resolve) => setTimeout(resolve, minutes * 60 * 1000)); }
function localDate() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }

async function confirmSubmission(job) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`Confirmación manual requerida antes de enviar: ${job.company} · ${job.role}`);
    return false;
  }
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nFormulario completo: ${job.company} · ${job.role}`);
    console.log(`Revisalo en el navegador: ${job.url}`);
    return (await prompt.question('Escribí ENVIAR para presentar esta candidatura, o Enter para dejarla pendiente: ')).trim() === 'ENVIAR';
  } finally {
    prompt.close();
  }
}

async function discoverJobs(p) {
  const boards = String(p.greenhouse || '').split(/[\s,]+/).filter(Boolean);
  const sites = String(p.lever || '').split(/[\s,]+/).filter(Boolean);
  const lists = await Promise.all([
    ...boards.map(async (board) => {
      const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`);
      if (!response.ok) throw new Error(`Greenhouse ${board}: HTTP ${response.status}`);
      const json = await response.json();
      return (json.jobs || []).map((job) => ({ id: `gh-${job.id}`, company: label(board), role: job.title, url: job.absolute_url, location: job.location?.name || '', description: stripHtml(job.content || ''), source: 'Greenhouse' }));
    }),
    ...sites.map(async (site) => {
      const response = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`);
      if (!response.ok) throw new Error(`Lever ${site}: HTTP ${response.status}`);
      const json = await response.json();
      return json.map((job) => ({ id: `lv-${job.id}`, company: label(site), role: job.text, url: job.applyUrl || job.hostedUrl, location: job.categories?.location || '', description: job.descriptionPlain || stripHtml(job.description || ''), source: 'Lever' }));
    }),
  ]);
  return lists.flat().filter((job) => job.url);
}

function label(value) { return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function stripHtml(value) { return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
function terms(value = '') { return (value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9+#.-]{3,}/g) || []).filter((word) => !stop.has(word)); }
function roleTerms(value = '') { return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9+#.-]{3,}/g) || []; }
function scoreJob(job, p) {
  const profileWords = new Set(terms([p.roles, p.summary, p.experience, p.skills, p.resume].join(' ')));
  const counts = new Map();
  terms([job.role, job.description].join(' ')).forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
  const jobWords = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([word]) => word);
  const coverage = jobWords.filter((word) => profileWords.has(word)).length / Math.max(jobWords.length, 1);
  const target = roleTerms(p.roles || '');
  const roleWords = roleTerms(job.role);
  const roleFit = target.length ? roleWords.filter((word) => target.includes(word)).length / Math.max(roleWords.length, 1) : 0;
  return Math.max(20, Math.min(98, Math.round(35 + coverage * 50 + roleFit * 15)));
}

function inScope(job, p) {
  const text = `${job.role} ${job.location} ${job.description}`.toLowerCase();
  const titleWords = new Set(roleTerms(job.role));
  const targetRoles = String(p.roles || '').split(/[,;\n]/).map((role) => roleTerms(role)).filter((role) => role.length);
  if (targetRoles.length && !targetRoles.some((role) => role.filter((word) => titleWords.has(word)).length / role.length >= 0.5)) return false;
  const mode = String(p.mode || 'Indistinto').toLowerCase();
  if (mode.includes('remoto') && !/remote|remoto|anywhere|worldwide|distributed|latam|latin america|americas|global/i.test(text)) return false;
  if (mode.includes('remoto') && /north america only|u\.?s\.? only|united states only|canada only|europe only|uk only|must be based in (?:the )?(?:us|united states|north america)/i.test(text) && /argentina|buenos aires|latam|latin america/i.test(p.location || '')) return false;
  if (mode.includes('híbrido') && !/hybrid|h[ií]brid/i.test(text)) return false;
  if (mode.includes('presencial')) {
    if (/remote|remoto|anywhere|worldwide/i.test(text)) return false;
    const place = String(p.location || '').toLowerCase().split(/[,-]/).map((part) => part.trim()).filter(Boolean);
    if (place.length && !place.some((part) => text.includes(part))) return false;
  }
  return true;
}

function tailoredText(job, p) {
  const targets = new Set(terms([job.role, job.description].join(' ')));
  const rankedExperience = String(p.experience || '').split(/\n\s*\n/).map((block, index) => ({ block: block.trim(), index, score: terms(block).filter((word) => targets.has(word)).length })).filter((entry) => entry.block).sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.block).join('\n\n');
  const original = String(p.resume || '').trim() || [rankedExperience, p.skills].filter(Boolean).join('\n\n');
  const termsInJob = new Set(terms([job.role, job.description].join(' ')));
  const skills = String(p.skills || '').split(/[,;\n]/).map((skill) => skill.trim()).filter((skill) => skill && terms(skill).some((word) => termsInJob.has(word)));
  return `${p.name}${p.location ? ` · ${p.location}` : ''}\n${[p.email, p.phone, p.link].filter(Boolean).join(' · ')}\n\n${job.role} · ${job.company}\n\n${p.summary || ''}${skills.length ? `\n\nCOMPETENCIAS RELEVANTES\n${skills.join(' · ')}` : ''}\n\nEXPERIENCIA Y CV DE ORIGEN\n${original}\n\nSe priorizan el puesto y las competencias que ya aparecen en tu perfil. No se agregan logros ni credenciales.`.trim();
}

async function createResumePdf(context, job, p, dir) {
  const safe = `${job.company}-${job.role}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90);
const output = path.join(dir, 'resumes', `${safe}-${String(job.id).replace(/[^a-z0-9-]/gi, '').slice(0, 24)}.pdf`);
  const sections = tailoredText(job, p).split('\n\n').slice(2).map((section) => `<p>${section.split('\n').map(htmlEscape).join('<br>')}</p>`).join('');
  const html = `<html><head><meta charset="utf-8"><style>@page{size:A4;margin:20mm}body{font:10.5pt/1.55 Arial,sans-serif;color:#222}h1{font-size:19pt;margin:0 0 4pt}p{white-space:pre-wrap;margin:0 0 8pt}.target{font-size:12pt;color:#526b55;margin-bottom:14pt}.contact{font-size:9pt;color:#555;margin-bottom:16pt}</style></head><body><h1>${htmlEscape(p.name)}</h1><p class="contact">${htmlEscape([p.email,p.phone,p.location,p.link].filter(Boolean).join(' · '))}</p><p class="target">${htmlEscape(job.role)} · ${htmlEscape(job.company)}</p>${sections}</body></html>`;
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: output, format: 'A4', printBackground: true });
  await page.close();
  return output;
}
function htmlEscape(value = '') { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

async function hasBlocker(page) {
  return /captcha|verify you are human|checking your browser|security verification|robot check/i.test(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
}
async function hasConfirmation(page) {
  return /application (was )?submitted|thank you for applying|thanks for applying|application received|candidatura enviada|gracias por postular|recibimos tu postulación/i.test(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
}
async function openApplicationForm(page) {
  const findForm = async () => {
    const forms = page.locator('form');
    const snapshots = await forms.evaluateAll((nodes) => nodes.map((form, index) => {
      const fields = [...form.querySelectorAll('input,textarea,select')];
      const labels = fields.map((el) => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), [...(el.labels || [])].map((label) => label.innerText).join(' ')].join(' ').toLowerCase());
      return { index, text: form.innerText.toLowerCase(), labels, hasFile: fields.some((el) => el.type === 'file' && /resume|cv|curriculum|attachment|pdf/i.test(`${el.name} ${el.accept} ${el.getAttribute('aria-label') || ''}`)), hasSubmit: Boolean(form.querySelector('button[type="submit"],input[type="submit"]')) };
    }));
    const ranked = snapshots.map((form) => ({ ...form, score: (form.labels.some((text) => /e-?mail/.test(text)) ? 1 : 0) + (form.labels.some((text) => /first name|full name|applicant name|given name|nombre/.test(text)) ? 2 : 0) + (form.hasFile ? 3 : 0) + (/application|apply|candidatura|postulaci[oó]n/.test(form.text) ? 1 : 0) })).filter((form) => form.hasSubmit && form.score >= 2).sort((a, b) => b.score - a.score);
    return ranked.length ? forms.nth(ranked[0].index) : null;
  };
  let form = await findForm();
  if (form) return form;
  const apply = page.getByRole('link', { name: /apply|aplicar|postular/i }).or(page.getByRole('button', { name: /apply|aplicar|postular/i })).first();
  if (await apply.count()) {
    await apply.click({ timeout: 8000 });
    await page.waitForTimeout(1200);
  }
  form = await findForm();
  if (!form) throw new Error('No encontré un formulario de candidatura reconocible en este portal.');
  return form;
}

function valueFor(label, p) {
  const text = label.toLowerCase().replace(/[_-]+/g, ' ');
  if (/e-?mail/.test(text)) return p.email;
  if (/phone|mobile|tel[eé]fono|celular/.test(text)) return p.phone;
  if (/current company|current employer|present employer|empresa actual/.test(text)) return p.currentCompany || '';
  if (/full name|your name|^name$|nombre completo/.test(text)) return p.name;
  if (/first name|given name|nombre\b/.test(text) && !/last|apellido/.test(text)) return p.name?.trim().split(/\s+/)[0];
  if (/last name|family name|surname|apellido/.test(text)) return p.name?.trim().split(/\s+/).slice(1).join(' ');
  if (/country|pa[ií]s/.test(text)) return p.location?.split(',').at(-1).trim();
  if (/linkedin/.test(text)) return p.linkedin || (/linkedin/i.test(p.link || '') ? p.link : '');
  if (/portfolio|website|web site|sitio web|url/.test(text)) return p.portfolio || p.link;
  if (/city|location|ubicaci[oó]n|ciudad/.test(text)) return p.location?.split(',')[0].trim();
  if (/cover letter|carta de presentaci[oó]n|professional summary|resumen profesional/.test(text)) return p.summary || '';
  return '';
}

async function fillKnownFields(form, p, cvPath) {
  const missing = [];
  const radioGroups = new Map();
  const checkboxGroups = new Map();
  const selectedRadios = new Set((p.applicationAnswers?.radio || []).map(normalizeAnswer));
  const selectedCheckboxes = new Set((p.applicationAnswers?.checkboxes || []).map(normalizeAnswer));
  const controls = form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select');
  const total = await controls.count();
  for (let i = 0; i < total; i += 1) {
    const field = controls.nth(i);
    const type = (await field.getAttribute('type') || '').toLowerCase();
    const required = await field.getAttribute('required') !== null || await field.getAttribute('aria-required') === 'true';
    if (type === 'file') {
      const hint = `${await field.getAttribute('name') || ''} ${await field.getAttribute('aria-label') || ''} ${await field.getAttribute('accept') || ''}`.toLowerCase();
      if (/resume|cv|curriculum|attachment|pdf/.test(hint)) {
        await field.setInputFiles(cvPath).catch(() => {});
        if (required && !await field.evaluate((el) => el.files?.length > 0).catch(() => false)) missing.push(hint || 'CV adjunto');
      } else if (required) missing.push(hint || 'archivo obligatorio');
      continue;
    }
    if (!await field.isVisible().catch(() => false)) continue;
    if (['checkbox', 'radio'].includes(type)) {
      const option = await field.evaluate((el) => el.labels ? [...el.labels].map((item) => item.innerText).join(' ').trim() : el.getAttribute('aria-label') || el.value || 'confirmación legal');
      const groupName = await field.getAttribute('name') || `${type}-${i}`;
      const groups = type === 'radio' ? radioGroups : checkboxGroups;
      if (!groups.has(groupName)) groups.set(groupName, { label: option, required });
      if ((type === 'radio' ? selectedRadios : selectedCheckboxes).has(normalizeAnswer(option))) {
        await field.check({ timeout: 1500 }).catch(() => {});
      }
      continue;
    }
    const label = await field.evaluate((el) => [el.labels ? [...el.labels].map((item) => item.innerText).join(' ') : '', el.closest('.application-question')?.innerText || '', el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('name') || '', el.id || ''].join(' '));
    const mapped = valueFor(label, p);
    if (mapped && type !== 'file' && await field.inputValue().catch(() => '') === '') {
      if (await field.evaluate((el) => el.tagName === 'SELECT')) {
        const optionLabels = await field.locator('option').allTextContents().catch(() => []);
        const country = p.location?.split(',').at(-1).trim();
        const option = /which location are you applying for/i.test(label) && country
          ? optionLabels.find((item) => normalizeAnswer(item).includes(normalizeAnswer(country)))
          : optionLabels.find((item) => normalizeAnswer(item) === normalizeAnswer(mapped));
        if (option) await field.selectOption({ label: option }, { timeout: 1500 }).catch(() => {});
      } else {
        await field.fill(mapped, { timeout: 1500 }).catch(() => {});
      }
    }
    const current = await field.inputValue().catch(() => '');
    if (required && !current) missing.push(label.trim() || `campo ${i + 1}`);
  }
  for (const [groupName, group] of radioGroups) {
    const isSelected = await form.locator('input[type="radio"]:checked').evaluateAll((nodes, name) => nodes.some((node) => node.name === name), groupName).catch(() => false);
    if (group.required && !isSelected) missing.push(group.label);
  }
  for (const [groupName, group] of checkboxGroups) {
    const isSelected = await form.locator('input[type="checkbox"]:checked').evaluateAll((nodes, name) => nodes.some((node) => node.name === name), groupName).catch(() => false);
    if (group.required && !isSelected) missing.push(group.label);
  }
  return { missing: [...new Set(missing)] };
}

function normalizeAnswer(value = '') { return String(value).replace(/\s+/g, ' ').trim().toLowerCase(); }
