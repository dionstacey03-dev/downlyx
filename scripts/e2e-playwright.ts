import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import { initializeApp as initializeClientApp, deleteApp as deleteClientApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth as getClientAuth,
  sendEmailVerification,
} from 'firebase/auth';
import { chromium } from 'playwright';
import { createMediaRouter } from '../server/routes/media.ts';
import { clearLocalRevocationWatermarksForTest } from '../server/security/firebaseAdmin.ts';
import { MediaWorkerManager } from '../server/worker/mediaWorkerManager.ts';
import { executeWorkerJob } from '../server/worker/workerProcess.ts';
import {
  clearAuthEmulatorAccounts,
  ensureAuthEmulator,
  loadFirebaseAppletConfig,
  verifyLatestEmailOob,
} from '../tests/helpers/authEmulator.ts';

const ARTIFACT_DIR = path.resolve(
  '/.aistudio/artifacts/brain/d7ccf814-05b9-4dfc-973c-43138707d897'
);
const CHROMIUM_EXEC_PATH =
  '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell';

function generateSampleMp4(dir: string): Buffer {
  const out = path.join(dir, 'sample.mp4');
  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=0.6:size=320x240:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      out,
    ],
    { shell: false, encoding: 'utf8' }
  );
  if (res.status !== 0) throw new Error(res.stderr);
  return fs.readFileSync(out);
}

function generateSampleMp3(dir: string): Buffer {
  const out = path.join(dir, 'sample.mp3');
  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=523:duration=0.6',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      out,
    ],
    { shell: false, encoding: 'utf8' }
  );
  if (res.status !== 0) throw new Error(res.stderr);
  return fs.readFileSync(out);
}

function makeMockStream(params: {
  statusCode?: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  delayMs?: number;
}): http.IncomingMessage {
  const s = new Readable({ read() {} }) as unknown as http.IncomingMessage;
  s.statusCode = params.statusCode ?? 200;
  s.headers = params.headers;
  let i = 0;
  const pushNext = () => {
    if (s.destroyed) return;
    if (i >= params.chunks.length) {
      s.push(null);
      return;
    }
    s.push(params.chunks[i++]);
    if (params.delayMs) {
      setTimeout(pushNext, params.delayMs);
    } else {
      setImmediate(pushNext);
    }
  };
  if (params.delayMs) setTimeout(pushNext, params.delayMs);
  else setImmediate(pushNext);
  return s;
}

