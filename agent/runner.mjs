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
const settings = payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)
  ? { ...payload.settings }
  : {
      minimumMatch: payload.minimumMatch || payload.minimumMatchPercent || payload.autoThreshold || profile.autoThreshold,
      dailyLimit: payload.dailyLimit || profile.dailyLimit,
      intervalMinutes: payload.intervalMinutes,
      browserHeadless: payload.browserHeadless,
    };
let minimumMatch = Number(settings.minimumMatch || settings.minimumMatchPercent || profile.autoThreshold || payload.autoThreshold || 80);
let dailyLimit = Math.max(1, Math.min(10000, Number(settings.dailyLimit || payload.dailyLimit || profile.dailyLimit || 5)));
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
let intervalMinutes = Math.max(1, Math.min(1440, Number(settings.intervalMinutes || 30)));
const browserHeadless = settings.browserHeadless !== false;
const webSearchIntervalMs = 6 * 60 * 60 * 1000;
let lastWebSearchAt = 0;
let lastWebSearchNoticeAt = 0;
const approvalRequests = new Map();
const approvedApplications = new Set();
let liveStatus = { phase: 'Iniciando', jobsFound: 0, matched: 0, currentJob: null, updatedAt: new Date().toISOString() };
let activeApplicationPage = null;
let keepRunning = true;
let forceSearchRequested = false;
let wakeScheduledSearch = null;
let pendingDesktopConfig = null;
let cachedProfileVectorKey = '';
let cachedProfileVector = new Map();
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
  headless: browserHeadless,
  viewport: null,
  args: browserHeadless ? [] : ['--start-maximized'],
});
const pdfBrowser = await chromium.launch({ headless: true });
while (keepRunning) {
  if (pendingDesktopConfig) {
    Object.assign(profile, pendingDesktopConfig.profile);
    minimumMatch = pendingDesktopConfig.minimumMatch;
    dailyLimit = pendingDesktopConfig.dailyLimit;
    intervalMinutes = pendingDesktopConfig.intervalMinutes;
    cachedProfileVectorKey = '';
    cachedProfileVector = new Map();
    pendingDesktopConfig = null;
  }
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
  const excludedOffers = new Set(results.filter((entry) => entry.status === 'excluded').map(offerFingerprint));
  const appliedOffers = new Set(results.filter((entry) => ['submitted', 'submitted_unconfirmed'].includes(entry.status)).map(offerFingerprint));
  const latestById = new Map();
  for (const entry of results) if (entry.jobId) latestById.set(entry.jobId, entry);
  const retryableReady = new Set([...latestById.values()]
    .filter((entry) => entry.status === 'ready_to_submit'
      && !approvalRequests.has(entry.jobId)
      && Date.now() - Date.parse(entry.at || 0) >= 15 * 60 * 1000)
    .map((entry) => entry.jobId));
  const resumeJobs = [...latestById.values()]
    .filter((entry) => retryableReady.has(entry.jobId) && /^https?:\/\//i.test(entry.url || ''))
    .map((entry) => ({
      id: entry.jobId, company: entry.company, role: entry.role, source: entry.source,
      url: entry.url, applyUrl: entry.url, applicationUrl: entry.url,
      location: entry.location || '', score: Number(entry.match || 0),
    }));
  const availableJobs = [...new Map([...resumeJobs, ...jobs].filter((job) => job.id && job.url).map((job) => [job.id, job])).values()];
  const pendingOffers = new Set(results
    .filter((entry) => ['needs_attention', 'ready_to_submit'].includes(entry.status) && !retryableReady.has(entry.jobId))
    .map(offerFingerprint));
  for (const prior of results) {
    if (!prior.jobId) continue;
    if (!state.discovered.includes(prior.jobId)) state.discovered.push(prior.jobId);
    if (['needs_attention', 'ready_to_submit', 'submitted_unconfirmed'].includes(prior.status) && !state.pending.includes(prior.jobId)) state.pending.push(prior.jobId);
  }
  if ((state.runnerVersion || 0) < 4) {
    state.retryQueue = [...latestById.values()]
      .filter((entry) => ['error', 'no_application_form'].includes(entry.status)
        || (entry.status === 'needs_attention' && /no mostró un formulario/i.test(entry.reason || ''))
        || retryableReady.has(entry.jobId))
      .slice(-30).reverse().map((entry) => entry.jobId);
    state.runnerVersion = 4;
    if (state.retryQueue.length) console.log(`Reintentaré ${state.retryQueue.length} avisos que antes fallaron al detectar el formulario.`);
  }
  for (const jobId of retryableReady) if (!state.retryQueue.includes(jobId)) state.retryQueue.push(jobId);
  const scopedJobs = availableJobs.filter((job) => inScope(job, profile));
  const candidates = scopedJobs
    .map((job) => ({ ...job, match: Number(job.score ?? scoreJob(job, profile)) }))
    .filter((job) => job.match >= minimumMatch && !state.excluded.includes(job.id) && !state.applied.includes(job.id) && !state.attempted.includes(job.id) && !excludedOffers.has(offerFingerprint(job)) && !appliedOffers.has(offerFingerprint(job)) && !pendingOffers.has(offerFingerprint(job)) && (state.retryQueue.includes(job.id) || (!state.pending.includes(job.id) && !state.discovered.includes(job.id))))
    .sort((a, b) => regionPriority(a, profile) - regionPriority(b, profile) || b.match - a.match)
    .slice(0, state.retryQueue.length ? 3 : 30);
  const cycleResults = [];
  const latestResultById = new Map();
  for (const entry of results) if (entry.jobId) latestResultById.set(entry.jobId, entry);
  const offerCatalog = scopedJobs
    .map((job) => {
      const previous = latestResultById.get(job.id);
      return {
        id: job.id, jobId: job.id, role: job.role, company: job.company, source: job.source || 'Fuente pública',
        location: job.location || 'Ubicación por confirmar', region: regionLabel(job, profile),
        match: Number(job.score ?? scoreJob(job, profile)), status: state.excluded.includes(job.id) ? 'excluded' : previous?.status || 'discovered', reason: state.excluded.includes(job.id) ? 'Excluida desde Postula.' : previous?.reason || '',
        url: job.applicationUrl || job.applyUrl || job.url,
      };
    })
    .sort((a, b) => regionPriority(a, profile) - regionPriority(b, profile) || b.match - a.match)
    .slice(0, 500);
  const matchCount = scopedJobs.filter((job) => Number(job.score ?? scoreJob(job, profile)) >= minimumMatch && !state.excluded.includes(job.id)).length;
  const matches = scopedJobs.filter((job) => Number(job.score ?? scoreJob(job, profile)) >= minimumMatch)
    .sort((a, b) => regionPriority(a, profile) - regionPriority(b, profile) || Number(b.score ?? scoreJob(b, profile)) - Number(a.score ?? scoreJob(a, profile)))
    .map((job) => ({
    id: job.id, role: job.role, company: job.company, source: job.source || 'Fuente pública',
    location: job.location || 'Remoto · alcance a confirmar', match: Number(job.score ?? scoreJob(job, profile)),
    region: regionLabel(job, profile),
    url: job.applicationUrl || job.applyUrl || job.url,
  })).slice(0, 60);
  await setLiveStatus({ phase: candidates.length ? 'Revisando ofertas compatibles' : 'Búsqueda en curso', jobsFound: jobs.length, offersInScope: scopedJobs.length, matched: matchCount, matches, offerCatalog, currentJob: null, error: '' });
  if (!candidates.length) console.log(`Ciclo completo · ${matchCount} ofertas coinciden con tu perfil; ninguna nueva para revisar.`);
  else console.log(`Agente Postula · ${candidates.length} ofertas nuevas · ${matchCount} compatibles · encaje mínimo ${minimumMatch}% · máximo ${dailyLimit} envíos/día`);

  const pendingPages = [];
  for (const job of candidates) {
  await setLiveStatus({ currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Abriendo publicación' } });
  const result = { jobId: job.id, source: job.source, company: job.company, role: job.role, url: job.url, location: job.location || '', match: job.match, region: regionLabel(job, profile), at: new Date().toISOString() };
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
      result.reason = 'El sitio requiere una verificación humana. Abrí el aviso desde Actividad reciente si querés revisarlo; Postula no resuelve ni evade CAPTCHAs.';
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
        result.reason = 'El sitio requiere una verificación manual. Abrí el aviso desde Actividad reciente si querés revisarlo.';
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
          if (state.excluded.includes(job.id)) {
            result.status = 'excluded';
            result.reason = 'Excluida desde Postula.';
          } else if (!approved) {
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
      result.reason = 'El portal requiere una verificación humana. Abrí el aviso desde Actividad reciente si querés revisarlo.';
    } else if (/No encontré un formulario de candidatura reconocible/i.test(message)) {
      const verificationRequired = page && await hasVerificationGate(page).catch(() => false);
      result.status = verificationRequired ? 'needs_attention' : 'no_application_form';
      result.reason = verificationRequired
        ? 'El portal no cargó el formulario y presentó una verificación anti-bot. Requiere revisión manual; Postula no intenta resolverla.'
        : `No se detectó un formulario automático. Página actual: ${result.url || job.url}`;
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
    if (page && (result.status === 'ready_to_submit' || (!browserHeadless && ['needs_attention', 'submitted_unconfirmed'].includes(result.status)))) {
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
    console.log(`Próxima búsqueda en ${intervalMinutes} minutos. Dejá Postula abierto; la automatización del navegador funciona en segundo plano.`);
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
  if (!keepRunning) return;
  if (forceSearchRequested) { forceSearchRequested = false; return; }
  await new Promise((resolve) => {
    const timer = setTimeout(() => { wakeScheduledSearch = null; resolve(); }, minutes * 60 * 1000);
    wakeScheduledSearch = () => { clearTimeout(timer); wakeScheduledSearch = null; forceSearchRequested = false; resolve(); };
  });
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
  const { offerCatalog, ...persistedStatus } = liveStatus;
  await writeFile(statusFile, JSON.stringify({
    ...persistedStatus,
    totals: {
      submitted: state.applied.length,
      attemptedToday: state.attemptedToday || 0,
      submittedToday: state.submittedToday || 0,
      processed: state.discovered.length,
    },
  }, null, 2));
}

async function readRequestJson(request, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error('El archivo excede el tamaño permitido.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
      const waiting = [...approvalRequests.values()].filter((entry) => entry.expiresAt > Date.now() && !state.excluded.includes(entry.jobId));
      const seen = new Set();
      const recent = [];
      const history = [];
      for (const entry of [...(snapshot.results || [])].reverse()) {
        if (!entry.jobId || seen.has(entry.jobId)) continue;
        seen.add(entry.jobId);
        if (recent.length < 8) recent.push(entry);
        if (history.length < 500) history.push(entry);
      }
      const liveCatalog = liveStatus.offerCatalog || [];
      const historyById = new Map(history.map((entry) => [entry.jobId, entry]));
      const liveIds = new Set(liveCatalog.map((entry) => entry.jobId));
      const offers = [
        ...liveCatalog.map((entry) => {
          const previous = historyById.get(entry.jobId);
          return previous ? { ...entry, ...previous, location: entry.location, region: entry.region } : entry;
        }),
        ...history.filter((entry) => !liveIds.has(entry.jobId)),
      ].slice(0, 500);
      const { offerCatalog: _offerCatalog, ...publicStatus } = liveStatus;
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({
        status: publicStatus,
        totals: { submitted: state.applied.length, attemptedToday: state.attemptedToday || 0, submittedToday: state.submittedToday || 0, processed: state.discovered.length },
        pendingApprovals: waiting,
        recent,
        offers,
        historyTotal: offers.length,
        minimumMatch,
        dailyLimit,
        jobsFound: liveStatus.jobsFound || 0,
        offersInScope: liveStatus.offersInScope || 0,
      }));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/analyze-cv') {
      try {
        const body = await readRequestJson(request, 12 * 1024 * 1024);
        const fileBytes = Buffer.from(String(body.contentBase64 || ''), 'base64');
        if (!fileBytes.length || fileBytes.length > 8 * 1024 * 1024) throw new Error('El CV debe tener contenido y pesar hasta 8 MB.');
        let text;
        if (/\.pdf$/i.test(String(body.fileName || ''))) {
          const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
          const document = await pdfjs.getDocument({ data: new Uint8Array(fileBytes), useSystemFonts: true }).promise;
          if (document.numPages > 35) throw new Error('El CV supera el máximo de 35 páginas.');
          const pages = [];
          for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            pages.push(content.items.map((item) => item.str || '').join(' '));
          }
          text = pages.join('\n\n');
        } else text = fileBytes.toString('utf8');
        text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (text.length < 80) throw new Error('No pude extraer suficiente texto. Si el PDF es escaneado, pegá el texto del CV.');
        const skillCatalog = ['figma', 'ux research', 'user research', 'product design', 'design systems', 'prototyping', 'accessibility', 'usability testing', 'interaction design', 'stakeholder management', 'project management', 'agile', 'scrum', 'jira', 'service design', 'html', 'css'];
        const skills = skillCatalog.filter((skill) => text.toLowerCase().includes(skill));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ text, name: text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line.length < 80 && !/resume|curriculum vitae|\bcv\b/i.test(line)) || '', email: text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] || '', phone: text.match(/(?:\+?\d[\d ()-]{7,}\d)/)?.[0]?.trim() || '', linkedin: text.match(/https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/[\w%/-]+/i)?.[0] || '', skills, analyzedAt: new Date().toISOString() }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message || 'No pude analizar el CV.' }));
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/configure') {
      try {
        const body = await readRequestJson(request, 512 * 1024);
        const incoming = body.profile || {};
        const nextProfile = { ...profile };
        for (const key of ['name', 'email', 'phone', 'location', 'roles', 'mode', 'resume', 'summary', 'experience', 'skills', 'link', 'linkedin', 'portfolio', 'currentCompany', 'salaryExpectation', 'workAuthorization', 'regionPreference']) {
          if (typeof incoming[key] === 'string') nextProfile[key] = incoming[key].slice(0, key === 'resume' || key === 'experience' ? 250000 : 4000).trim();
        }
        nextProfile.mode ||= 'Remoto';
        if (!nextProfile.name || !nextProfile.email || !nextProfile.roles || !nextProfile.resume) throw new Error('Completá nombre, email, puestos objetivo y CV.');
        const nextMinimumMatch = Math.max(30, Math.min(95, Number(body.minimumMatch) || minimumMatch));
        const nextDailyLimit = Math.max(1, Math.min(10000, Number(body.dailyLimit) || dailyLimit));
        const nextIntervalMinutes = Math.max(1, Math.min(1440, Number(body.intervalMinutes) || intervalMinutes));
        settings.minimumMatch = nextMinimumMatch;
        settings.dailyLimit = nextDailyLimit;
        settings.intervalMinutes = nextIntervalMinutes;
        payload.profile = nextProfile;
        payload.settings = settings;
        await writeFile(profileFile, JSON.stringify(payload, null, 2), 'utf8');
        pendingDesktopConfig = { profile: nextProfile, minimumMatch: nextMinimumMatch, dailyLimit: nextDailyLimit, intervalMinutes: nextIntervalMinutes };
        forceSearchRequested = true;
        await setLiveStatus({ phase: 'Perfil guardado · buscando ahora', currentJob: null, error: '' });
        wakeScheduledSearch?.();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, nextSearch: 'immediate', minimumMatch: nextMinimumMatch, dailyLimit: nextDailyLimit, intervalMinutes: nextIntervalMinutes }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message || 'No pude guardar el perfil.' }));
      }
      return;
    }
    if (request.method === 'POST' && pathname === '/api/search-now') {
      if (!keepRunning) {
        response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'El agente está detenido. Inicialo para buscar ofertas.' }));
        return;
      }
      forceSearchRequested = true;
      wakeScheduledSearch?.();
      await setLiveStatus({ phase: 'Búsqueda solicitada · preparando el próximo ciclo', error: '' });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, nextSearch: 'immediate' }));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/exclude') {
      try {
        const body = await readRequestJson(request, 2048);
        const jobId = String(body.jobId || '').trim().slice(0, 500);
        if (!jobId) throw new Error('Falta identificar la oferta que querés excluir.');
        if (state.applied.includes(jobId)) throw new Error('Esta postulación ya figura como enviada y confirmada.');
        if (!state.excluded.includes(jobId)) state.excluded.push(jobId);
        state.retryQueue = state.retryQueue.filter((id) => id !== jobId);
        const snapshot = await readJson(resultFile, { date: localDate(), results: [] });
        snapshot.results ||= [];
        const previous = [...snapshot.results].reverse().find((entry) => entry.jobId === jobId);
        const liveOffer = (liveStatus.offerCatalog || []).find((entry) => entry.jobId === jobId);
        const source = previous || liveOffer;
        if (source) {
          const updated = { ...source, status: 'excluded', reason: 'Excluida desde Postula.', at: new Date().toISOString() };
          snapshot.results = [...snapshot.results, updated];
          await writeFile(resultFile, JSON.stringify(snapshot, null, 2));
        }
        await writeFile(stateFile, JSON.stringify(state, null, 2));
        if (liveOffer) {
          liveOffer.status = 'excluded';
          liveOffer.reason = 'Excluida desde Postula.';
        }
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, jobId }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message || 'No pude excluir esta oferta.' }));
      }
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
      if (state.excluded.includes(jobId)) {
        response.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Esta oferta ya fue descartada.' }));
        return;
      }
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
      wakeScheduledSearch?.();
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
  const expiresAt = Date.now() + 5 * 60 * 1000;
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
    while (keepRunning && !state.excluded.includes(job.id) && Date.now() < expiresAt && !page.isClosed()) {
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
    discoverActiveVacancies(p),
    discoverUxJobs(),
    discoverPythonScrape(p),
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
    discoverWebSearch(p),
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

async function discoverPythonScrape(p) {
  const script = path.join(root, 'agent', 'public_scraper.py');
  const cachePath = path.join(workDir, 'cache', 'python-scraper.json');
  const cached = await readJson(cachePath, null);
  if (cached?.roles === String(p.roles || '') && cached?.fetchedAt && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached.jobs || [];
  const input = JSON.stringify({ roles: p.roles || '' });
  for (const [command, prefix] of [['python', []], ['py', ['-3']]]) {
    try {
      const { stdout } = await execFileAsync(command, [...prefix, script, input], { timeout: 45000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      const jobs = JSON.parse(stdout);
      console.log(`Scraper Python: ${Array.isArray(jobs) ? jobs.length : 0} avisos públicos revisados.`);
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify({ roles: String(p.roles || ''), fetchedAt: Date.now(), jobs: Array.isArray(jobs) ? jobs : [] }));
      return Array.isArray(jobs) ? jobs : [];
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      console.warn(`Scraper Python omitido: ${error.message || error}`);
      return [];
    }
  }
  console.warn('Python no está instalado; continúan activos los feeds gratuitos del agente.');
  return [];
}

async function discoverWebSearch(p) {
  const openAiKeyPath = path.join(workDir, 'openai-api-key.txt');
  const keyPath = path.join(workDir, 'brave-search-api-key.txt');
  const openAiKey = process.env.OPENAI_API_KEY || (await readFile(openAiKeyPath, 'utf8').catch(() => '')).trim();
  const braveKey = process.env.POSTULA_BRAVE_SEARCH_API_KEY || (await readFile(keyPath, 'utf8').catch(() => '')).trim();
  const provider = openAiKey ? 'OpenAI' : braveKey ? 'Brave' : '';
  if (!provider) {
    if (Date.now() - lastWebSearchNoticeAt > webSearchIntervalMs) {
      console.log('Búsqueda web amplia desactivada: configurá una clave local de OpenAI o Brave; los feeds gratuitos siguen activos.');
      lastWebSearchNoticeAt = Date.now();
    }
    return [];
  }
  if (lastWebSearchAt && Date.now() - lastWebSearchAt < webSearchIntervalMs) return [];
  lastWebSearchAt = Date.now();
  const configuredRoles = String(p.roles || '').split(/[,;\n]+/).map((role) => role.trim()).filter(Boolean);
  const roles = configuredRoles.length ? configuredRoles : ['Product Designer', 'Design Engineer', 'Project Manager'];
  const midpoint = Math.ceil(roles.length / 2);
  const quoteRoles = (values) => values.map((role) => `"${role.replace(/["\\]/g, '')}"`).join(' OR ');
  const queryGroups = [
    `(${quoteRoles(roles.slice(0, midpoint))}) (remote OR remoto OR Argentina OR LATAM) (jobs OR careers OR empleo)`,
    `(${quoteRoles(roles.slice(midpoint).length ? roles.slice(midpoint) : roles.slice(0, midpoint))}) (remote OR remoto OR Argentina OR LATAM) (jobs OR careers OR empleo)`,
  ];
  const searchResults = [];
  for (const q of queryGroups) {
    try {
      if (provider === 'OpenAI') {
        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
          body: JSON.stringify({
            model: 'gpt-4.1-mini', tools: [{ type: 'web_search', search_context_size: 'low' }], tool_choice: 'required',
            include: ['web_search_call.action.sources'], max_output_tokens: 40,
            input: `Buscá avisos de empleo publicados actualmente para estos puestos: ${q}. Priorizá páginas oficiales de empresas y enlaces directos de sus sistemas ATS. Ejecutá la búsqueda web y respondé únicamente OK.`,
          }), signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error(`OpenAI API HTTP ${response.status}`);
        const data = await response.json();
        searchResults.push(...extractWebSearchSources(data.output));
      } else {
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: '20', country: 'AR', search_lang: 'en' })}`, {
          headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey }, signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`Brave Search HTTP ${response.status}`);
        const data = await response.json();
        searchResults.push(...(data.web?.results || []));
      }
    } catch (error) {
      console.warn(`Búsqueda web: ${error.message || error}`);
      if (/HTTP 401|HTTP 403|HTTP 429/.test(String(error.message))) break;
    }
  }
  if (!searchResults.length) return [];

  // Search-result text is used only in memory for discovery. Persist only job data
  // retrieved from the employer's own page or a public ATS posting API.
  const jobs = [];
  const boards = new Map();
  for (const result of searchResults) {
    let url;
    try { url = new URL(result.url); } catch { continue; }
    const parts = url.pathname.split('/').filter(Boolean);
    const host = url.hostname.toLowerCase();
    if (host === 'jobs.ashbyhq.com' && parts[0]) boards.set(`ashby:${parts[0]}`, { kind: 'ashby', slug: parts[0] });
    else if (host === 'boards.greenhouse.io' && parts[0]) boards.set(`greenhouse:${parts[0]}`, { kind: 'greenhouse', slug: parts[0] });
    else if (host === 'jobs.lever.co' && parts[0]) boards.set(`lever:${parts[0]}`, { kind: 'lever', slug: parts[0] });
    else if (host.endsWith('.lever.co') && parts.length) boards.set(`lever:${host.split('.')[0]}`, { kind: 'lever', slug: host.split('.')[0] });
  }
  const boardResults = await Promise.allSettled([...boards.values()].slice(0, 12).map(fetchPublicBoard));
  for (const result of boardResults) if (result.status === 'fulfilled') jobs.push(...result.value);

  const likelyJobPages = searchResults.filter((result) => {
    try {
      const url = new URL(result.url);
      return !['jobs.ashbyhq.com', 'boards.greenhouse.io', 'jobs.lever.co'].includes(url.hostname) && /job|career|vacan|position|opening|apply/i.test(`${url.pathname} ${result.title || ''}`);
    } catch { return false; }
  }).slice(0, 12);
  const employerPages = await Promise.allSettled(likelyJobPages.map(fetchStructuredEmployerJob));
  for (const result of employerPages) if (result.status === 'fulfilled' && result.value) jobs.push(result.value);
  console.log(`Búsqueda web: ${searchResults.length} resultados transitorios · ${jobs.length} vacantes verificadas en páginas oficiales/ATS.`);
  return jobs;
}

function extractWebSearchSources(output) {
  const found = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && typeof value.url === 'string' && /^https?:\/\//i.test(value.url) && value.title) {
      found.push({ url: value.url, title: value.title, description: value.snippet || '' });
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(output);
  return [...new Map(found.map((source) => [source.url, source])).values()];
}

async function fetchPublicBoard(board) {
  let endpoint;
  if (board.kind === 'ashby') endpoint = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.slug)}`;
  if (board.kind === 'greenhouse') endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.slug)}/jobs?content=true`;
  if (board.kind === 'lever') endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(board.slug)}?mode=json`;
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${board.kind} ${board.slug}: HTTP ${response.status}`);
  const data = await response.json();
  if (board.kind === 'ashby') return (data.jobs || []).filter((job) => job.isListed !== false).map((job) => ({
    id: `ashby-${job.jobUrl || job.applyUrl}`, company: label(board.slug), role: job.title, url: job.applyUrl || job.jobUrl,
    location: job.location || (job.isRemote ? 'Remote' : ''), description: stripHtml(job.descriptionPlain || job.descriptionHtml || ''), source: 'Ashby', remote: job.isRemote === true,
  }));
  if (board.kind === 'greenhouse') return (data.jobs || []).map((job) => ({ id: `gh-${job.id}`, company: label(board.slug), role: job.title, url: job.absolute_url, location: job.location?.name || '', description: stripHtml(job.content || ''), source: 'Greenhouse' }));
  return (data || []).map((job) => ({ id: `lv-${job.id}`, company: label(board.slug), role: job.text, url: job.applyUrl || job.hostedUrl, location: job.categories?.location || '', description: job.descriptionPlain || stripHtml(job.description || ''), source: 'Lever' }));
}

async function fetchStructuredEmployerJob(result) {
  let url;
  try { url = new URL(result.url); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const response = await fetch(url, { headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 Postula job discovery' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) return null;
  const html = (await response.text()).slice(0, 2_000_000);
  const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of scripts) {
    try {
      const parsed = JSON.parse(raw.trim().replace(/^<!--|-->$/g, ''));
      const nodes = Array.isArray(parsed) ? parsed : parsed['@graph'] ? parsed['@graph'] : [parsed];
      const posting = nodes.find((node) => String(node['@type']).split(/[\s,]+/).includes('JobPosting'));
      if (!posting || !posting.title || (posting.validThrough && Date.parse(posting.validThrough) < Date.now())) continue;
      const company = typeof posting.hiringOrganization === 'object' ? posting.hiringOrganization.name : '';
      const location = posting.jobLocationType === 'TELECOMMUTE' ? 'Remote' : (posting.jobLocation?.address?.addressLocality || posting.jobLocation?.address?.addressRegion || '');
      return { id: `web-${new URL(result.url).hostname}-${encodeURIComponent(posting.identifier?.value || posting.title)}`, company: company || new URL(result.url).hostname.replace(/^www\./, ''), role: posting.title, url: posting.url || result.url, location, description: stripHtml(posting.description || ''), source: 'Web · página oficial', remote: posting.jobLocationType === 'TELECOMMUTE' };
    } catch { /* ignore malformed JSON-LD */ }
  }
  return null;
}

function offerFingerprint(job) {
  const normalize = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${normalize(job.company)}|${normalize(job.role)}`;
}

async function discoverRemotive() {
  const json = await cachedJson('remotive', 'https://remotive.com/api/remote-jobs', 6 * 60 * 60 * 1000);
  return (json.jobs || []).map((job) => ({ id: `remotive-${job.id}`, company: job.company_name || 'Empresa', role: job.title, url: job.url, applicationUrl: extractApplicationUrl(job.description || ''), location: job.candidate_required_location || 'Remoto', description: stripHtml(job.description || ''), source: 'Remotive', remote: true }));
}

async function discoverJobicy() {
  const json = await cachedJson('jobicy-v2', 'https://jobicy.com/api/jobs?count=100', 60 * 60 * 1000);
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
  const urls = [...categories.map((category) => [`wwr-${category}`, `https://weworkremotely.com/categories/${category}.rss`]), ['wwr-all', 'https://weworkremotely.com/remote-jobs.rss']];
  const lists = await Promise.all(urls.map(async ([key, url]) => {
    const xml = await cachedText(key, url, 60 * 60 * 1000);
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

async function discoverActiveVacancies(p) {
  const roles = [...new Set(String(p.roles || '').split(/[,;\n]+/).map((role) => role.trim()).filter(Boolean))].slice(0, 6);
  const lists = await Promise.all(roles.map(async (role) => {
    const url = `https://activevacancies.com/api/v1/jobs?${new URLSearchParams({ q: role, remote: 'remote', limit: '50', sort: 'recent' })}`;
    const json = await cachedJson(`activevacancies-${role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, url, 60 * 60 * 1000);
    return (json.data || []).map((job) => ({
      id: `activevacancies-${job.id}`, source: 'Active Vacancies', company: job.company?.name || 'Empresa', role: job.title,
      url: job.applyUrl || job.url, listingUrl: job.url, applicationUrl: job.applyUrl || null,
      location: job.location || '', workplaceType: job.remoteStatus || '', remote: job.remoteStatus === 'remote',
      description: '', postedAt: job.postedAt || '',
    }));
  }));
  return lists.flat();
}

async function discoverUxJobs() {
  const json = await cachedJson('uxjobs-remote', 'https://jobs.uxjobs.io/api/export/partner/remote.json', 12 * 60 * 60 * 1000);
  return (json.jobs || []).map((job) => ({
    id: `uxjobs-${job.id}`, source: 'UX Jobs', company: job.company || 'Empresa', role: job.title,
    url: job.url, location: [job.location, job.country_name].filter(Boolean).join(', '),
    workplaceType: job.workplace || '', remote: job.remote === true, description: '', postedAt: job.posted_at || '',
  }));
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
  const profileText = [p.roles, p.summary, p.experience, p.skills, p.resume].join(' ');
  const cacheKey = profileText;
  if (cachedProfileVectorKey !== cacheKey) {
    const list = terms(profileText), counts = new Map();
    for (const term of list) counts.set(term, (counts.get(term) || 0) + 1);
    cachedProfileVector = new Map([...counts].map(([term, count]) => [term, count / Math.max(list.length, 1)]));
    cachedProfileVectorKey = cacheKey;
  }
  const jobList = terms([job.role, job.description].join(' ')), jobCounts = new Map();
  for (const term of jobList) jobCounts.set(term, (jobCounts.get(term) || 0) + 1);
  const jobVector = new Map([...jobCounts].map(([term, count]) => [term, count / Math.max(jobList.length, 1)]));
  const inverseDocumentFrequency = (term) => Math.log(3 / (1 + Number(cachedProfileVector.has(term)) + Number(jobVector.has(term)))) + 1;
  let dot = 0, profileNorm = 0, jobNorm = 0;
  for (const [term, value] of cachedProfileVector) {
    const weighted = value * inverseDocumentFrequency(term);
    const jobWeight = (jobVector.get(term) || 0) * inverseDocumentFrequency(term);
    dot += weighted * jobWeight;
    profileNorm += weighted * weighted;
  }
  for (const [term, value] of jobVector) {
    const weighted = value * inverseDocumentFrequency(term);
    jobNorm += weighted * weighted;
  }
  const similarity = dot / Math.max(Math.sqrt(profileNorm * jobNorm), 0.0001);
  const normalizeTitle = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(senior|sr|junior|jr|staff|principal|lead|associate|mid-level|midlevel|ii|iii)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const roleTargets = String(p.roles || '').split(/[,;\n]+/).map(normalizeTitle).filter(Boolean);
  const title = normalizeTitle(job.role);
  const targetFamilies = roleTargets.map((target) => ({
    target,
    family: /product designer|product design|ux designer|ui designer|ux ui/.test(target) ? 'product-design'
      : /design engineer/.test(target) ? 'design-engineering'
        : /project manager|program manager/.test(target) ? 'project-management' : '',
  }));
  const jobFamily = /product designer|product design|ux designer|ui designer|ux ui/.test(title) ? 'product-design'
    : /design engineer/.test(title) ? 'design-engineering'
      : /project manager|program manager/.test(title) ? 'project-management' : '';
  const titleFit = targetFamilies.reduce((best, entry) => {
    const targetWords = roleTerms(entry.target);
    const overlap = targetWords.length ? targetWords.filter((word) => roleTerms(title).includes(word)).length / targetWords.length : 0;
    const familyFit = entry.family && entry.family === jobFamily
      ? (jobFamily === 'project-management' ? 0.9 : 0.78) : 0;
    const containsPhrase = entry.target && title.includes(entry.target) ? 1 : 0;
    return Math.max(best, overlap, familyFit, containsPhrase);
  }, 0);
  // Titles are a strong signal for this user's configured roles; sparse ATS feeds
  // often contain no description, so text similarity alone wrongly scored these 0.
  return Math.max(0, Math.min(98, Math.round(titleFit * 68 + similarity * 30)));
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
  const mode = String(p.mode || 'Remoto').toLowerCase();
  const workEvidence = `${job.location || ''} ${job.workplaceType || ''} ${job.type || ''} ${job.remoteStatus || ''}`;
  const remoteEvidence = `${workEvidence} ${(job.tags || []).join(' ')} ${job.description || ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const hybridEvidence = /\bhybrid\b|\bh[ií]brido\b|2\s*[-–]?\s*3 days? (?:in|at) (?:the )?office|part[- ]time in office/.test(remoteEvidence);
  const onsiteEvidence = /\bon[\s-]?site\b|\bin[\s-]?office\b|office[- ]based|presencial/.test(remoteEvidence);
  const remoteMode = mode.includes('remoto');
  const hybridMode = mode.includes('híbrido') || mode.includes('hibrido') || mode.includes('hybrid');
  const onsiteMode = mode.includes('presencial') || mode.includes('onsite') || mode.includes('on-site');
  const allModes = mode.includes('indistinto') || mode.includes('todos') || mode.includes('all');
  if (remoteMode && (hybridEvidence || onsiteEvidence)) return false;
  if (remoteMode && job.remote !== true && !/remote|remoto|anywhere|worldwide|distributed|work from home|telecommute/i.test(remoteEvidence)) return false;
  if (!locationFitsArgentina(job, p)) return false;
  if (p.regionPreference === 'regional-only' && regionPriority(job, p) > 1) return false;
  if (!allModes && hybridMode && !hybridEvidence) return false;
  if (!allModes && onsiteMode) {
    if (!onsiteEvidence) return false;
    const place = String(p.location || '').toLowerCase().split(/[,-]/).map((part) => part.trim()).filter(Boolean);
    if (place.length && !place.some((part) => text.includes(part))) return false;
  }
  return true;
}

function regionPriority(job, profile) {
  if (profile.regionPreference === 'balanced') return 0;
  const location = String(job.location || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const description = String(job.description || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const evidence = `${location} ${description}`;
  if (/\b(argentina|argentinian|buenos aires|la plata)\b/.test(location) || /\b(?:based in|located in|candidates in|applicants in|hiring in)\b[^.!?]{0,60}\b(?:argentina|buenos aires|la plata)\b/.test(description)) return 0;
  if (/\b(latam|latin america|south america|americas|mexico|brazil|chile|colombia|uruguay|peru|ecuador|paraguay|bolivia|costa rica|panama|guatemala|dominican republic)\b/.test(location) || /\b(?:based in|located in|candidates in|applicants in|hiring in)\b[^.!?]{0,80}\b(?:latam|latin america|south america|americas|mexico|brazil|chile|colombia|uruguay|peru|ecuador)\b/.test(description)) return 1;
  if (/\b(americas|worldwide|anywhere|global|international|all countries|remote)\b/.test(location) || job.remote === true || /\b(remote|remoto|worldwide|anywhere|global)\b/.test(evidence)) return 2;
  return 2;
}

function regionLabel(job, profile) {
  const priority = regionPriority(job, profile);
  return priority === 0 ? 'Argentina' : priority === 1 ? 'LATAM' : 'Remoto global';
}

function locationFitsArgentina(job, profile) {
  const target = String(profile.location || '').toLowerCase();
  if (!/argentina|buenos aires|la plata|latam|latin america|south america/i.test(target)) return true;
  let location = String(job.location || '');
  // An employer HQ is not necessarily where the remote employee must live.
  location = location.replace(/\([^)]*\b(?:hq|headquarters|office)\b[^)]*\)/gi, ' ');
  const normalizedLocation = location.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const globalOrArgentina = /\b(worldwide|anywhere|global|international|all countries|americas|latin america|latam|south america|argentina|buenos aires|la plata)\b/.test(normalizedLocation);
  const restrictedRegion = /\b(united kingdom|uk only|britain|england|scotland|wales|london|manchester|edinburgh|cambridge,? uk|europe|european union|eu only|emea|north america|united states|u\.?s\.?|usa|san francisco|new york|austin|seattle|boston|los angeles|chicago|denver|atlanta|washington dc|miami|toronto|vancouver|canada|india|apac|australia|new zealand|singapore|japan|china|germany|france|spain|netherlands|ireland|switzerland|poland|portugal|mexico only|brazil only)\b/.test(normalizedLocation);
  if (restrictedRegion && !globalOrArgentina) return false;

  const description = String(job.description || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const explicitCountryLimit = /\b(?:must be|need to be|needs to be|only open to|only available to|candidates must|applicants must|based|located|reside|resident|authorized to work)[^.!?\n]{0,90}\b(?:united kingdom|uk|britain|england|united states|u\.?s\.?|usa|canada|north america|europe|emea|india|australia)\b|\b(?:united kingdom|uk|united states|u\.?s\.?|usa|canada|europe|emea)\s+only\b/.test(description);
  return !explicitCountryLimit;
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
async function hasVerificationGate(page) {
  if (await hasBlocker(page)) return true;
  const recaptchaPresent = page.frames().some((frame) => /recaptcha|hcaptcha|arkoselabs/i.test(frame.url()));
  if (!recaptchaPresent) return false;
  const visibleControls = await page.locator('input:visible,textarea:visible,select:visible').count().catch(() => 0);
  return visibleControls === 0;
}
async function waitForHumanChallenge(page, job) {
  console.log(`\nEl portal solicita una verificación humana: ${job.company} · ${job.role}`);
  if (browserHeadless) {
    console.log('La verificación requiere intervención humana. El navegador permanece oculto y el aviso queda marcado para revisión desde Postula.');
    await setLiveStatus({ phase: 'Verificación manual requerida', currentJob: { company: job.company, role: job.role, match: job.match, stage: 'Abrí el aviso desde Actividad reciente para revisar la verificación' } });
    return;
  }
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
  const findForm = () => findFormOnPage(page);
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
  for (const frame of page.frames()) {
    const forms = frame.locator('form');
    const snapshots = await forms.evaluateAll((nodes) => nodes.map((form, index) => {
      const fields = [...form.querySelectorAll('input,textarea,select')];
      const labels = fields.map((el) => `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') || ''} ${[...(el.labels || [])].map((label) => label.innerText).join(' ')}`.toLowerCase());
      return { index, score: (labels.some((text) => /e-?mail/.test(text)) ? 1 : 0) + (labels.some((text) => /first name|full name|nombre/.test(text)) ? 2 : 0) + (fields.some((el) => el.type === 'file' && /resume|cv|curriculum|attachment|pdf/i.test(`${el.name} ${el.id} ${el.accept}`)) ? 2 : 0) + (/application|apply|candidatura/.test(form.innerText.toLowerCase()) ? 2 : 0), count: fields.length };
    })).catch(() => []);
    const best = snapshots.filter((form) => form.score >= 2 && form.count >= 2).sort((a, b) => b.score - a.score)[0];
    if (best) return forms.nth(best.index);

    const containers = frame.locator('main,[role="main"],#application,#application-form,#app_body,[data-testid*="application"]');
    const containerCount = await containers.count().catch(() => 0);
    for (let index = 0; index < containerCount; index += 1) {
      const container = containers.nth(index);
      const fields = await container.locator('input:not([type="hidden"]),textarea,select').count().catch(() => 0);
      const text = await container.innerText({ timeout: 1000 }).catch(() => '');
      if (fields >= 2 && /apply|application|candidate|candidatura/i.test(text)) return container;
    }

    let host = '';
    let pathname = '';
    try { host = new URL(frame.url()).hostname; pathname = new URL(frame.url()).pathname; } catch {}
    if (/jobs\.ashbyhq\.com$/i.test(host) && /\/application\/?$/i.test(pathname)) {
      const body = frame.locator('body');
      const fieldCount = await body.locator('input:not([type="hidden"]),textarea,select').count().catch(() => 0);
      const hasSubmit = await frame.getByRole('button', { name: /submit application/i }).count().catch(() => 0);
      if (fieldCount >= 3 && hasSubmit === 1) return body;
    }
  }
  return null;
}

function valueFor(label, p, job = {}) {
  const text = label.toLowerCase().replace(/[_-]+/g, ' ');
  if (/e-?mail/.test(text)) return p.email;
  if (/phone|mobile|tel[eé]fono|celular/.test(text)) return p.phone;
  if (/current company|current employer|present employer|most recent employer|empresa actual|empleador actual/.test(text)) return p.currentCompany || 'Not currently employed';
  if (/full name|your name|^name$|nombre completo/.test(text)) return p.name;
  if (/first name|given name|nombre\b/.test(text) && !/last|apellido/.test(text)) return p.name?.trim().split(/\s+/)[0];
  if (/last name|family name|surname|apellido/.test(text)) return p.name?.trim().split(/\s+/).slice(1).join(' ');
  if (/country|pa[ií]s/.test(text)) return p.location?.split(',').at(-1).trim();
  if (/linkedin/.test(text)) return p.linkedin || (/linkedin/i.test(p.link || '') ? p.link : '');
  if (/password|contrase(?:n|ñ)a/.test(text)) return '';
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

function configuredAnswerFor(question, profile = {}) {
  const normalizedQuestion = normalizeAnswer(question);
  const answers = profile.applicationAnswers?.fields;
  if (!normalizedQuestion || !answers || typeof answers !== 'object') return '';
  for (const [prompt, answer] of Object.entries(answers)) {
    const normalizedPrompt = normalizeAnswer(prompt);
    if (normalizedPrompt.length >= 3 && normalizedQuestion.includes(normalizedPrompt)) return String(answer || '').trim();
  }
  return '';
}

function needsManualAnswer(question = '') {
  return /consent|\bi agree\b|privacy|terms of|certif|declare|background|criminal|race|ethnicity|gender|disability|veteran|demographic|captcha|verification/i.test(question);
}

async function fillKnownFields(form, p, cvPath, job = {}) {
  const missing = [];
  const radioGroups = new Map();
  const checkboxGroups = new Map();
  const selectedRadios = new Set((p.applicationAnswers?.radio || []).map(normalizeAnswer));
  const selectedCheckboxes = new Set((p.applicationAnswers?.checkboxes || []).map(normalizeAnswer));
  const controls = form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select');
  let i = 0;
  let visited = 0;
  while (i < await controls.count() && visited < 120) {
    visited += 1;
    const field = controls.nth(i);
    if (!(await field.count().catch(() => 0))) { i += 1; continue; }
    const type = (await field.getAttribute('type', { timeout: 700 }).catch(() => '') || '').toLowerCase();
    const metadata = await field.evaluate((el) => {
      const text = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const labels = [...(el.labels || [])].map((item) => text(item.innerText)).filter(Boolean);
      const group = el.closest('.application-question,fieldset,[role="group"]');
      const groupText = text(group?.innerText || '');
      const explicit = [
        ...labels,
        text(el.getAttribute('aria-label')),
        text(el.getAttribute('placeholder')),
        text(el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ')),
        text(el.getAttribute('name')?.replace(/[_-]+/g, ' ')),
        text(el.id?.replace(/[_-]+/g, ' ')),
      ].filter(Boolean);
      return {
        label: [...new Set([...labels, ...explicit.slice(labels.length)])].join(' '),
        question: groupText || labels.join(' '),
        required: Boolean(el.required || el.getAttribute('aria-required') === 'true'
          || group?.getAttribute('aria-required') === 'true'
          || /(?:\*|✱)/.test(groupText)
          || labels.some((item) => /(?:\*|✱)\s*$/.test(item))
          || (!labels.length && /(?:\*|✱)\s*$/.test(text(el.getAttribute('aria-label'))))),
      };
    }).catch(() => ({ label: '', question: '', required: false }));
    const fieldContext = metadata.label;
    const required = metadata.required;
    if (type === 'file') {
      const hint = `${await field.getAttribute('name', { timeout: 1200 }).catch(() => '') || ''} ${await field.getAttribute('id', { timeout: 1200 }).catch(() => '') || ''} ${await field.getAttribute('aria-label', { timeout: 1200 }).catch(() => '') || ''} ${await field.getAttribute('accept', { timeout: 1200 }).catch(() => '') || ''}`.toLowerCase();
      if (/resume|cv|curriculum|attachment|pdf/.test(hint)) {
        const uploaded = await field.setInputFiles(cvPath, { timeout: 5000 }).then(() => true).catch(() => false);
        if (uploaded) await new Promise((resolve) => setTimeout(resolve, 450));
        if (required && !uploaded) missing.push(hint || 'CV adjunto');
      } else if (required) missing.push(hint || 'archivo obligatorio');
      i += 1;
      continue;
    }
    if (!await field.isVisible().catch(() => false)) { i += 1; continue; }
    if (['checkbox', 'radio'].includes(type)) {
      const metadata = await field.evaluate((el) => ({
        option: el.labels ? [...el.labels].map((item) => item.innerText).join(' ').trim() : el.getAttribute('aria-label') || el.value || 'confirmación legal',
        question: el.closest('.application-question,fieldset,[role="group"]')?.innerText?.trim() || [...(el.labels || [])].map((label) => label.innerText).join(' ') || el.name || '',
        group: el.closest('.application-question,fieldset,[role="group"]')?.id || el.closest('.application-question,fieldset,[role="group"]')?.getAttribute('data-qa') || el.name || '',
      }));
      const option = metadata.option;
      const groupName = metadata.group || `${type}-${i}`;
      const groups = type === 'radio' ? radioGroups : checkboxGroups;
      if (!groups.has(groupName)) groups.set(groupName, { label: metadata.question || option, required });
      const automaticRadio = type === 'radio' && autoRadioOption(metadata.question, option, p, job);
      const manualOnly = needsManualAnswer(metadata.question);
      const configured = !manualOnly && normalizeAnswer(configuredAnswerFor(metadata.question, p)) === normalizeAnswer(option);
      if (!manualOnly && ((type === 'radio' ? selectedRadios : selectedCheckboxes).has(normalizeAnswer(option)) || automaticRadio || configured)) {
        await field.check({ timeout: 1500 }).catch(() => {});
      }
      i += 1;
      continue;
    }
    const label = `${metadata.question} ${fieldContext}`.replace(/\s+/g, ' ').trim();
    const mapped = valueFor(label, p, job) || (needsManualAnswer(label) ? '' : configuredAnswerFor(label, p));
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
    if (required && !current) missing.push((label.trim() || `campo ${i + 1}`).slice(0, 180));
    i += 1;
  }
  const invalidRequired = await form.locator(':invalid:visible').evaluateAll((nodes) => nodes.map((el) => {
    const labels = [...(el.labels || [])].map((label) => label.innerText).filter(Boolean);
    return labels[0] || el.getAttribute('aria-label') || el.name || el.id || 'campo obligatorio';
  })).catch(() => []);
  missing.push(...invalidRequired);
  for (const [groupName, group] of radioGroups) {
    const isSelected = await form.locator('input[type="radio"]:checked').evaluateAll((nodes, name) => nodes.some((node) => node.name === name), groupName).catch(() => false);
    if (group.required && !isSelected) missing.push(group.label);
  }
  for (const [groupName, group] of checkboxGroups) {
    const isSelected = await form.locator('input[type="checkbox"]:checked').evaluateAll((nodes, name) => nodes.some((node) => node.name === name), groupName).catch(() => false);
    if (group.required && !isSelected) missing.push(group.label);
  }
  return { missing: [...new Set(missing)].slice(0, 12) };
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
