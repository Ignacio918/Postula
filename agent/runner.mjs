import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const input = process.argv[2];
const execFileAsync = promisify(execFile);
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
const statusFile = path.join(workDir, 'status.json');
const state = await readJson(stateFile, { applied: [], attempted: [], discovered: [], date: '', submittedToday: 0, attemptedToday: 0 });
state.applied ||= [];
state.attempted ||= [];
state.pending ||= [];
state.discovered ||= [];
state.retryQueue ||= [];
state.excluded ||= [];
for (const application of payload.applications || []) {
  if (application.jobId && ['Enviada', 'Entrevista', 'Seguimiento'].includes(application.status) && !state.applied.includes(application.jobId)) state.applied.push(application.jobId);
}
const isBatch = Array.isArray(payload.jobs) && payload.jobs.length > 0;
const intervalMinutes = Math.max(15, Math.min(1440, Number(settings.intervalMinutes || 30)));
const approvalRequests = new Map();
const approvedApplications = new Set();
let liveStatus = { phase: 'Iniciando', jobsFound: 0, matched: 0, currentJob: null, updatedAt: new Date().toISOString() };
let activeApplicationPage = null;
let keepRunning = true;
const stop = new Set('the and for with from that this your you our are can will have has into about role work team experience design designer product user users their they them as an a to of in on or is be we it by at across using use years strong ability skills what who all not'.split(' '));

if (!profile.name || !profile.email || !profile.roles || !(profile.resume || profile.experience)) {
  console.error('Faltan nombre, email, puestos objetivo o contenido de CV en la configuración de Postula.');
  process.exit(2);
}

