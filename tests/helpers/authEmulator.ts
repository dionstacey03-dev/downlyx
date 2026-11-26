import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface EmulatorHandle {
  url: string;
  hostPort: string;
  stop: () => Promise<void>;
}

const DEFAULT_PROJECT_ID = 'alien-truck-flvvl';

async function isEmulatorReachable(baseUrl: string, projectId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${baseUrl}/emulator/v1/projects/${projectId}/oobCodes`
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureAuthEmulator(
  projectId = DEFAULT_PROJECT_ID
): Promise<EmulatorHandle> {
  const hostPort = '127.0.0.1:9099';
  const url = `http://${hostPort}`;

  if (await isEmulatorReachable(url, projectId)) {
    return {
      url,
      hostPort,
      stop: async () => {},
    };
  }

  let proc: ChildProcess | null = null;
  let logs = '';

  proc = spawn(
    'firebase',
    ['emulators:start', '--only', 'auth', '--project', projectId],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }
  );

  proc.stdout?.on('data', (d) => {
    logs += d.toString();
  });
  proc.stderr?.on('data', (d) => {
    logs += d.toString();
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `Firebase Auth Emulator exited prematurely (${proc.exitCode}):\n${logs}`
      );
    }
    if (await isEmulatorReachable(url, projectId)) {
      return {
        url,
        hostPort,
        stop: async () => {
          if (!proc || proc.exitCode !== null) return;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              try {
                proc?.kill('SIGKILL');
              } catch {
                // ignore
              }
              resolve();
            }, 3000);
            proc?.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            try {
              proc?.kill('SIGTERM');
            } catch {
              clearTimeout(timer);
              resolve();
            }
          });
        },
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
  throw new Error(`Timed out waiting for Firebase Auth Emulator:\n${logs}`);
}

export async function clearAuthEmulatorAccounts(
  emulatorUrl: string,
  projectId = DEFAULT_PROJECT_ID
): Promise<void> {
  const res = await fetch(
    `${emulatorUrl}/emulator/v1/projects/${projectId}/accounts`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Auth Emulator accounts: ${res.status}`);
  }
}

export async function verifyLatestEmailOob(
  emulatorUrl: string,
  email: string,
  projectId = DEFAULT_PROJECT_ID
): Promise<void> {
  const deadline = Date.now() + 6000;
  let latestOobLink: string | undefined;

  while (Date.now() < deadline) {
    const listRes = await fetch(
      `${emulatorUrl}/emulator/v1/projects/${projectId}/oobCodes`
    );
    if (!listRes.ok) {
      throw new Error(`Failed to query Auth Emulator oobCodes: ${listRes.status}`);
    }
    const data = (await listRes.json()) as {
      oobCodes?: Array<{
        email?: string;
        requestType?: string;
        oobLink?: string;
        oobCode?: string;
      }>;
    };
    const matches = (data.oobCodes ?? []).filter(
      (c) =>
        c.email?.toLowerCase() === email.toLowerCase() &&
        c.requestType === 'VERIFY_EMAIL'
    );
    const latest = matches[matches.length - 1];
    if (latest?.oobLink) {
      latestOobLink = latest.oobLink;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!latestOobLink) {
    throw new Error(`No VERIFY_EMAIL oobCode found in emulator for ${email}`);
  }
  const applyRes = await fetch(latestOobLink);
  if (!applyRes.ok) {
    throw new Error(`Failed to apply verification OOB link: ${applyRes.status}`);
  }
}

export function loadFirebaseAppletConfig(): {
  projectId: string;
  apiKey: string;
  appId: string;
  authDomain: string;
} {
  const raw = fs.readFileSync(
    path.resolve(process.cwd(), 'firebase-applet-config.json'),
    'utf8'
  );
  const config = JSON.parse(raw) as ReturnType<typeof loadFirebaseAppletConfig>;
  // Firebase client SDK requires a non-empty API key even when requests are
  // routed to the Auth Emulator. Never use a production key for emulator tests.
  config.apiKey = process.env.FIREBASE_TEST_API_KEY || config.apiKey || 'fake-api-key';
  return config;
}