async function run() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'downlyx-e2e-'));
  const workDir = path.join(tempRoot, 'worker-tmp');
  const sampleMp4 = generateSampleMp4(tempRoot);
  const sampleMp3 = generateSampleMp3(tempRoot);

  const distDir = path.resolve(process.cwd(), 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error('dist/index.html missing — run npm run build first.');
  }

  const fbConfig = loadFirebaseAppletConfig();
  const emulator = await ensureAuthEmulator(fbConfig.projectId);
  process.env.FIREBASE_AUTH_EMULATOR_HOST = emulator.hostPort;
  process.env.FIREBASE_PROJECT_ID = fbConfig.projectId;
  clearLocalRevocationWatermarksForTest();
  await clearAuthEmulatorAccounts(emulator.url, fbConfig.projectId);

  const manager = new MediaWorkerManager({
    tempDir: workDir,
    disableAutoSweeper: true,
    retryDelayMs: 60,
    customExecutor: async (input, onEvent, signal) => {
      await executeWorkerJob(input, onEvent, signal, {
        lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
        customStreamOpener: async ({ url }) => {
          if (url.pathname.includes('slow-cancel')) {
            return makeMockStream({
              headers: {
                'content-type': 'video/mp4',
                'content-length': String(sampleMp4.length),
              },
              chunks: [sampleMp4.subarray(0, 512), sampleMp4.subarray(512)],
              delayMs: 1800,
            });
          }
          if (url.pathname.includes('bad-html')) {
            const html = Buffer.from('<!DOCTYPE html><html><body>Fake</body></html>');
            return makeMockStream({
              headers: {
                'content-type': 'text/html',
                'content-length': String(html.length),
              },
              chunks: [html],
            });
          }
          if (url.pathname.endsWith('.mp3')) {
            return makeMockStream({
              headers: {
                'content-type': 'audio/mpeg',
                'content-length': String(sampleMp3.length),
              },
              chunks: [sampleMp3],
            });
          }
          const quarter = Math.ceil(sampleMp4.length / 4);
          return makeMockStream({
            headers: {
              'content-type': 'video/mp4',
              'content-length': String(sampleMp4.length),
            },
            chunks: [
              sampleMp4.subarray(0, quarter),
              sampleMp4.subarray(quarter, quarter * 2),
              sampleMp4.subarray(quarter * 2, quarter * 3),
              sampleMp4.subarray(quarter * 3),
            ],
            delayMs: 160,
          });
        },
      });
    },
  });

  const app = express();
  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use(
    '/api',
    createMediaRouter({
      skipNetworkMetadata: true,
      workerManager: manager,
      rateLimitMax: 250,
      downloadRateLimitMax: 250,
    })
  );
  app.use(express.static(distDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROMIUM_EXEC_PATH)
      ? CHROMIUM_EXEC_PATH
      : undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    // Seed a secondary verified user (Bob) via Auth Emulator for cross-user & mobile/tablet tests
    const seedApp = initializeClientApp(fbConfig, 'e2e-seed-bob');
    const seedAuth = getClientAuth(seedApp);
    connectAuthEmulator(seedAuth, emulator.url, { disableWarnings: true });
    const bobEmail = 'bob.e2e@example.com';
    const bobPassword = 'BobPassword123!';
    const bobCred = await createUserWithEmailAndPassword(seedAuth, bobEmail, bobPassword);
    await sendEmailVerification(bobCred.user);
    await verifyLatestEmailOob(emulator.url, bobEmail, fbConfig.projectId);
    await bobCred.user.reload();
    const bobIdToken = await bobCred.user.getIdToken(true);
    await deleteClientApp(seedApp);

    // 1. DESKTOP (1440x900)
    const desktopCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    await desktopCtx.addInitScript((emuUrl: string) => {
      (window as Window & { __DOWNLYX_AUTH_EMULATOR_URL__?: string }).__DOWNLYX_AUTH_EMULATOR_URL__ = emuUrl;
    }, emulator.url);

    const page = await desktopCtx.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1:has-text("Sign in to access your verified media downloads")');
    const authOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(authOverflow, false, 'Desktop 1440px AuthScreen must have zero horizontal overflow');
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'e2e_p4_auth_desktop.png'),
      fullPage: true,
    });

    // Test Password Reset UI mode with existing account
    await page.click('button:has-text("Forgot password?")');
    await page.waitForSelector('h2:has-text("Reset Password")');
    await page.fill('#auth-email', bobEmail);
    await page.click('button[type="submit"]:has-text("Send Password Reset Link")');
    await page.waitForSelector('[role="status"]');
    await page.click('button:has-text("Back to Sign In")');

    // Switch to Create Account tab & verify validation + password toggle
    await page.click('button[role="tab"]:has-text("Create Account")');
    await page.fill('#auth-display-name', 'Alex Morgan');
    await page.fill('#auth-email', 'alex.e2e@example.com');
    await page.fill('#auth-password', 'short');
    await page.click('button[type="submit"]:has-text("Create Verified Account")');
    await page.waitForSelector('[role="alert"]');
    assert.match((await page.textContent('[role="alert"]')) ?? '', /at least 8 characters/i);

    await page.fill('#auth-password', 'AlexPassword123!');
    await page.click('button[aria-label="Show password"]');
    assert.equal(await page.getAttribute('#auth-password', 'type'), 'text');
    await page.click('button[aria-label="Hide password"]');
    assert.equal(await page.getAttribute('#auth-password', 'type'), 'password');

    await page.click('button[type="submit"]:has-text("Create Verified Account")');
    await page.waitForSelector('text=/Email verification required/i', { timeout: 10_000 });

    // Verify email via Auth Emulator OOB code and click "I've Verified"
    await verifyLatestEmailOob(emulator.url, 'alex.e2e@example.com', fbConfig.projectId);
    await page.click(`button:has-text("I've Verified")`);
    await page.waitForFunction(
      () => !document.body.innerText.includes('Email verification required'),
      { timeout: 10_000 }
    );

    const desktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(desktopOverflow, false, 'Desktop 1440px Home must have zero horizontal overflow');

    // Error state check: blocked localhost URL
    await page.fill('#downlyx-url-input', 'https://127.0.0.1/internal.mp4');
    await page.click('button[type="submit"]');
    await page.waitForSelector('[role="alert"]');
    assert.match((await page.textContent('[role="alert"]')) ?? '', /blocked|localhost/i);

    // URL Analysis: YouTube should NOT show a Download button
    await page.fill('#downlyx-url-input', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.click('button[type="submit"]');
    await page.waitForSelector('text=HTTPS Validated');
    const ytDownloadBtns = await page.locator('button:has-text("Download Verified")').count();
    assert.equal(ytDownloadBtns, 0, 'YouTube must never display a Download button');

    // Direct Media Download + Auto-Detected Container + Progress + Verified Save File
    await page.fill('#downlyx-url-input', 'https://cdn.example.com/assets/demo-video.mp4');
    await page.click('button[type="submit"]');
    await page.waitForSelector('button:has-text("Download Verified MP4")');
    assert.equal(
      (await page.textContent('[data-testid="detected-container-value"]'))?.trim(),
      'MP4',
      'Detected container must read MP4 for .mp4 URL'
    );
    assert.equal(
      await page.getAttribute('button[data-format-variant="MP4"]', 'aria-pressed'),
      'true',
      'Detected source container MP4 must be automatically selected'
    );

    const dlBtn = page.locator('button:has-text("Download Verified MP4")');
    assert.equal(await dlBtn.isDisabled(), true, 'Download button must require permission checkbox');
    await page.locator('input[type="checkbox"]').first().check();
    assert.equal(await dlBtn.isDisabled(), false);

    const createJobResponsePromise = page.waitForResponse(
      (res) => res.url().endsWith('/api/downloads') && res.request().method() === 'POST'
    );
    await dlBtn.click();
    const createJobRes = await createJobResponsePromise;
    assert.equal(createJobRes.status(), 202);
    const createdPayload = (await createJobRes.json()) as { job: { id: string } };
    const completedJobId = createdPayload.job.id;

    await page.waitForSelector('[role="progressbar"]');
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'e2e_desktop_1440_progress.png'),
      fullPage: true,
    });

    await page.waitForSelector('button:has-text("Save Verified File (MP4)")', {
      timeout: 10_000,
    });
    const metadataText = await page.textContent('main');
    assert.match(metadataText ?? '', /320x240/);
    assert.match(metadataText ?? '', /video\/mp4/);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'e2e_desktop_1440_completed.png'),
      fullPage: true,
    });

    const [browserDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text("Save Verified File (MP4)")'),
    ]);
    assert.match(browserDownload.suggestedFilename(), /^downlyx-.*\.mp4$/);
    assert.equal(page.url().includes('token='), false, 'Page URL must never contain download tokens');

    // Cancellation flow test
    await page.fill('#downlyx-url-input', 'https://cdn.example.com/assets/slow-cancel.mp4');
    await page.click('button[type="submit"]');
    await page.waitForSelector('button:has-text("Download Verified MP4")');
    await page.locator('input[type="checkbox"]').first().check();
    await page.click('button:has-text("Download Verified MP4")');
    await page.waitForSelector('button:has-text("Cancel")');
    await page.click('button:has-text("Cancel")');
    await page.waitForSelector('text=Cancelled');

    // Failed MIME / HTML payload error state test
    await page.fill('#downlyx-url-input', 'https://cdn.example.com/assets/bad-html.mp4');
    await page.click('button[type="submit"]');
    await page.waitForSelector('button:has-text("Download Verified MP4")');
    await page.locator('input[type="checkbox"]').first().check();
    await page.click('button:has-text("Download Verified MP4")');
    await page.waitForSelector('text=Failed');

    // Downloads History page check & Search Bar filtering by platform name and media type
    await page.click('button:has-text("Downloads (")');
    await page.waitForSelector('h1:has-text("Downloads & Queue History")');
    await page.waitForSelector('#downloads-search-input');

    // Verify top Downloads summary card metrics (3 total, >0 KB completed, 1 failed)
    await page.waitForSelector('[aria-label="Downloads summary"]');
    assert.equal(
      await page.textContent('[data-testid="summary-total-downloads"]'),
      '3',
      'Summary card must display total count of downloads'
    );
    const initialCompletedSize =
      (await page.textContent('[data-testid="summary-completed-size"]'))?.trim() ?? '';
    assert.match(
      initialCompletedSize,
      /KB$/,
      `Expected completed size in KB, got "${initialCompletedSize}"`
    );
    assert.equal(
      await page.textContent('[data-testid="summary-failed-count"]'),
      '1',
      'Summary card must display failed attempts count'
    );

    // Verify Ctrl+K focuses #downloads-search-input cleanly
    assert.notEqual(
      await page.evaluate(() => document.activeElement?.id),
      'downloads-search-input'
    );
    await page.keyboard.press('Control+k');
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'downloads-search-input',
      'Ctrl+K must focus the Downloads search input'
    );

    // Clear button must be hidden when search input is empty
    assert.equal(
      await page.locator('button[aria-label="Clear search query"]').count(),
      0,
      'Clear search button must be hidden when search query is empty'
    );

    // Filter by platform name ("Direct Media URL") & verify <mark> highlighting + clear button visibility
    await page.fill('#downloads-search-input', 'Direct Media');
    await page.waitForSelector('button[aria-label="Clear search query"]');
    await page.waitForSelector('text=/Showing 3 of 3/i');
    await page.waitForSelector('table mark:has-text("Direct Media")');
    // Verify persistence across navigation to Settings and back to Downloads
    await page.click('aside button:has-text("Settings")');
    await page.waitForSelector('h1:has-text("Settings")');
    await page.click('aside button:has-text("Downloads")');
    await page.waitForSelector('#downloads-search-input');
    assert.equal(
      await page.inputValue('#downloads-search-input'),
      'Direct Media',
      'Search query must persist across page navigation'
    );
    await page.waitForSelector('table mark:has-text("Direct Media")');
    // Filter by media type ("Video") & verify <mark> highlighting
    await page.fill('#downloads-search-input', 'Video');
    await page.waitForSelector('text=/Showing 3 of 3/i');
    await page.waitForSelector('table mark:has-text("Video")');
    // Non-matching media type ("Audio") should show empty filtered state, then clear removes query, hides X button, and refocuses input
    await page.fill('#downloads-search-input', 'Audio');
    await page.waitForSelector('text=No matching queue entries found');
    await page.click('button[aria-label="Clear search query"]');
    assert.equal(
      await page.inputValue('#downloads-search-input'),
      '',
      'Clicking clear search button must reset search query'
    );
    assert.equal(
      await page.locator('button[aria-label="Clear search query"]').count(),
      0,
      'Clear search button must hide once query is cleared'
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'downloads-search-input',
      'Clearing search via X button must keep focus in the search input'
    );
    await page.waitForSelector('table tbody tr');
    assert.equal(await page.locator('table mark').count(), 0);

    // Sort dropdown checks: Date Added (desc default), File Size, Platform Name
    await page.waitForSelector('#downloads-sort-select');
    assert.equal(await page.inputValue('#downloads-sort-select'), 'date');
    assert.match(
      (await page.locator('table tbody tr').nth(0).textContent()) ?? '',
      /Failed/,
      'Default Date Added (desc) sort must show newest item (Failed) first'
    );

    // Sort by File Size (desc default -> Completed 21.9 KB moves to first row)
    await page.selectOption('#downloads-sort-select', 'size');
    assert.match(
      (await page.locator('table tbody tr').nth(0).textContent()) ?? '',
      /Completed/,
      'File Size (desc) sort must put the largest completed file first'
    );

    // Toggle sort direction to ascending -> Completed 21.9 KB moves to last row
    await page.click('#downloads-sort-direction');
    assert.match(
      (await page.locator('table tbody tr').nth(2).textContent()) ?? '',
      /Completed/,
      'File Size (asc) sort must put the largest completed file last'
    );

    // Verify Platform Name option exists & selects cleanly, then restore Date Added (desc)
    await page.selectOption('#downloads-sort-select', 'platform');
    assert.equal(await page.inputValue('#downloads-sort-select'), 'platform');
    await page.selectOption('#downloads-sort-select', 'date');
    assert.equal(await page.inputValue('#downloads-sort-select'), 'date');

    // Batch selection & deletion checks on Desktop (3 rows: Failed, Cancelled, Completed)
    const selectAllDesktop = page.locator(
      'table thead input[type="checkbox"][aria-label*="visible items"]'
    );
    const rowCheckboxes = page.locator('table tbody tr td:first-child input[type="checkbox"]');
    assert.equal(await rowCheckboxes.count(), 3);

    // Selecting 1 item shows toolbar and sets indeterminate state on Select All
    await rowCheckboxes.nth(0).check();
    await page.waitForSelector('[aria-label="Batch selection actions"] >> text=1 selected');
    assert.equal(
      await selectAllDesktop.evaluate((el) => (el as HTMLInputElement).indeterminate),
      true,
      'Header Select All checkbox must enter indeterminate state on partial selection'
    );

    // Header Select All checks all 3 visible items
    await selectAllDesktop.click();
    await page.waitForSelector('[aria-label="Batch selection actions"] >> text=3 selected');
    assert.equal(
      await selectAllDesktop.evaluate((el) => (el as HTMLInputElement).checked),
      true
    );

    // Capture screenshot showing active batch selection toolbar + checked rows cleanly
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'e2e_desktop_1440_history.png'),
      fullPage: true,
    });

    // Clear selection resets checkboxes and hides toolbar
    await page.click('[aria-label="Batch selection actions"] button:has-text("Clear selection")');
    assert.equal(
      await page.locator('[aria-label="Batch selection actions"]').count(),
      0
    );

    // Select the first 2 rows (Failed + Cancelled) and batch delete, keeping Completed row intact
    await rowCheckboxes.nth(0).check();
    await rowCheckboxes.nth(1).check();
    await page.click('button:has-text("Delete Selected (2)")');
    await page.click('button:has-text("Confirm Delete (2)")');
    await page.waitForSelector('text=(1 total)');
    assert.equal(await rowCheckboxes.count(), 1);
    assert.equal(
      await page.locator('[aria-label="Batch selection actions"]').count(),
      0
    );

    // Summary card updates immediately after deleting Failed + Cancelled items
    assert.equal(
      await page.textContent('[data-testid="summary-total-downloads"]'),
      '1'
    );
    assert.equal(
      (await page.textContent('[data-testid="summary-completed-size"]'))?.trim(),
      initialCompletedSize
    );
    assert.equal(
      await page.textContent('[data-testid="summary-failed-count"]'),
      '0'
    );

    const historyTableClipped = await page.evaluate(() => {
      const wrap = document.querySelector('table')?.parentElement;
      return wrap ? wrap.scrollWidth > wrap.clientWidth : false;
    });
    assert.equal(
      historyTableClipped,
      false,
      'Desktop 1440px Downloads History table must not clip or scroll horizontally'
    );

    // Settings & Account Management check
    await page.click('aside button:has-text("Settings")');
    await page.waitForSelector('h1:has-text("Settings")');
    assert.match((await page.textContent('main')) ?? '', /alex\.e2e@example\.com/);
    await page.fill('#account-display-name', 'Alex Updated');
    await page.click('button:has-text("Update")');
    await page.waitForSelector('text=Profile updated.');

    await page.selectOption('#pref-quality', 'standard');
    await page.check('#pref-auto-retry');
    await page.click('button[type="submit"]:has-text("Save Preferences")');
    await page.waitForSelector('text=Preferences synced to account');
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, 'e2e_p4_settings_desktop.png'),
      fullPage: true,
    });

    // Theme & Auto-Retry persistence across reload
    await page.click('button[aria-label="Switch to light theme"]');
    assert.equal(
      await page.evaluate(() => !document.documentElement.classList.contains('dark')),
      true
    );
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('aside button:has-text("Settings")');
    assert.equal(
      await page.evaluate(() => !document.documentElement.classList.contains('dark')),
      true,
      'Theme preference must persist across reload'
    );
    await page.click('aside button:has-text("Settings")');
    await page.waitForSelector('#pref-auto-retry');
    assert.equal(
      await page.isChecked('#pref-auto-retry'),
      true,
      'Auto-Retry preference must persist across reload'
    );
    await page.click('button[aria-label="Switch to dark theme"]');

    // Trigger failing download with Auto-Retry enabled -> retries 3 times -> Permanently Failed
    await page.click('aside button:has-text("Home Dashboard")');
    await page.fill('#downlyx-url-input', 'https://cdn.example.com/assets/bad-html-retry.mp4');
    await page.click('button[type="submit"]');
    await page.waitForSelector('button:has-text("Download Verified MP4")');
    await page.locator('input[type="checkbox"]').first().check();
    await page.click('button:has-text("Download Verified MP4")');
    await page.waitForSelector('text=Permanently Failed', { timeout: 10_000 });
    await page.click('aside button:has-text("Downloads")');
    await page.waitForSelector('table >> text=Permanently Failed');
    assert.equal(
      await page.textContent('[data-testid="summary-failed-count"]'),
      '1',
      'Permanently Failed job must count toward Failed Attempts in summary card'
    );

    // Auto-identify non-default container (.mp3 -> MP3) and switch format variant (M4A) before download
    await page.click('aside button:has-text("Home Dashboard")');
    await page.fill('#downlyx-url-input', 'https://cdn.example.com/assets/podcast-sample.mp3');
    await page.click('button[type="submit"]');
    await page.waitForSelector('button[data-format-variant="MP3"]');
    assert.equal(
      (await page.textContent('[data-testid="detected-container-value"]'))?.trim(),
      'MP3',
      'Detected container must automatically identify MP3 from .mp3 URL'
    );
    assert.equal(
      await page.getAttribute('button[data-format-variant="MP3"]', 'aria-pressed'),
      'true',
      'MP3 format must be auto-selected over default MP4 preference'
    );
    await page.click('button[data-format-variant="M4A"]');
    assert.equal(
      await page.getAttribute('button[data-format-variant="M4A"]', 'aria-pressed'),
      'true',
      'Selecting M4A variant must update active format selection'
    );
    await page.waitForSelector('button:has-text("Download Verified M4A")');
    await page.locator('input[type="checkbox"]').first().check();
    await page.click('button:has-text("Download Verified M4A")');
    await page.waitForSelector('button:has-text("Save Verified File (M4A)")', {
      timeout: 10_000,
    });

    // Cross-user access rejection check: Bob cannot access Alex's completed job
    const crossUserRes = await fetch(`${baseUrl}/api/downloads/${completedJobId}`, {
      headers: { Authorization: `Bearer ${bobIdToken}` },
    });
    assert.equal(
      crossUserRes.status,
      403,
      'Cross-user access to another Firebase user download job must return 403'
    );

    // Session expiration / revocation handling in UI: return 401 -> signs out & returns to AuthScreen
    await page.click('aside button:has-text("Home Dashboard")');
    await page.route('**/api/downloads', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Firebase ID token has been revoked.',
            code: 'auth/id-token-revoked',
          }),
        });
      } else {
        await route.continue();
      }
    });
    await page.fill('#downlyx-url-input', 'https://cdn.example.com/assets/expired-check.mp4');
    await page.click('button[type="submit"]');
    await page.waitForSelector('button:has-text("Download Verified MP4")');
    await page.locator('input[type="checkbox"]').first().check();
    await page.click('button:has-text("Download Verified MP4")');
    await page.waitForSelector('text=/session expired or was revoked/i', {
      timeout: 8000,
    });
    await page.unroute('**/api/downloads');

    // Sign back in via Login tab and test confirmed Account Deletion
    await page.fill('#auth-email', 'alex.e2e@example.com');
    await page.fill('#auth-password', 'AlexPassword123!');
    await page.click('button[type="submit"]:has-text("Sign In")');
    await page.waitForSelector('aside button:has-text("Settings")', { timeout: 10_000 });
    await page.click('aside button:has-text("Settings")');
    await page.click('button:has-text("Delete Account")');
    await page.fill('#delete-confirm-phrase', 'DELETE');
    await page.fill('#delete-confirm-password', 'AlexPassword123!');
    await page.click('button[type="submit"]:has-text("Permanently Delete Account")');
    await page.waitForSelector('text=/permanently deleted/i', { timeout: 10_000 });

    await desktopCtx.close();

    // 2. TABLET (768x1024) — Sign in as Bob and verify layout & zero overflow
    const tabletCtx = await browser.newContext({
      viewport: { width: 768, height: 1024 },
    });
    await tabletCtx.addInitScript((emuUrl: string) => {
      (window as Window & { __DOWNLYX_AUTH_EMULATOR_URL__?: string }).__DOWNLYX_AUTH_EMULATOR_URL__ = emuUrl;
    }, emulator.url);
    const tabletPage = await tabletCtx.newPage();
    tabletPage.on('pageerror', (err) => pageErrors.push(err.message));
    await tabletPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await tabletPage.fill('#auth-email', bobEmail);
    await tabletPage.fill('#auth-password', bobPassword);
    await tabletPage.click('button[type="submit"]:has-text("Sign In")');
    await tabletPage.waitForSelector('#downlyx-url-input', { timeout: 10_000 });
    await tabletPage.fill('#downlyx-url-input', 'https://cdn.example.com/assets/tablet.mp4');
    await tabletPage.click('button[type="submit"]');
    await tabletPage.waitForSelector('button:has-text("Download Verified MP4")');
    const tabletOverflow = await tabletPage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(tabletOverflow, false, 'Tablet 768px should have zero horizontal overflow');
    await tabletPage.screenshot({
      path: path.join(ARTIFACT_DIR, 'e2e_tablet_768.png'),
      fullPage: true,
    });
    await tabletCtx.close();

    // 3. MOBILE (375x812) — Check AuthScreen mobile, sign in as Bob, check drawer & Platforms
    const mobileCtx = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    await mobileCtx.addInitScript((emuUrl: string) => {
      (window as Window & { __DOWNLYX_AUTH_EMULATOR_URL__?: string }).__DOWNLYX_AUTH_EMULATOR_URL__ = emuUrl;
    }, emulator.url);
    const mobilePage = await mobileCtx.newPage();
    mobilePage.on('pageerror', (err) => pageErrors.push(err.message));
    await mobilePage.goto(baseUrl, { waitUntil: 'networkidle' });
    const mobileAuthOverflow = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(mobileAuthOverflow, false, 'Mobile 375px AuthScreen must have zero horizontal overflow');

    await mobilePage.fill('#auth-email', bobEmail);
    await mobilePage.fill('#auth-password', bobPassword);
    await mobilePage.click('button[type="submit"]:has-text("Sign In")');
    await mobilePage.waitForSelector('#downlyx-url-input', { timeout: 10_000 });

    const mobileOverflowHome = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(mobileOverflowHome, false, 'Mobile 375px Home must have zero horizontal overflow');

    await mobilePage.click('button[aria-label="Open navigation menu"]');
    await mobilePage.waitForSelector('[role="dialog"] button:has-text("Supported Platforms")');
    await mobilePage.screenshot({
      path: path.join(ARTIFACT_DIR, 'e2e_mobile_375_nav.png'),
      fullPage: true,
    });
    await mobilePage.click('[role="dialog"] button:has-text("Supported Platforms")');
    await mobilePage.waitForSelector('h1:has-text("Supported Platforms")');
    const mobileOverflowPlatforms = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(
      mobileOverflowPlatforms,
      false,
      'Mobile 375px Platforms page must have zero horizontal overflow'
    );
    await mobilePage.screenshot({
      path: path.join(ARTIFACT_DIR, 'e2e_mobile_375_platforms.png'),
      fullPage: true,
    });
    await mobileCtx.close();

    assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
    const realConsoleErrors = consoleErrors.filter(
      (e) => !e.includes('401') && !e.includes('Failed to load resource')
    );
    assert.equal(
      realConsoleErrors.length,
      0,
      `Unexpected console errors: ${realConsoleErrors.join('; ')}`
    );

    console.log(
      JSON.stringify({
        ok: true,
        viewportsChecked: ['1440x900', '768x1024', '375x812'],
        screenshots: [
          'e2e_p4_auth_desktop.png',
          'e2e_desktop_1440_progress.png',
          'e2e_desktop_1440_completed.png',
          'e2e_desktop_1440_history.png',
          'e2e_p4_settings_desktop.png',
          'e2e_tablet_768.png',
          'e2e_mobile_375_nav.png',
          'e2e_mobile_375_platforms.png',
        ],
        consoleErrorsFiltered: realConsoleErrors.length,
        pageErrors: pageErrors.length,
      })
    );
  } finally {
    await browser.close();
    await manager.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    await emulator.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('E2E Browser Test Failed:', err);
  process.exit(1);
});
