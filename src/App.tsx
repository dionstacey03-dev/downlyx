import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EmailAuthProvider,
  deleteUser,
  onIdTokenChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  Menu,
  Sun,
  Moon,
  Plus,
  Download,
  AlertTriangle,
  Loader2,
  MailCheck,
} from 'lucide-react';
import type {
  DownloadJob,
  HistoryItem,
  NavPage,
  ThemeMode,
  UserPreferences,
} from './types/media.ts';
import {
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  normalizeQualityPreference,
} from './utils/platformDetector.ts';
import { auth, googleProvider } from './firebase.ts';
import {
  clearAllUserDownloads,
  deleteAllUserFirestoreData,
  deleteUserDownloadRecord,
  deleteUserDownloadRecordsBatch,
  ensureUserProfile,
  logUserActivity,
  sanitizePreferences,
  saveUserDownloadRecord,
  subscribeUserDownloads,
  subscribeUserProfile,
  updateUserProfileRecord,
} from './services/userFirestore.ts';
import { AuthScreen } from './components/AuthScreen.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Tooltip } from './components/Tooltip.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { DownloadsPage } from './pages/DownloadsPage.tsx';
import { PlatformsPage } from './pages/PlatformsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { HelpPage } from './pages/HelpPage.tsx';

const PAGE_LABELS: Record<NavPage, string> = {
  home: 'Home Dashboard',
  downloads: 'Downloads',
  platforms: 'Supported Platforms',
  settings: 'Settings',
  help: 'Help & About',
};

function isActiveJobStatus(status: DownloadJob['status']): boolean {
  return status === 'queued' || status === 'processing' || status === 'verifying';
}

function readInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Ignore storage unavailability
  }
  return 'dark';
}

function readInitialPrefs(): UserPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.preferences);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserPreferences>;
      return {
        ...DEFAULT_PREFERENCES,
        ...parsed,
        defaultQuality: normalizeQualityPreference(parsed.defaultQuality),
      };
    }
  } catch {
    // Ignore invalid JSON
  }
  return DEFAULT_PREFERENCES;
}