await mkdir(workDir, { recursive: true });
await mkdir(path.join(workDir, 'resumes'), { recursive: true });
const releaseRunnerLock = await claimRunnerLock(workDir);
const dashboardServer = await startDashboard();
const dashboardPort = Number(process.env.POSTULA_DASHBOARD_PORT || 4179);
const context = await chromium.launchPersistentContext(path.join(workDir, 'browser-profile'), {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});
const pdfBrowser = await chromium.launch({ headless: true });
while (keepRunning) {
  const today = localDate();
  if (state.date !== today) Object.assign(state, { date: today, submittedToday: 0, attemptedToday: 0 });
  let jobs;
  await setLiveStatus({ phase: 'Buscando ofertas', currentJob: null, startedAt: new Date().toISOString() });
  try { jobs = isBatch ? payload.jobs : await discoverJobs(profile); }
  catch (error) {
    console.error(`No pude consultar las fuentes: ${error.message || error}`);
    await setLiveStatus({ phase: 'Error al consultar fuentes', error: String(error?.message || error), currentJob: null });
    if (isBatch) break;
    await wait(intervalMinutes);
    continue;
  }
  const previousResults = await readJson(resultFile, { results: [] });
  const results = previousResults.results || [];
  for (const prior of results) {
    if (!prior.jobId) continue;
    if (!state.discovered.includes(prior.jobId)) state.discovered.push(prior.jobId);
    if (['needs_attention', 'ready_to_submit', 'submitted_unconfirmed'].includes(prior.status) && !state.pending.includes(prior.jobId)) state.pending.push(prior.jobId);
  }
  if ((state.runnerVersion || 0) < 2) {
    state.retryQueue = [...new Set(results.filter((entry) => entry.source === 'Remote OK' && ['needs_attention', 'error'].includes(entry.status)).slice(-12).reverse().map((entry) => entry.jobId))].slice(0, 3);
    state.runnerVersion = 2;
    console.log(`Revisión única tras actualizar el navegador del agente: ${state.retryQueue.length} enlaces de Remote OK.`);
  }
  const candidates = jobs
    .filter((job) => inScope(job, profile))
    .map((job) => ({ ...job, match: Number(job.score ?? scoreJob(job, profile)) }))
    .filter((job) => job.match >= minimumMatch && !state.excluded.includes(job.id) && !state.applied.includes(job.id) && !state.attempted.includes(job.id) && (state.retryQueue.includes(job.id) || (!state.pending.includes(job.id) && !state.discovered.includes(job.id))))
    .sort((a, b) => b.match - a.match)
    .slice(0, state.retryQueue.length ? 3 : 30);
  const cycleResults = [];
  const matchCount = jobs.filter((job) => inScope(job, profile) && Number(job.score ?? scoreJob(job, profile)) >= minimumMatch && !state.excluded.includes(job.id) && !state.applied.includes(job.id)).length;
  await setLiveStatus({ phase: candidates.length ? 'Revisando ofertas compatibles' : 'Búsqueda en curso', jobsFound: jobs.length, matched: matchCount, currentJob: null, error: '' });
  if (!candidates.length) console.log(`Ciclo completo · ${matchCount} ofertas coinciden con tu perfil; ninguna nueva para revisar.`);
  else console.log(`Agente Postula · ${candidates.length} ofertas nuevas · ${matchCount} compatibles · encaje mínimo ${minimumMatch}% · máximo ${dailyLimit} envíos/día`);

  const pendingPages = [];
  for (const job of candidates) {
  await setLiveStatus({ currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Abriendo publicación' } });
  const result = { jobId: job.id, source: job.source, company: job.company, role: job.role, url: job.url, match: job.match, at: new Date().toISOString() };
  state.discovered.push(job.id);
  let page;
  try {
    page = await context.newPage();
    await setLiveStatus({ currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Preparando CV para el puesto' } });
    const cvPath = await createResumePdf(pdfBrowser, job, profile, workDir);
    await page.goto(job.listingUrl || job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const applicationUrl = await findApplicationUrl(page, job);
    if (applicationUrl && applicationUrl !== page.url()) await page.goto(applicationUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    result.url = page.url();
    await page.waitForTimeout(1200);
    if (await hasBlocker(page)) await waitForHumanChallenge(page, job);
    if (await hasBlocker(page)) {
      result.status = 'needs_attention';
      result.reason = 'El sitio sigue mostrando una verificación. La pestaña queda abierta; resolvela manualmente y volvé a intentar esta oferta desde results.json.';
    } else {
      const listingPage = page;
      const application = await openApplicationForm(page, job);
      page = application.page;
      if (page !== listingPage) await listingPage.close().catch(() => {});
      const form = application.form;
      result.url = page.url();
      if (!form) throw new Error('No encontré un formulario de candidatura reconocible en este portal.');
      await setLiveStatus({ currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Completando formulario' } });
      const filled = await fillKnownFields(form, profile, cvPath, job);
      if (await hasBlocker(page)) {
        result.status = 'needs_attention';
        result.reason = 'El sitio requiere verificación manual.';
      } else if (filled.missing.length) {
        result.status = 'needs_attention';
        result.reason = `Campos obligatorios que no pude completar con tu perfil: ${filled.missing.join('; ')}`;
      } else {
        let submit = form.locator('button[type="submit"]:visible,input[type="submit"]:visible,button:not([type]):visible');
        if (await submit.count() !== 1) {
          const namedSubmit = form.getByRole('button', { name: /submit application|send application|submit|apply now|enviar candidatura|postular/i }).filter({ visible: true });
          if (await namedSubmit.count() === 1) submit = namedSubmit;
        }
        if (await submit.count() !== 1) {
          result.status = 'needs_attention';
          result.reason = 'No pude identificar un único botón de envío seguro.';
        } else {
          if (state.attemptedToday >= dailyLimit) {
            result.status = 'needs_attention';
            result.reason = `Formulario completo, pero ya se alcanzó el máximo de ${dailyLimit} envíos de hoy.`;
          } else {
          await setLiveStatus({ currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Formulario listo · esperando tu confirmación' } });
          const approved = await requestDashboardApproval(job, page);
          if (!approved) {
            result.status = 'ready_to_submit';
            result.reason = 'Formulario completo; quedó pendiente la confirmación desde el panel local.';
          } else {
            await setLiveStatus({ phase: 'Enviando candidatura confirmada', currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Enviando formulario' } });
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
              await setLiveStatus({ currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Postulación confirmada por el portal' } });
            } else {
              result.status = 'submitted_unconfirmed';
              result.reason = 'Se envió el formulario, pero el portal no mostró una confirmación reconocible. Revisá la página abierta.';
            }
          }
          }
        }
      }
    }
  } catch (error) {
    const message = String(error?.message || error);
    if (page && !page.isClosed()) result.url = page.url();
    if (page && await hasBlocker(page).catch(() => false)) {
      result.status = 'needs_attention';
      result.reason = 'El portal requiere que completes una verificación humana. La pestaña queda abierta.';
    } else if (/No encontré un formulario de candidatura reconocible/i.test(message)) {
      result.status = 'no_application_form';
      result.reason = `No se detectó un formulario automático. Página actual: ${result.url || job.url}`;
    } else {
      result.status = 'error';
      result.reason = message.slice(0, 400);
    }
  }
  results.push(result);
  state.retryQueue = state.retryQueue.filter((id) => id !== job.id);
  cycleResults.push(result);
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  await writeFile(resultFile, JSON.stringify({ date: today, results }, null, 2));
  await setLiveStatus({ latestResult: { company: result.company, role: result.role, status: result.status, at: result.at }, currentJob: null, totalResults: results.length });
  console.log(`${result.status.padEnd(22)} [${job.source || 'bolsa'}] ${job.company} · ${job.role}${result.reason ? ` — ${result.reason}` : ''}`);
    if (page && ['needs_attention', 'ready_to_submit', 'submitted_unconfirmed'].includes(result.status)) {
      pendingPages.push(page);
      while (pendingPages.length > 3) await pendingPages.shift().close().catch(() => {});
    } else if (page) await page.close().catch(() => {});
  }
  if (cycleResults.length) {
    console.log(`${cycleResults.filter((result) => result.status === 'ready_to_submit').length} formularios listos para revisión · ${cycleResults.filter((result) => result.status === 'needs_attention').length} casos que requieren intervención · ${cycleResults.filter((result) => result.status === 'no_application_form').length} publicaciones sin formulario. Detalle en results.json.`);
    for (const result of cycleResults.filter((entry) => ['needs_attention', 'submitted_unconfirmed', 'ready_to_submit'].includes(entry.status))) {
      if (!state.pending.includes(result.jobId)) state.pending.push(result.jobId);
    }
    await writeFile(stateFile, JSON.stringify(state, null, 2));
    await setLiveStatus({ phase: 'Esperando la próxima búsqueda', currentJob: null, nextRunAt: new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString() });
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
await closeDashboard(dashboardServer);
await releaseRunnerLock();
console.log(`Resultado local: ${resultFile}`);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function wait(minutes) {
  const until = Date.now() + minutes * 60 * 1000;
  while (keepRunning && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, until - Date.now())));
}
function localDate() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }

async function claimRunnerLock(directory) {
  const lockPath = path.join(directory, 'runner.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return async () => {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid;
      try { pid = Number(JSON.parse(await readFile(lockPath, 'utf8')).pid); } catch {}
      if (pid && pid !== process.pid) {
        let activeRunner = false;
        try {
          process.kill(pid, 0);
          if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CommandLine }`], { timeout: 3000 });
            activeRunner = /(?:^|[\\/])agent[\\/]runner\.mjs\b/i.test(stdout);
          } else activeRunner = true;
        } catch (probeError) {
          if (probeError.code === 'EPERM') activeRunner = true;
        }
        if (activeRunner) throw new Error(`Ya hay un agente Postula activo (PID ${pid}). Cerrá esa ventana antes de iniciar otro.`);
      }
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error('No pude reservar el bloqueo único del agente.');
}

async function setLiveStatus(update = {}) {
  liveStatus = { ...liveStatus, ...update, updatedAt: new Date().toISOString() };
  await writeFile(statusFile, JSON.stringify({
    ...liveStatus,
    totals: {
      submitted: state.applied.length,
      attemptedToday: state.attemptedToday || 0,
      submittedToday: state.submittedToday || 0,
      processed: state.discovered.length,
    },
  }, null, 2));
}

async function startDashboard() {
  const port = Number(process.env.POSTULA_DASHBOARD_PORT || 4179);
  const server = createServer(async (request, response) => {
    const host = String(request.headers.host || '').toLowerCase();
    const origin = String(request.headers.origin || '').toLowerCase();
    const allowedOrigin = !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(host) || !allowedOrigin) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const pathname = new URL(request.url || '/', `http://127.0.0.1:${port}`).pathname;
    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Postula Desktop is running.');
      return;
    }
    if (request.method === 'GET' && pathname === '/api/status') {
      const snapshot = await readJson(resultFile, { results: [] });
      const waiting = [...approvalRequests.values()].filter((entry) => entry.expiresAt > Date.now());
      const seen = new Set();
      const recent = [];
      for (const entry of [...(snapshot.results || [])].reverse()) {
        if (seen.has(entry.jobId)) continue;
        seen.add(entry.jobId);
        recent.push(entry);
        if (recent.length === 8) break;
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({
        status: liveStatus,
        totals: { submitted: state.applied.length, attemptedToday: state.attemptedToday || 0, submittedToday: state.submittedToday || 0, processed: state.discovered.length },
        pendingApprovals: waiting,
        recent,
      }));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/approve') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 2048) break;
      }
      let jobId;
      try { jobId = JSON.parse(body).jobId; } catch {}
      const pending = approvalRequests.get(jobId);
      if (!pending || pending.expiresAt <= Date.now()) {
        response.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'La confirmación venció. Revisá la publicación abierta o volvé a iniciar el agente.' }));
        return;
      }
      approvedApplications.add(jobId);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/focus') {
      await activeApplicationPage?.bringToFront().catch(() => {});
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: Boolean(activeApplicationPage) }));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/stop') {
      keepRunning = false;
      await setLiveStatus({ phase: 'Deteniendo el agente', currentJob: liveStatus.currentJob });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404).end('Not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`API local para la app de escritorio disponible en ${`http://127.0.0.1:${port}`}`);
  await setLiveStatus({ phase: 'App lista · preparando navegador' });
  return server;
}

async function closeDashboard(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function requestDashboardApproval(job, page) {
  const expiresAt = Date.now() + 30 * 60 * 1000;
  const request = {
    jobId: job.id,
    company: job.company,
    role: job.role,
    source: job.source || 'Fuente pública',
    url: page.url(),
    match: job.match,
    expiresAt,
  };
  approvalRequests.set(job.id, request);
  activeApplicationPage = page;
  await setLiveStatus({ phase: 'Esperando tu confirmación', currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Formulario listo para enviar' } });
  try {
    while (keepRunning && Date.now() < expiresAt && !page.isClosed()) {
      if (approvedApplications.has(job.id)) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  } finally {
    approvalRequests.delete(job.id);
    approvedApplications.delete(job.id);
    if (activeApplicationPage === page) activeApplicationPage = null;
  }
}

async function discoverJobs(p) {
  const boards = String(p.greenhouse || '').split(/[\s,]+/).filter(Boolean);
  const sites = String(p.lever || '').split(/[\s,]+/).filter(Boolean);
  const lists = await Promise.allSettled([
    discoverRemotive(),
    discoverJobicy(),
    discoverRemoteOk(),
    discoverHimalayas(),
    discoverWeWorkRemotely(),
    discoverArbeitnow(),
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
  const jobs = [];
  for (const result of lists) {
    if (result.status === 'fulfilled') jobs.push(...result.value);
    else console.warn(`Fuente no disponible: ${result.reason?.message || result.reason}`);
  }
  if (!jobs.length) throw new Error('Ninguna fuente respondió.');
  const keyText = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return [...new Map(jobs.filter((job) => job.url).map((job) => [`${keyText(job.company)}|${keyText(job.role)}`, job])).values()];
}

async function discoverRemotive() {
  const json = await cachedJson('remotive', 'https://remotive.com/api/remote-jobs', 6 * 60 * 60 * 1000);
  return (json.jobs || []).map((job) => ({ id: `remotive-${job.id}`, company: job.company_name || 'Empresa', role: job.title, url: job.url, applicationUrl: extractApplicationUrl(job.description || ''), location: job.candidate_required_location || 'Remoto', description: stripHtml(job.description || ''), source: 'Remotive', remote: true }));
}

async function discoverJobicy() {
  const json = await cachedJson('jobicy', 'https://jobicy.com/api/jobs?count=200&geo=anywhere', 60 * 60 * 1000);
  return (json.jobs || []).map((job) => ({ id: `jobicy-${job.id}`, company: job.companyName || 'Empresa', role: job.jobTitle, url: job.url, applicationUrl: extractApplicationUrl(job.jobDescription || ''), location: job.jobGeo || 'Remoto', description: stripHtml(job.jobDescription || job.jobExcerpt || ''), source: 'Jobicy', remote: true }));
}

async function discoverRemoteOk() {
  const jobs = await cachedJson('remoteok', 'https://remoteok.com/api', 60 * 60 * 1000);
  return (Array.isArray(jobs) ? jobs : []).filter((job) => job.id && job.position).map((job) => ({ id: `remoteok-${job.id}`, company: job.company || 'Empresa', role: job.position, url: job.apply_url || job.url, location: job.location || 'Remoto', description: stripHtml(job.description || ''), source: 'Remote OK', remote: true }));
}

async function discoverHimalayas() {
  const terms = ['product designer', 'design engineer', 'project manager'];
  const lists = await Promise.all(terms.map(async (term) => {
    const url = `https://himalayas.app/jobs/api/search?${new URLSearchParams({ q: term, worldwide: 'true', sort: 'recent', page: '1' })}`;
    const json = await cachedJson(`himalayas-${term.replace(/\s+/g, '-')}`, url, 24 * 60 * 60 * 1000);
    return (json.jobs || []).filter((job) => !job.expiryDate || Number(job.expiryDate) * 1000 > Date.now()).map((job) => {
      const listingUrl = /^https?:\/\//i.test(job.guid || '') ? job.guid : `https://himalayas.app/companies/${encodeURIComponent(job.companySlug || '')}/jobs/${encodeURIComponent(job.guid || '')}`;
      const applicationUrl = extractApplicationUrl(job.description || '') || (/^https?:\/\//i.test(job.applicationLink || '') && !new URL(job.applicationLink).hostname.endsWith('himalayas.app') ? job.applicationLink : null);
      return { id: `himalayas-${job.guid}`, source: 'Himalayas', company: job.companyName || 'Empresa', role: job.title, url: listingUrl, listingUrl, applicationUrl, location: (job.locationRestrictions || []).join(', ') || 'Remoto', description: stripHtml(job.description || job.excerpt || ''), remote: true };
    });
  }));
  return lists.flat();
}

async function discoverWeWorkRemotely() {
  const categories = ['remote-design-jobs', 'remote-product-jobs', 'remote-management-and-finance-jobs'];
  const lists = await Promise.all(categories.map(async (category) => {
    const xml = await cachedText(`wwr-${category}`, `https://weworkremotely.com/categories/${category}.rss`, 60 * 60 * 1000);
    return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
      const title = xmlValue(item, 'title');
      const separator = title.indexOf(':');
      const company = separator > 0 ? title.slice(0, separator).trim() : 'Empresa';
      const role = separator > 0 ? title.slice(separator + 1).trim() : title;
      const descriptionHtml = xmlValue(item, 'description');
      return { id: `wwr-${xmlValue(item, 'guid') || xmlValue(item, 'link')}`, source: 'We Work Remotely', company, role, url: xmlValue(item, 'link'), applicationUrl: extractApplicationUrl(descriptionHtml), location: 'Remoto', description: stripHtml(descriptionHtml), remote: true };
    }).filter((job) => job.url && job.role);
  }));
  return lists.flat();
}

async function discoverArbeitnow() {
  const json = await cachedJson('arbeitnow', 'https://www.arbeitnow.com/api/job-board-api', 60 * 60 * 1000);
  return (json.data || []).map((job) => ({ id: `arbeitnow-${job.slug}`, company: job.company_name || 'Empresa', role: job.title, url: job.url, applicationUrl: extractApplicationUrl(job.description || ''), location: job.location || '', description: stripHtml(job.description || ''), source: 'Arbeitnow', remote: job.remote === true }));
}

async function cachedJson(key, url, maxAgeMs) {
  const file = path.join(workDir, 'cache', `${key}.json`);
  const cached = await readJson(file, null);
  if (cached?.fetchedAt && Date.now() - cached.fetchedAt < maxAgeMs) return cached.data;
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Postula job search' } });
  if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
  const data = await response.json();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), data }));
  return data;
}

async function cachedText(key, url, maxAgeMs) {
  const file = path.join(workDir, 'cache', `${key}.json`);
  const cached = await readJson(file, null);
  if (cached?.fetchedAt && Date.now() - cached.fetchedAt < maxAgeMs) return cached.data;
  const response = await fetch(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'Postula job search' } });
  if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
  const data = await response.text();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), data }));
  return data;
}

function extractApplicationUrl(html = '') {
  const ignoredHosts = /(?:^|\.)(?:remotive\.com|jobicy\.com|himalayas\.app|weworkremotely\.com|remoteok\.com|arbeitnow\.com)$/i;
  const atsHost = /greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|teamtailor|bamboohr|jobvite|workday|icims|recruitee|personio|pinpoint/i;
  const candidates = [...String(html).matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map((match) => {
    const open = match[0].match(/^<a\b[^>]*>/i)?.[0] || '';
    const href = open.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]?.replace(/&amp;/g, '&');
    const label = stripHtml(match[0].replace(open, '').replace(/<\/a>$/i, ''));
    try {
      const url = new URL(href);
      if (!/^https?:$/.test(url.protocol) || ignoredHosts.test(url.hostname)) return null;
      const explicit = /\bapply(?:\s+now|\s+for\s+(?:this\s+)?job)?\b|application form|submit (?:your )?application|postular|aplicar(?:se)?\b/i.test(label);
      const ats = atsHost.test(url.hostname);
      return explicit || ats ? { href: url.href, score: (explicit ? 3 : 0) + (ats ? 2 : 0) } : null;
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  return candidates[0]?.href || null;
}

function xmlValue(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return (match?.[1] || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
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
  const normalizeRole = (value) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(senior|sr|junior|jr|staff|principal|lead|associate|mid-level|midlevel)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const targetRoles = String(p.roles || '').split(/[,;\n]/).map(normalizeRole).filter(Boolean);
  const title = normalizeRole(String(job.role || ''));
  const targetsSoftwareEngineering = /software engineer|back.?end|front.?end|full.?stack|software developer/i.test(String(p.roles || ''));
  if (/expression of interest|talent pool|future opportunities|general interest|open application|mechanical design|cad engineer|manufacturing engineer|civil engineer|electrical engineer|construction engineer/.test(title)) return false;
  if (!targetsSoftwareEngineering && /back.?end|front.?end|full.?stack|software engineer|software developer|devops|data engineer/i.test(title)) return false;
  const hasTitleMatch = targetRoles.some((role) => title.includes(role));
  const seeksDesign = targetRoles.some((role) => /designer|design engineer|product design|ux|ui/.test(role));
  const seeksProjectManagement = targetRoles.some((role) => /project manager|program manager/.test(role));
  const hasDesignMatch = seeksDesign && /product designer|product design|design engineer|ux\s*ui designer|ux designer|ui designer/.test(title);
  const hasProjectManagementMatch = seeksProjectManagement && /project manager|program manager/.test(title);
  if (targetRoles.length && !hasTitleMatch && !hasDesignMatch && !hasProjectManagementMatch) return false;
  const mode = String(p.mode || 'Indistinto').toLowerCase();
  const remoteEvidence = `${job.location || ''} ${job.workplaceType || ''} ${job.type || ''} ${(job.tags || []).join(' ')}`;
  if (mode.includes('remoto') && job.remote !== true && !/remote|remoto|anywhere|worldwide|distributed|work from home|telecommute/i.test(remoteEvidence)) return false;
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
  return `${p.name}${p.location ? ` · ${p.location}` : ''}\n${[p.email, p.phone, p.link].filter(Boolean).join(' · ')}\n\n${job.role} · ${job.company}\n\n${p.summary || ''}${skills.length ? `\n\nCOMPETENCIAS RELEVANTES\n${skills.join(' · ')}` : ''}\n\nEXPERIENCIA RELEVANTE\n${rankedExperience || original}\n\nCV DE ORIGEN\n${original}\n\nSe priorizan el puesto y las competencias que ya aparecen en tu perfil. No se agregan logros ni credenciales.`.trim();
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
  return /captcha|verify (?:that )?you(?:'| a)?re human|checking your browser|security verification|robot check|security check|are you a robot/i.test(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
}
async function waitForHumanChallenge(page, job) {
  console.log(`\nEl portal solicita una verificación humana: ${job.company} · ${job.role}`);
  console.log('Resolvela vos en la pestaña abierta. El agente esperará hasta 10 minutos y continuará si la página queda habilitada. No intenta resolver ni evadir el CAPTCHA.');
  await setLiveStatus({ phase: 'Esperando resolución manual de verificación', currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Resolvé la verificación en la pestaña del portal' } });
  const deadline = Date.now() + 10 * 60 * 1000;
  while (keepRunning && Date.now() < deadline && !page.isClosed()) {
    if (!await hasBlocker(page).catch(() => false)) break;
    await page.waitForTimeout(1500);
  }
}
async function findApplicationUrl(page, job = {}) {
  if (job.applicationUrl) {
    try {
      if (/^https?:$/.test(new URL(job.applicationUrl).protocol)) return job.applicationUrl;
    } catch {}
  }
  const currentOrigin = new URL(page.url()).origin;
  const currentHost = new URL(page.url()).hostname.toLowerCase();
  if (/(?:^|\.)jobs\.lever\.co$|(?:^|\.)boards\.greenhouse\.io$|(?:^|\.)job-boards\.greenhouse\.io$|(?:^|\.)jobs\.ashbyhq\.com$|(?:^|\.)apply\.workable\.com$|(?:^|\.)jobs\.smartrecruiters\.com$|(?:^|\.)careers\.smartrecruiters\.com$|\.myworkdayjobs\.com$|\.recruitee\.com$|\.teamtailor\.com$|\.bamboohr\.com$/i.test(currentHost)) return null;
  const candidates = await page.locator('a[href]').evaluateAll((links) => links.map((link) => ({
    href: link.href,
    label: `${link.innerText || ''} ${link.getAttribute('aria-label') || ''} ${link.title || ''}`.trim(),
    host: (() => { try { return new URL(link.href).hostname; } catch { return ''; } })(),
  })));
  const external = candidates.filter((link) => {
    if (!/^https?:/i.test(link.href) || new URL(link.href).origin === currentOrigin) return false;
    const host = link.host.toLowerCase();
    return /apply|application|career|job|candidate|workable|greenhouse|lever|ashby|smartrecruiters|teamtailor|bamboohr|jobvite|workday|icims|recruitee/i.test(`${link.label} ${link.href} ${host}`);
  });
  const jobCompany = String(job.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const official = external.find((link) => jobCompany && (new URL(link.href).hostname.toLowerCase().replace(/[^a-z0-9]/g, '').includes(jobCompany) || jobCompany.includes(new URL(link.href).hostname.split('.')[0].replace(/[^a-z0-9]/g, ''))));
  const ats = external.find((link) => /greenhouse|lever\.co|ashbyhq|smartrecruiters|teamtailor|bamboohr|jobvite|workday|icims|recruitee/i.test(link.href));
  const explicit = external.find((link) => /apply|application|apply now|apply for this job|postular|aplicar/i.test(link.label));
  const chosen = official || ats || explicit;
  if (chosen) return chosen.href;
  const link = page.getByRole('link', { name: /apply|apply now|aplicar|postular|apply for this job/i }).first();
  if (await link.count().catch(() => 0)) {
    const href = await link.getAttribute('href').catch(() => null);
    if (href) return new URL(href, page.url()).href;
  }
  if (job.source === 'Himalayas' && job.url && new URL(job.url).origin !== currentOrigin) return job.url;
  return null;
}
async function hasConfirmation(page) {
  return /application (was )?submitted|thank you for applying|thanks for applying|application received|candidatura enviada|gracias por postular|recibimos tu postulación/i.test(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
}
async function openApplicationForm(page, job = {}) {
  const findForm = async () => {
    const forms = page.locator('form');
    const snapshots = await forms.evaluateAll((nodes) => nodes.map((form, index) => {
      const fields = [...form.querySelectorAll('input,textarea,select')];
      const labels = fields.map((el) => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), [...(el.labels || [])].map((label) => label.innerText).join(' ')].join(' ').toLowerCase());
      return { index, text: form.innerText.toLowerCase(), labels, hasFile: fields.some((el) => el.type === 'file' && /resume|cv|curriculum|attachment|pdf/i.test(`${el.name} ${el.accept} ${el.getAttribute('aria-label') || ''}`)), fieldCount: fields.length };
    }));
    const ranked = snapshots.map((form) => ({ ...form, score: (form.labels.some((text) => /e-?mail/.test(text)) ? 1 : 0) + (form.labels.some((text) => /first name|full name|applicant name|given name|nombre/.test(text)) ? 2 : 0) + (form.hasFile ? 3 : 0) + (/application|apply|candidatura|postulaci[oó]n/.test(form.text) ? 2 : 0) })).filter((form) => form.fieldCount >= 2 && form.score >= 2).sort((a, b) => b.score - a.score);
    if (ranked.length) return forms.nth(ranked[0].index);

    const containers = page.locator('main,[role="main"],#application,#application-form,#app_body,[data-testid*="application"]');
    const containerSnapshots = await containers.evaluateAll((nodes) => nodes.map((node, index) => {
      const fields = [...node.querySelectorAll('input,textarea,select')];
      const labels = fields.map((el) => [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), [...(el.labels || [])].map((label) => label.innerText).join(' ')].join(' ').toLowerCase());
      return { index, text: node.innerText.toLowerCase(), labels, fieldCount: fields.length, hasFile: fields.some((el) => el.type === 'file' && /resume|cv|curriculum|attachment|pdf/i.test(`${el.name} ${el.accept} ${el.getAttribute('aria-label') || ''}`)) };
    }));
    const app = containerSnapshots.map((node) => ({ ...node, score: (node.labels.some((text) => /e-?mail/.test(text)) ? 1 : 0) + (node.labels.some((text) => /first name|full name|applicant name|given name|nombre/.test(text)) ? 2 : 0) + (node.hasFile ? 3 : 0) + (/application|apply|candidatura|postulaci[oó]n/.test(node.text) || /\/apply(?:\/|\?|$)/i.test(page.url()) ? 2 : 0) })).filter((node) => node.fieldCount >= 2 && node.score >= 3).sort((a, b) => b.score - a.score);
    if (app.length) return containers.nth(app[0].index);
    return null;
  };
  let form = await findForm();
  if (form) return { page, form };
  const applyLinks = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => ({ href: node.href, text: `${node.innerText || ''} ${node.getAttribute('aria-label') || ''} ${node.title || ''}`.trim() })));
  const applyLink = applyLinks.find((link) => /apply|application|aplicar|postular/i.test(link.text) && /^https?:/i.test(link.href));
  if (applyLink) {
    const destination = new URL(applyLink.href, page.url()).href;
    if (destination !== page.url()) await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
  } else {
    const applyButton = page.getByRole('button', { name: /apply|aplicar|postular/i }).first();
    if (await applyButton.count() && await applyButton.isVisible().catch(() => false)) {
      const popupPromise = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
      await applyButton.click({ timeout: 8000 }).catch(() => {});
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        if (await hasBlocker(popup)) {
          await waitForHumanChallenge(popup, job);
          if (await hasBlocker(popup)) return { page: popup, form: null };
        }
        const popupForm = await findFormOnPage(popup);
        if (popupForm) return { page: popup, form: popupForm };
        await popup.close().catch(() => {});
      }
      await page.waitForTimeout(1200);
    }
  }
  form = await findForm();
  if (!form) throw new Error('No encontré un formulario de candidatura reconocible en este portal.');
  return { page, form };
}

async function findFormOnPage(page) {
  const forms = page.locator('form');
  const count = await forms.count();
  if (count) {
    const ranked = await forms.evaluateAll((nodes) => nodes.map((form, index) => {
      const fields = [...form.querySelectorAll('input,textarea,select')];
      const labels = fields.map((el) => `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') || ''} ${[...(el.labels || [])].map((label) => label.innerText).join(' ')}`.toLowerCase());
      return { index, score: (labels.some((text) => /e-?mail/.test(text)) ? 1 : 0) + (labels.some((text) => /first name|full name|nombre/.test(text)) ? 2 : 0) + (fields.some((el) => el.type === 'file') ? 2 : 0) + (/application|apply|candidatura/.test(form.innerText.toLowerCase()) ? 2 : 0), count: fields.length };
    }));
    const best = ranked.filter((form) => form.score >= 2 && form.count >= 2).sort((a, b) => b.score - a.score)[0];
    if (best) return forms.nth(best.index);
  }
  const main = page.locator('main,[role="main"],#application,#application-form,#app_body').first();
  return await main.count() && await main.locator('input,textarea,select').count() >= 2 ? main : null;
}

function valueFor(label, p, job = {}) {
  const text = label.toLowerCase().replace(/[_-]+/g, ' ');
  if (/e-?mail/.test(text)) return p.email;
  if (/phone|mobile|tel[eé]fono|celular/.test(text)) return p.phone;
  if (/current company|current employer|present employer|empresa actual/.test(text)) return p.currentCompany || '';
  if (/full name|your name|^name$|nombre completo/.test(text)) return p.name;
  if (/first name|given name|nombre\b/.test(text) && !/last|apellido/.test(text)) return p.name?.trim().split(/\s+/)[0];
  if (/last name|family name|surname|apellido/.test(text)) return p.name?.trim().split(/\s+/).slice(1).join(' ');
  if (/country|pa[ií]s/.test(text)) return p.location?.split(',').at(-1).trim();
  if (/linkedin/.test(text)) return p.linkedin || (/linkedin/i.test(p.link || '') ? p.link : '');
  if (/portfolio|website|web site|personal site|sitio web/.test(text)) return p.portfolio || p.link;
  if (/postal|zip code|postcode/.test(text)) return p.postalCode || '';
  if (/state|province|provincia/.test(text)) return p.location?.split(',').at(-2)?.trim() || '';
  if (/city|location|ubicaci[oó]n|ciudad/.test(text)) return p.location?.split(',')[0].trim();
  if (/cover letter|carta de presentaci[oó]n|professional summary|resumen profesional/.test(text)) return p.summary || '';
  if (/right to work|work authorization|authori[sz]ed to work|visa sponsorship|sponsorship|work permit|employment eligibility|permiso de trabajo/.test(text)) {
    const context = normalizeAnswer(`${label} ${job.location || ''}`);
    const authorization = normalizeAnswer(p.workAuthorization || '');
    if (/united kingdom|\buk\b|britain|england|london|scotland|wales/.test(context) && /need[^.]{0,30}sponsor|require[^.]{0,30}sponsor/.test(authorization)) return 'I need employer visa sponsorship to work in the United Kingdom.';
    if (/european union|\beu\b|europe|germany|france|spain|italy|netherlands|ireland|sweden|denmark|portugal/.test(context) && /(eu|europe)[^.]{0,40}(citizen|authorized|authorised|right to work)|citizen[^.]{0,30}(eu|europe)/.test(authorization)) return 'I am an Italian/EU citizen and authorized to work in EU member states.';
    return '';
  }
  if (/salary|compensation|remuneration|salario|sueldo/.test(text) && (/annual|yearly|per year|salary expectation|salary range|expectativa salarial|pretensi[oó]n salarial|usd/.test(text))) return p.salaryExpectation || '';
  if (/website|url|link/.test(text)) return p.link || '';
  return '';
}

async function fillKnownFields(form, p, cvPath, job = {}) {
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
      const metadata = await field.evaluate((el) => ({
        option: el.labels ? [...el.labels].map((item) => item.innerText).join(' ').trim() : el.getAttribute('aria-label') || el.value || 'confirmación legal',
        question: el.closest('.application-question,fieldset,[role="group"]')?.innerText?.trim() || el.closest('label')?.innerText?.trim() || el.name || '',
        group: el.closest('.application-question,fieldset,[role="group"]')?.id || el.closest('.application-question,fieldset,[role="group"]')?.getAttribute('data-qa') || el.name || '',
      }));
      const option = metadata.option;
      const groupName = metadata.group || `${type}-${i}`;
      const groups = type === 'radio' ? radioGroups : checkboxGroups;
      if (!groups.has(groupName)) groups.set(groupName, { label: metadata.question || option, required });
      const automaticRadio = type === 'radio' && autoRadioOption(metadata.question, option, p, job);
      if ((type === 'radio' ? selectedRadios : selectedCheckboxes).has(normalizeAnswer(option)) || automaticRadio) {
        await field.check({ timeout: 1500 }).catch(() => {});
      }
      continue;
    }
    const label = await field.evaluate((el) => [el.labels ? [...el.labels].map((item) => item.innerText).join(' ') : '', el.closest('.application-question,fieldset,[role="group"]')?.innerText || '', el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', el.getAttribute('name') || '', el.id || ''].join(' '));
    const mapped = valueFor(label, p, job);
    if (mapped && type !== 'file' && await field.inputValue().catch(() => '') === '') {
      if (await field.evaluate((el) => el.tagName === 'SELECT')) {
        const optionLabels = await field.locator('option').allTextContents().catch(() => []);
        const country = p.location?.split(',').at(-1).trim();
        const option = ( /which location are you applying for|country|pa[ií]s/i.test(label) && country
          ? optionLabels.find((item) => normalizeAnswer(item).includes(normalizeAnswer(country)))
          : optionLabels.find((item) => normalizeAnswer(item) === normalizeAnswer(mapped)) ) || ( /city|location|ubicaci[oó]n|ciudad/i.test(label)
          ? optionLabels.find((item) => normalizeAnswer(item).includes(normalizeAnswer(p.location?.split(',')[0] || ''))) : null );
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

function autoRadioOption(question = '', option = '', profile = {}, job = {}) {
  const q = normalizeAnswer(`${question} ${job.location || ''}`);
  const choice = normalizeAnswer(option);
  const authorization = normalizeAnswer(profile.workAuthorization || '');
  if (!/^(yes|no|si|sí)$/.test(choice)) return false;
  const uk = /united kingdom|\buk\b|britain|england|london|scotland|wales/i.test(q);
  const eu = /european union|\beu\b|europe/i.test(q);
  const sponsorship = /sponsor|visa|work permit/.test(q);
  const workRight = /right to work|authorized to work|authorised to work|work authorization|work eligibility|eligible to work/.test(q);
  const needsUK = /uk[^.]{0,40}(need|require)[^.]{0,20}sponsor|need[^.]{0,25}sponsor[^.]{0,25}uk/i.test(authorization);
  const authorizedEU = /(eu|europe)[^.]{0,40}(citizen|authorized|authorised|right to work)|citizen[^.]{0,30}(eu|europe)/i.test(authorization);
  if (uk && needsUK && sponsorship) return /^(yes|si|sí)$/.test(choice);
  if (uk && needsUK && workRight) return /^(no)$/.test(choice);
  if (eu && authorizedEU && sponsorship) return /^(no)$/.test(choice);
  if (eu && authorizedEU && workRight) return /^(yes|si|sí)$/.test(choice);
  return false;
}

function normalizeAnswer(value = '') { return String(value).replace(/\s+/g, ' ').trim().toLowerCase(); }