function mergeJobIntoHistory(
  prev: HistoryItem[],
  job: DownloadJob,
  qualityPref?: string
): HistoryItem[] {
  const existingIdx = prev.findIndex(
    (item) => item.jobId === job.id || item.id === job.id
  );
  const nextItem: HistoryItem = {
    id: existingIdx >= 0 ? prev[existingIdx].id : job.id,
    jobId: job.id,
    url: job.url,
    platform: job.platform,
    platformName: job.platformName,
    mediaType: job.mediaType,
    fileType: job.verifiedMetadata?.container || job.targetFormat,
    qualityPreference:
      existingIdx >= 0
        ? prev[existingIdx].qualityPreference
        : qualityPref || 'Original Verified',
    status: job.status,
    resourceId: job.url.split('/').pop() || null,
    createdAt: existingIdx >= 0 ? prev[existingIdx].createdAt : job.createdAt,
    note: job.error || job.stageMessage,
    sizeBytes: job.verifiedMetadata?.sizeBytes,
    retryCount: job.retryCount,
    maxRetries: job.maxRetries,
    downloadUrl: job.downloadUrl,
    expiresAt: job.expiresAt,
  };

  if (existingIdx >= 0) {
    const copy = [...prev];
    copy[existingIdx] = nextItem;
    return copy;
  }
  return [nextItem, ...prev].slice(0, 100);
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const [activePage, setActivePage] = useState<NavPage>('home');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const [preferences, setPreferences] = useState<UserPreferences>(readInitialPrefs);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [downloadJobs, setDownloadJobs] = useState<DownloadJob[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const syncedTerminalJobsRef = useRef<Set<string>>(new Set());

  // Sync theme class on <html> and persist in browser storage
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem(STORAGE_KEYS.theme, theme);
    } catch {
      // Ignore storage unavailability
    }
  }, [theme]);

  // Synchronize theme & preferences across browser tabs
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.theme) {
        if (event.newValue === 'light' || event.newValue === 'dark') {
          setTheme(event.newValue);
        }
      } else if (event.key === STORAGE_KEYS.preferences && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue) as Partial<UserPreferences>;
          setPreferences({
            ...DEFAULT_PREFERENCES,
            ...parsed,
            defaultQuality: normalizeQualityPreference(parsed.defaultQuality),
          });
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Firebase Auth lifecycle listener
  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, (user) => {
      setFirebaseUser(user);
      setEmailVerified(Boolean(user?.emailVerified));
      setAuthReady(true);

      if (!user) {
        setHistory([]);
        setDownloadJobs([]);
        syncedTerminalJobsRef.current.clear();
        setSessionNotice(null);
        setActivePage('home');
        try {
          localStorage.removeItem(STORAGE_KEYS.downloadsSearch);
        } catch {
          // ignore
        }
      } else {
        setAuthNotice(null);
      }
    });
    return () => unsubscribe();
  }, []);

  const getFreshIdToken = useCallback(
    async (forceRefresh = false): Promise<string | null> => {
      const user = auth.currentUser;
      if (!user) return null;
      try {
        return await user.getIdToken(forceRefresh);
      } catch {
        setAuthNotice('Your session expired or was revoked. Please sign in again.');
        await signOut(auth).catch(() => {});
        return null;
      }
    },
    []
  );

  const handleUnauthorizedResponse = useCallback(async () => {
    setSessionNotice('Your authentication session expired or was revoked. Please sign in again.');
    setAuthNotice('Your authentication session expired or was revoked. Please sign in again.');
    await signOut(auth).catch(() => {});
  }, []);

  // Hydrate Firestore profile, download history, and backend UID-scoped active jobs
  useEffect(() => {
    if (!authReady || !firebaseUser || !emailVerified) {
      return;
    }

    let active = true;
    setIsHistoryLoading(true);
    let unsubProfile: (() => void) | undefined;
    let unsubDownloads: (() => void) | undefined;

    const initUserWorkspace = async () => {
      try {
        await ensureUserProfile(firebaseUser, preferences);

        if (!active) return;

        unsubProfile = subscribeUserProfile(
          firebaseUser.uid,
          (profile) => {
            if (!active || !profile) return;
            setPreferences(profile.preferences);
          },
          () => {
            // Firestore listener permission or offline fallback
          }
        );

        unsubDownloads = subscribeUserDownloads(
          firebaseUser.uid,
          (fsItems) => {
            if (!active) return;
            setHistory((prev) => {
              // Merge active runtime jobs with persisted Firestore items
              const byId = new Map<string, HistoryItem>();
              for (const item of fsItems) byId.set(item.id, item);
              for (const existing of prev) {
                if (existing.jobId && !byId.has(existing.jobId)) {
                  const matchingLive = downloadJobs.find(
                    (j) => j.id === existing.jobId
                  );
                  if (matchingLive && isActiveJobStatus(matchingLive.status)) {
                    byId.set(existing.id, existing);
                  }
                }
              }
              return Array.from(byId.values()).sort((a, b) =>
                b.createdAt.localeCompare(a.createdAt)
              );
            });
            setIsHistoryLoading(false);
          },
          () => {
            if (active) setIsHistoryLoading(false);
          }
        );

        const token = await getFreshIdToken();
        if (active && token) {
          const [jobsRes, histRes, prefRes] = await Promise.all([
            fetch('/api/downloads', {
              headers: { Authorization: `Bearer ${token}` },
            }),
            fetch('/api/history', {
              headers: { Authorization: `Bearer ${token}` },
            }),
            fetch('/api/preferences', {
              headers: { Authorization: `Bearer ${token}` },
            }),
          ]);

          if (jobsRes.status === 401) {
            await handleUnauthorizedResponse();
            return;
          }
          if (active && jobsRes.ok) {
            const jobsData = (await jobsRes.json()) as { jobs?: DownloadJob[] };
            if (Array.isArray(jobsData.jobs)) {
              setDownloadJobs(jobsData.jobs);
            }
          }
          if (active && histRes.ok) {
            const histData = (await histRes.json()) as { items?: HistoryItem[] };
            if (Array.isArray(histData.items) && histData.items.length > 0) {
              setHistory((prev) => {
                const seen = new Set(prev.map((i) => i.id));
                const merged = [...prev];
                for (const item of histData.items!) {
                  if (!seen.has(item.id)) merged.push(item);
                }
                return merged;
              });
            }
          }
          if (active && prefRes.ok) {
            const prefData = (await prefRes.json()) as {
              preferences?: UserPreferences;
            };
            if (prefData.preferences) {
              setPreferences(sanitizePreferences(prefData.preferences));
            }
          }
        }
      } catch {
        // Fallback safely if Firestore rules or offline checks fail transiently
      } finally {
        if (active) setIsHistoryLoading(false);
      }
    };

    void initUserWorkspace();

    return () => {
      active = false;
      unsubProfile?.();
      unsubDownloads?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, firebaseUser?.uid, emailVerified]);

  // Persist history locally when enabled
  useEffect(() => {
    if (!firebaseUser) return;
    try {
      const key = `${STORAGE_KEYS.history}_${firebaseUser.uid}`;
      if (preferences.saveHistoryLocally) {
        localStorage.setItem(key, JSON.stringify(history));
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage unavailability
    }
  }, [history, preferences.saveHistoryLocally, firebaseUser]);

  // Poll active download jobs cleanly while any job is queued/processing/verifying
  const hasActiveJobs = downloadJobs.some((job) => isActiveJobStatus(job.status));

  useEffect(() => {
    if (!hasActiveJobs || !firebaseUser) return;
    let cancelled = false;

    const pollOnce = async () => {
      const token = await getFreshIdToken();
      if (!token || cancelled) return;
      try {
        const res = await fetch('/api/downloads', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          const refreshed = await getFreshIdToken(true);
          if (!refreshed) {
            await handleUnauthorizedResponse();
            return;
          }
          const retry = await fetch('/api/downloads', {
            headers: { Authorization: `Bearer ${refreshed}` },
          });
          if (retry.status === 401) {
            await handleUnauthorizedResponse();
            return;
          }
          if (!retry.ok || cancelled) return;
          const retryData = (await retry.json()) as { jobs?: DownloadJob[] };
          if (Array.isArray(retryData.jobs)) {
            setDownloadJobs(retryData.jobs);
          }
          return;
        }
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { jobs?: DownloadJob[] };
        if (!Array.isArray(data.jobs) || cancelled) return;

        setDownloadJobs(data.jobs);
        setHistory((prev) => {
          let next = prev;
          for (const job of data.jobs!) {
            if (next.some((h) => h.jobId === job.id || h.id === job.id)) {
              next = mergeJobIntoHistory(next, job);
            }
          }
          return next;
        });

        // Persist terminal download state & activity entry to Firestore once per job
        for (const job of data.jobs) {
          if (
            !isActiveJobStatus(job.status) &&
            !syncedTerminalJobsRef.current.has(`${job.id}:${job.status}`)
          ) {
            syncedTerminalJobsRef.current.add(`${job.id}:${job.status}`);
            const item: HistoryItem = {
              id: job.id,
              jobId: job.id,
              url: job.url,
              platform: job.platform,
              platformName: job.platformName,
              mediaType: job.mediaType,
              fileType: job.verifiedMetadata?.container || job.targetFormat,
              qualityPreference: 'Original Verified',
              status: job.status,
              resourceId: job.url.split('/').pop() || null,
              createdAt: job.createdAt,
              note: job.error || job.stageMessage,
              sizeBytes: job.verifiedMetadata?.sizeBytes,
              retryCount: job.retryCount,
              maxRetries: job.maxRetries,
            };
            void saveUserDownloadRecord(firebaseUser, item).catch(() => {});
            const act =
              job.status === 'completed'
                ? 'download_completed'
                : job.status === 'cancelled'
                ? 'download_cancelled'
                : 'download_failed';
            void logUserActivity(firebaseUser, act, {
              platform: job.platform,
              format: item.fileType,
              fileSize: item.sizeBytes ?? 0,
            }).catch(() => {});
          }
        }
      } catch {
        // Ignore transient network poll error
      }
    };

    const timer = setInterval(() => {
      void pollOnce();
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasActiveJobs, firebaseUser, getFreshIdToken, handleUnauthorizedResponse]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const handleCloseMobile = useCallback(() => {
    setMobileMenuOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  const handleSignOut = useCallback(async () => {
    const token = await getFreshIdToken();
    if (token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    if (auth.currentUser?.emailVerified) {
      await logUserActivity(auth.currentUser, 'auth_logout').catch(() => {});
    }
    await signOut(auth);
  }, [getFreshIdToken]);

  const handleResendVerification = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) return { ok: false, message: 'No active user session.' };
    try {
      await sendEmailVerification(user);
      setVerificationNotice('Verification email sent. Check your inbox and click Check Status.');
      return { ok: true, message: 'Verification email sent.' };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : 'Unable to send verification email right now.',
      };
    }
  }, []);

  const handleRefreshVerification = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) return false;
    await user.reload();
    await user.getIdToken(true);
    const verified = Boolean(auth.currentUser?.emailVerified);
    setEmailVerified(verified);
    if (verified) {
      setVerificationNotice(null);
    } else {
      setVerificationNotice('Email is still unverified. Click the link in your inbox, then retry.');
    }
    return verified;
  }, []);

  const handleStartDownload = useCallback(
    async (params: {
      url: string;
      targetFormat: string;
      userConfirmedPermission: boolean;
      qualityPreference: string;
    }): Promise<
      { ok: true; job: DownloadJob } | { ok: false; error: string }
    > => {
      setSessionNotice(null);
      if (!firebaseUser || !firebaseUser.emailVerified) {
        return {
          ok: false,
          error: 'Verify your email address before starting authorized downloads.',
        };
      }

      let token = await getFreshIdToken();
      if (!token) {
        return { ok: false, error: 'Authentication session is unavailable.' };
      }

      const submitWithToken = (bearer: string) =>
        fetch('/api/downloads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({
            url: params.url,
            targetFormat: params.targetFormat,
            userConfirmedPermission: params.userConfirmedPermission,
            autoRetry: preferences.autoRetry,
          }),
        });

      try {
        let res = await submitWithToken(token);
        if (res.status === 401) {
          token = await getFreshIdToken(true);
          if (!token) {
            return { ok: false, error: 'Session expired. Please sign in again.' };
          }
          res = await submitWithToken(token);
          if (res.status === 401) {
            await handleUnauthorizedResponse();
            return { ok: false, error: 'Session expired or revoked.' };
          }
        }

        const data = (await res.json()) as { job?: DownloadJob; error?: string };
        if (!res.ok || !data.job) {
          return {
            ok: false,
            error: data.error || 'Download request was rejected.',
          };
        }

        const createdJob = data.job;
        setDownloadJobs((prev) => [
          createdJob,
          ...prev.filter((j) => j.id !== createdJob.id),
        ]);
        const newHist = mergeJobIntoHistory(
          history,
          createdJob,
          params.qualityPreference
        );
        setHistory(newHist);

        const createdItem = newHist.find((i) => i.jobId === createdJob.id);
        if (createdItem) {
          void saveUserDownloadRecord(firebaseUser, createdItem).catch(() => {});
          void logUserActivity(firebaseUser, 'download_started', {
            platform: createdJob.platform,
            format: createdJob.targetFormat,
          }).catch(() => {});
        }
        return { ok: true, job: createdJob };
      } catch {
        return {
          ok: false,
          error: 'Network error while submitting download job.',
        };
      }
    },
    [firebaseUser, getFreshIdToken, handleUnauthorizedResponse, history, preferences.autoRetry]
  );

  const handleCancelDownload = useCallback(
    async (jobId: string) => {
      const token = await getFreshIdToken();
      if (!token) return;

      try {
        const res = await fetch(
          `/api/downloads/${encodeURIComponent(jobId)}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (res.status === 401) {
          await handleUnauthorizedResponse();
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { job?: DownloadJob };
        if (data.job) {
          setDownloadJobs((prev) =>
            prev.map((j) => (j.id === data.job!.id ? data.job! : j))
          );
          setHistory((prev) => mergeJobIntoHistory(prev, data.job!));
        }
      } catch {
        // Ignore network failure on cancel
      }
    },
    [getFreshIdToken, handleUnauthorizedResponse]
  );

  const handleDownloadFile = useCallback(
    async (
      jobId: string,
      fallbackContainer = 'bin'
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const idToken = await getFreshIdToken();
      if (!idToken) {
        return {
          ok: false,
          error: 'Authentication session expired. Please sign in again.',
        };
      }

      try {
        let downloadToken = downloadJobs.find((j) => j.id === jobId)?.downloadToken;
        if (!downloadToken) {
          const ticketRes = await fetch(
            `/api/downloads/${encodeURIComponent(jobId)}/token`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}` },
            }
          );
          if (ticketRes.status === 401) {
            await handleUnauthorizedResponse();
            return { ok: false, error: 'Authentication session expired.' };
          }
          if (!ticketRes.ok) {
            const errData = (await ticketRes.json().catch(() => ({}))) as {
              error?: string;
            };
            return {
              ok: false,
              error:
                errData.error ||
                'Temporary download file has expired or is unavailable.',
            };
          }
          const ticketData = (await ticketRes.json()) as { downloadToken: string };
          downloadToken = ticketData.downloadToken;
        }

        const fileRes = await fetch(
          `/api/downloads/${encodeURIComponent(jobId)}/file`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${idToken}`,
              'X-Download-Token': downloadToken,
            },
          }
        );

        setDownloadJobs((prev) =>
          prev.map((j) => (j.id === jobId ? { ...j, downloadToken: undefined } : j))
        );

        if (fileRes.status === 401) {
          await handleUnauthorizedResponse();
          return { ok: false, error: 'Authentication session expired.' };
        }

        if (!fileRes.ok) {
          const errData = (await fileRes.json().catch(() => ({}))) as {
            error?: string;
          };
          return {
            ok: false,
            error: errData.error || 'Failed to retrieve verified media file.',
          };
        }

        const disposition = fileRes.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/);
        const filename =
          match?.[1] ||
          `downlyx-${jobId.slice(0, 8)}.${fallbackContainer.toLowerCase()}`;

        const blob = await fileRes.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

        return { ok: true };
      } catch {
        return { ok: false, error: 'Network error while streaming verified file.' };
      }
    },
    [downloadJobs, getFreshIdToken, handleUnauthorizedResponse]
  );

  const handleSaveToHistory = useCallback(
    async (
      url: string,
      fileType: string,
      qualityPreference: string
    ): Promise<HistoryItem | null> => {
      if (!firebaseUser || !firebaseUser.emailVerified) return null;
      const token = await getFreshIdToken();
      if (!token) return null;

      try {
        const response = await fetch('/api/history', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ url, fileType, qualityPreference }),
        });
        if (response.status === 401) {
          await handleUnauthorizedResponse();
          return null;
        }
        if (!response.ok) return null;
        const data = (await response.json()) as { item: HistoryItem };
        setHistory((prev) => [data.item, ...prev].slice(0, 100));
        void saveUserDownloadRecord(firebaseUser, data.item).catch(() => {});
        void logUserActivity(firebaseUser, 'url_analyzed', {
          platform: data.item.platform,
          status: data.item.status,
        }).catch(() => {});
        return data.item;
      } catch {
        return null;
      }
    },
    [firebaseUser, getFreshIdToken, handleUnauthorizedResponse]
  );

  const handleRemoveHistoryItem = useCallback(
    async (id: string) => {
      const target = history.find((item) => item.id === id);
      setHistory((prev) => prev.filter((item) => item.id !== id));

      const token = await getFreshIdToken();
      if (token) {
        if (target?.jobId) {
          await fetch(`/api/downloads/${encodeURIComponent(target.jobId)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {});
        }
        await fetch(`/api/history/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }

      if (target?.jobId) {
        setDownloadJobs((prev) => prev.filter((j) => j.id !== target.jobId));
      }
      if (firebaseUser?.emailVerified) {
        void deleteUserDownloadRecord(firebaseUser.uid, id).catch(() => {});
      }
    },
    [history, firebaseUser, getFreshIdToken]
  );

  const handleRemoveHistoryItems = useCallback(
    async (ids: string[]) => {
      const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
      if (uniqueIds.length === 0) return;

      const idSet = new Set(uniqueIds);
      const targets = history.filter((item) => idSet.has(item.id));
      const jobIdSet = new Set(
        targets
          .map((item) => item.jobId)
          .filter((jobId): jobId is string => Boolean(jobId))
      );

      setHistory((prev) => prev.filter((item) => !idSet.has(item.id)));
      if (jobIdSet.size > 0) {
        setDownloadJobs((prev) => prev.filter((j) => !jobIdSet.has(j.id)));
      }

      const token = await getFreshIdToken();
      if (token) {
        await fetch('/api/history/batch-delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ ids: uniqueIds }),
        }).catch(() => {});

        if (jobIdSet.size > 0) {
          await Promise.allSettled(
            Array.from(jobIdSet).map((jid) =>
              fetch(`/api/downloads/${encodeURIComponent(jid)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
              })
            )
          );
        }
      }

      if (firebaseUser?.emailVerified) {
        void deleteUserDownloadRecordsBatch(firebaseUser.uid, uniqueIds).catch(
          () => {}
        );
      }
    },
    [history, firebaseUser, getFreshIdToken]
  );

  const handleClearAllHistory = useCallback(async () => {
    const jobIds = history
      .map((item) => item.jobId)
      .filter((id): id is string => Boolean(id));
    setHistory([]);

    const token = await getFreshIdToken();
    if (token) {
      if (jobIds.length > 0) {
        await Promise.allSettled(
          jobIds.map((jid) =>
            fetch(`/api/downloads/${encodeURIComponent(jid)}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            })
          )
        );
      }
      await fetch('/api/history', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }

    if (firebaseUser?.emailVerified) {
      void clearAllUserDownloads(firebaseUser.uid).catch(() => {});
      void logUserActivity(firebaseUser, 'history_cleared').catch(() => {});
    }
  }, [history, firebaseUser, getFreshIdToken]);

  const handleSavePreferences = useCallback(
    async (nextPrefs: UserPreferences): Promise<boolean> => {
      const sanitized = sanitizePreferences(nextPrefs);
      setPreferences(sanitized);
      try {
        localStorage.setItem(STORAGE_KEYS.preferences, JSON.stringify(sanitized));
      } catch {
        // ignore
      }

      const token = await getFreshIdToken();
      if (token) {
        await fetch('/api/preferences', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(sanitized),
        }).catch(() => {});
      }

      if (firebaseUser?.emailVerified) {
        try {
          await updateUserProfileRecord({
            user: firebaseUser,
            preferences: sanitized,
          });
          void logUserActivity(firebaseUser, 'preferences_updated').catch(() => {});
        } catch {
          return false;
        }
      }
      return true;
    },
    [firebaseUser, getFreshIdToken]
  );

  const handleUpdateDisplayName = useCallback(
    async (name: string): Promise<{ ok: boolean; error?: string }> => {
      const user = auth.currentUser;
      if (!user) return { ok: false, error: 'No active user session.' };
      try {
        await updateProfile(user, { displayName: name.slice(0, 80) });
        if (user.emailVerified) {
          await updateUserProfileRecord({
            user,
            displayName: name,
          }).catch(() => {});
        }
        setFirebaseUser(auth.currentUser);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error ? err.message : 'Unable to update display name.',
        };
      }
    },
    []
  );

  const handleDeleteAccount = useCallback(
    async (password?: string): Promise<{ ok: boolean; error?: string }> => {
      const user = auth.currentUser;
      if (!user) return { ok: false, error: 'No active user session.' };

      try {
        if (password && user.email) {
          const credential = EmailAuthProvider.credential(user.email, password);
          await reauthenticateWithCredential(user, credential);
        }

        const token = await getFreshIdToken();
        if (token) {
          await fetch('/api/account', {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
        }

        if (user.emailVerified) {
          await deleteAllUserFirestoreData(user.uid).catch(() => {});
        }

        try {
          await deleteUser(user);
        } catch (err) {
          const code =
            typeof err === 'object' && err !== null && 'code' in err
              ? String((err as { code?: unknown }).code)
              : '';
          if (code === 'auth/requires-recent-login' && !password) {
            await reauthenticateWithPopup(user, googleProvider);
            await deleteUser(user);
          } else {
            throw err;
          }
        }

        setAuthNotice('Your account and associated workspace data have been permanently deleted.');
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Account deletion failed. Please re-authenticate and try again.',
        };
      }
    },
    [getFreshIdToken]
  );

  const handleInspectUrl = useCallback((url: string) => {
    setUrlInput(url);
    setActivePage('home');
  }, []);

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#080B14] text-slate-600 dark:text-slate-300">
        <div className="flex items-center gap-3 text-sm font-medium">
          <Loader2 className="h-5 w-5 animate-spin text-[#8B5CF6]" aria-hidden="true" />
          <span>Verifying session...</span>
        </div>
      </div>
    );
  }

  if (!firebaseUser) {
    return (
      <AuthScreen
        theme={theme}
        onToggleTheme={toggleTheme}
        sessionNotice={authNotice}
        onDismissNotice={() => setAuthNotice(null)}
      />
    );
  }

  return (
    <div className="min-h-screen flex overflow-x-hidden bg-slate-50 text-slate-900 dark:bg-[#080B14] dark:text-slate-100 transition-colors duration-200">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-xl focus:bg-[#8B5CF6] focus:px-4 focus:py-2 focus:text-xs focus:font-semibold focus:text-white"
      >
        Skip to main content
      </a>

      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
        theme={theme}
        onToggleTheme={toggleTheme}
        user={{
          displayName:
            firebaseUser.displayName ||
            firebaseUser.email?.split('@')[0] ||
            'DOWNLYX User',
          email: firebaseUser.email || '',
          photoURL: firebaseUser.photoURL || '',
          emailVerified,
        }}
        onSignOut={() => void handleSignOut()}
        historyCount={history.length}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={handleCloseMobile}
      />

      <div className="flex flex-1 flex-col min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white/85 px-4 sm:px-8 backdrop-blur-md dark:border-white/[0.08] dark:bg-[#080B14]/85">
          <div className="flex items-center gap-3 min-w-0">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
              className="lg:hidden flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-[#111827] dark:text-slate-200 dark:hover:bg-white/[0.06] shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="font-display font-semibold text-slate-900 dark:text-white whitespace-nowrap">
                DOWNLYX
              </span>
              <span aria-hidden="true" className="text-slate-400 dark:text-slate-600">
                /
              </span>
              <span className="truncate font-medium text-slate-600 dark:text-slate-300">
                {PAGE_LABELS[activePage]}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <Tooltip
              placement="bottom"
              content={
                theme === 'dark'
                  ? 'Switch to Crisp Light theme'
                  : 'Switch to Midnight Dark theme'
              }
            >
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={
                  theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
                }
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-[#111827] dark:text-slate-200 dark:hover:bg-white/[0.06] transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
              >
                {theme === 'dark' ? (
                  <Sun className="h-4 w-4 text-amber-400" />
                ) : (
                  <Moon className="h-4 w-4 text-slate-700" />
                )}
              </button>
            </Tooltip>

            {activePage === 'home' ? (
              <Tooltip placement="bottom" content="View downloads & queue history">
                <button
                  type="button"
                  onClick={() => setActivePage('downloads')}
                  className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-800 hover:bg-slate-100 dark:border-white/10 dark:bg-[#111827] dark:text-slate-100 dark:hover:bg-white/[0.08] whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8B5CF6]"
                >
                  <Download className="h-3.5 w-3.5 text-[#22D3EE]" aria-hidden="true" />
                  <span>Downloads ({history.length})</span>
                </button>
              </Tooltip>
            ) : (
              <Tooltip placement="bottom" content="Return to URL Analyzer">
                <button
                  type="button"
                  onClick={() => setActivePage('home')}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#8B5CF6] px-4 text-xs font-semibold text-white hover:bg-[#7C3AED] whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Analyze URL</span>
                </button>
              </Tooltip>
            )}
          </div>
        </header>

        {!emailVerified && (
          <div
            role="alert"
            className="border-b border-amber-200 bg-amber-50/90 px-4 py-3 text-xs text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <div className="mx-auto max-w-6xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <MailCheck className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" aria-hidden="true" />
                <div>
                  <span className="font-semibold">
                    Email verification required ({firebaseUser.email}).
                  </span>{' '}
                  <span>
                    {verificationNotice ||
                      'Verify your email to unlock isolated downloads and Firestore history sync.'}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleResendVerification()}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 whitespace-nowrap"
                >
                  Resend Verification
                </button>
                <button
                  type="button"
                  onClick={() => void handleRefreshVerification()}
                  className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-[#080B14] dark:text-amber-200 whitespace-nowrap"
                >
                  I&apos;ve Verified
                </button>
              </div>
            </div>
          </div>
        )}

        {sessionNotice && (
          <div
            role="alert"
            className="border-b border-amber-200 bg-amber-50/90 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <div className="mx-auto max-w-6xl flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                <span>{sessionNotice}</span>
              </div>
              <button
                type="button"
                onClick={() => setSessionNotice(null)}
                className="font-semibold underline underline-offset-2 whitespace-nowrap"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <main id="main-content" className="flex-1 px-4 py-8 sm:px-8 sm:py-10 min-w-0">
          {activePage === 'home' && (
            <HomePage
              urlInput={urlInput}
              onChangeUrlInput={setUrlInput}
              preferences={preferences}
              recentHistory={history}
              downloadJobs={downloadJobs}
              onStartDownload={handleStartDownload}
              onCancelDownload={handleCancelDownload}
              onDownloadFile={handleDownloadFile}
              onSaveToHistory={handleSaveToHistory}
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'downloads' && (
            <DownloadsPage
              history={history}
              downloadJobs={downloadJobs}
              isLoading={isHistoryLoading}
              onCancelDownload={handleCancelDownload}
              onDownloadFile={handleDownloadFile}
              onRemoveItem={handleRemoveHistoryItem}
              onRemoveItems={handleRemoveHistoryItems}
              onClearAll={handleClearAllHistory}
              onInspectUrl={handleInspectUrl}
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'platforms' && (
            <PlatformsPage onTestExampleUrl={handleInspectUrl} />
          )}

          {activePage === 'settings' && (
            <SettingsPage
              theme={theme}
              onSetTheme={setTheme}
              preferences={preferences}
              onSavePreferences={handleSavePreferences}
              firebaseUser={firebaseUser}
              onUpdateDisplayName={handleUpdateDisplayName}
              onResendVerification={handleResendVerification}
              onRefreshVerification={handleRefreshVerification}
              onSignOut={handleSignOut}
              onDeleteAccount={handleDeleteAccount}
            />
          )}

          {activePage === 'help' && <HelpPage onNavigate={setActivePage} />}
        </main>

        <footer className="border-t border-slate-200 dark:border-white/[0.08] px-4 sm:px-8 py-5">
          <div className="mx-auto max-w-6xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span>DOWNLYX · Multi-Platform Media Workspace</span>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setActivePage('platforms')}
                className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors whitespace-nowrap"
              >
                Supported Platforms
              </button>
              <button
                type="button"
                onClick={() => setActivePage('help')}
                className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors whitespace-nowrap"
              >
                Copyright &amp; Permissions
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
