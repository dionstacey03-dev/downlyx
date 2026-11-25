import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import type {
  DownloadStatus,
  HistoryItem,
  MediaTypeLabel,
  PlatformId,
  UserPreferences,
} from '../types/media.ts';
import {
  DEFAULT_PREFERENCES,
  normalizeQualityPreference,
} from '../utils/platformDetector.ts';
import {
  db,
  handleFirestoreError,
  isAuthEmulatorActive,
  OperationType,
} from '../firebase.ts';

export type ActivityAction =
  | 'auth_login'
  | 'auth_register'
  | 'auth_logout'
  | 'url_analyzed'
  | 'download_started'
  | 'download_completed'
  | 'download_failed'
  | 'download_cancelled'
  | 'preferences_updated'
  | 'history_cleared';

export interface UserProfileDoc {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  preferences: UserPreferences;
  createdAt?: unknown;
  updatedAt?: unknown;
}

const VALID_PLATFORMS = new Set<PlatformId>([
  'youtube',
  'instagram',
  'tiktok',
  'facebook',
  'x',
  'direct',
  'unsupported',
]);

const VALID_STATUSES = new Set<DownloadStatus>([
  'analyzed',
  'queued',
  'processing',
  'verifying',
  'completed',
  'failed',
  'permanently_failed',
  'cancelled',
  'unsupported',
]);

const TERMINAL_STATUSES = new Set<DownloadStatus>([
  'completed',
  'failed',
  'permanently_failed',
  'cancelled',
]);

const ALLOWED_FORMATS = new Set(['mp4', 'webm', 'mp3', 'm4a']);

function sanitizeDocId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return cleaned || `rec_${Date.now()}`;
}

export function sanitizePreferences(
  prefs: Partial<UserPreferences>
): UserPreferences {
  const format =
    prefs.defaultFormat && ALLOWED_FORMATS.has(prefs.defaultFormat)
      ? prefs.defaultFormat
      : DEFAULT_PREFERENCES.defaultFormat;
  const workspaceName =
    typeof prefs.workspaceName === 'string' && prefs.workspaceName.trim()
      ? prefs.workspaceName.trim().slice(0, 60)
      : DEFAULT_PREFERENCES.workspaceName;

  return {
    defaultQuality: normalizeQualityPreference(prefs.defaultQuality),
    defaultFormat: format,
    autoDetectClipboard: Boolean(prefs.autoDetectClipboard),
    saveHistoryLocally:
      prefs.saveHistoryLocally !== undefined
        ? Boolean(prefs.saveHistoryLocally)
        : DEFAULT_PREFERENCES.saveHistoryLocally,
    autoRetry: Boolean(prefs.autoRetry),
    workspaceName,
  };
}

function sanitizeDisplayName(user: User, overrideName?: string): string {
  const candidate =
    overrideName?.trim() ||
    user.displayName?.trim() ||
    user.email?.split('@')[0]?.trim() ||
    'DOWNLYX User';
  return candidate.slice(0, 80);
}

function timestampToIso(value: unknown): string {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return new Date().toISOString();
}

export async function ensureUserProfile(
  user: User,
  fallbackPreferences: UserPreferences = DEFAULT_PREFERENCES
): Promise<void> {
  if (!user.emailVerified || isAuthEmulatorActive) return;
  const profilePath = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, profilePath);
  }

  if (snap.exists()) return;

  const payload = {
    uid: user.uid,
    displayName: sanitizeDisplayName(user),
    email: (user.email || '').slice(0, 254),
    photoURL: (user.photoURL || '').slice(0, 1024),
    preferences: sanitizePreferences(fallbackPreferences),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(ref, payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, profilePath);
  }
}

export function subscribeUserProfile(
  uid: string,
  onProfile: (profile: UserProfileDoc | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  if (isAuthEmulatorActive) {
    return () => {};
  }
  const profilePath = `users/${uid}`;
  return onSnapshot(
    doc(db, 'users', uid),
    (snapshot) => {
      if (!snapshot.exists()) {
        onProfile(null);
        return;
      }
      const data = snapshot.data() as Partial<UserProfileDoc>;
      onProfile({
        uid: String(data.uid || uid),
        displayName: String(data.displayName || 'DOWNLYX User'),
        email: String(data.email || ''),
        photoURL: String(data.photoURL || ''),
        preferences: sanitizePreferences(data.preferences ?? DEFAULT_PREFERENCES),
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, profilePath);
      } catch (wrapped) {
        onError?.(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function updateUserProfileRecord(params: {
  user: User;
  preferences?: UserPreferences;
  displayName?: string;
}): Promise<void> {
  if (!params.user.emailVerified || isAuthEmulatorActive) return;
  const profilePath = `users/${params.user.uid}`;
  const ref = doc(db, 'users', params.user.uid);

  const updates: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
  };
  if (params.preferences) {
    updates.preferences = sanitizePreferences(params.preferences);
  }
  if (params.displayName !== undefined) {
    updates.displayName = sanitizeDisplayName(params.user, params.displayName);
    updates.photoURL = (params.user.photoURL || '').slice(0, 1024);
  }

  try {
    await updateDoc(ref, updates);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, profilePath);
  }
}

export function subscribeUserDownloads(
  uid: string,
  onItems: (items: HistoryItem[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  if (isAuthEmulatorActive) {
    return () => {};
  }
  const colPath = `users/${uid}/downloads`;
  const q = query(
    collection(db, 'users', uid, 'downloads'),
    orderBy('createdAt', 'desc'),
    limit(100)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const items: HistoryItem[] = snapshot.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const rawPlatform = String(data.platform || 'unsupported') as PlatformId;
        const rawStatus = String(data.status || 'analyzed') as DownloadStatus;
        return {
          id: d.id,
          jobId: d.id,
          url: String(data.url || ''),
          platform: VALID_PLATFORMS.has(rawPlatform) ? rawPlatform : 'unsupported',
          platformName: String(data.platformName || 'Source'),
          mediaType: String(data.mediaType || 'Unknown') as MediaTypeLabel,
          fileType: String(data.format || 'Unverified'),
          qualityPreference: String(data.qualityPreference || 'Best Available'),
          status: VALID_STATUSES.has(rawStatus) ? rawStatus : 'analyzed',
          resourceId: data.resourceId ? String(data.resourceId) : null,
          createdAt: timestampToIso(data.createdAt),
          note: String(data.note || ''),
          sizeBytes:
            typeof data.fileSize === 'number' && data.fileSize > 0
              ? data.fileSize
              : undefined,
        };
      });
      onItems(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, colPath);
      } catch (wrapped) {
        onError?.(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    }
  );
}

export async function saveUserDownloadRecord(
  user: User,
  item: HistoryItem
): Promise<void> {
  if (!user.emailVerified || isAuthEmulatorActive) return;
  const docId = sanitizeDocId(item.jobId || item.id);
  const docPath = `users/${user.uid}/downloads/${docId}`;
  const ref = doc(db, 'users', user.uid, 'downloads', docId);

  const platform: PlatformId = VALID_PLATFORMS.has(item.platform)
    ? item.platform
    : 'unsupported';
  const status: DownloadStatus = VALID_STATUSES.has(item.status)
    ? item.status
    : 'analyzed';

  const safeUrl = (item.url || '').trim().slice(0, 2048);
  if (safeUrl.length < 10) return;

  const basePayload = {
    ownerUid: user.uid,
    url: safeUrl,
    platform,
    platformName: (item.platformName || 'Source').slice(0, 60),
    mediaType: (item.mediaType || 'Unknown').slice(0, 40),
    format: (item.fileType || 'Unverified').slice(0, 32),
    qualityPreference: (item.qualityPreference || 'Best Available').slice(0, 60),
    status,
    fileSize:
      typeof item.sizeBytes === 'number' &&
      Number.isFinite(item.sizeBytes) &&
      item.sizeBytes >= 0
        ? Math.min(Math.round(item.sizeBytes), 524_288_000)
        : 0,
    resourceId: (item.resourceId || '').slice(0, 256),
    note: (item.note || '').slice(0, 500),
    updatedAt: serverTimestamp(),
  };

  try {
    const existing = await getDoc(ref);
    if (!existing.exists()) {
      await setDoc(ref, {
        ...basePayload,
        createdAt: serverTimestamp(),
      });
      return;
    }

    const existingStatus = String(
      (existing.data() as { status?: unknown }).status || ''
    ) as DownloadStatus;
    if (TERMINAL_STATUSES.has(existingStatus)) {
      return;
    }

    await updateDoc(ref, {
      status: basePayload.status,
      format: basePayload.format,
      fileSize: basePayload.fileSize,
      note: basePayload.note,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}

export async function deleteUserDownloadRecord(
  uid: string,
  downloadId: string
): Promise<void> {
  if (isAuthEmulatorActive) return;
  const docId = sanitizeDocId(downloadId);
  const docPath = `users/${uid}/downloads/${docId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'downloads', docId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
  }
}

export async function deleteUserDownloadRecordsBatch(
  uid: string,
  downloadIds: string[]
): Promise<void> {
  if (isAuthEmulatorActive || downloadIds.length === 0) return;
  const uniqueDocIds = Array.from(
    new Set(downloadIds.map((id) => sanitizeDocId(id)).filter(Boolean))
  );
  if (uniqueDocIds.length === 0) return;

  const colPath = `users/${uid}/downloads`;
  try {
    for (let i = 0; i < uniqueDocIds.length; i += 400) {
      const batch = writeBatch(db);
      for (const docId of uniqueDocIds.slice(i, i + 400)) {
        batch.delete(doc(db, 'users', uid, 'downloads', docId));
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, colPath);
  }
}

export async function clearAllUserDownloads(uid: string): Promise<void> {
  if (isAuthEmulatorActive) return;
  const colPath = `users/${uid}/downloads`;
  try {
    const snap = await getDocs(collection(db, 'users', uid, 'downloads'));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      for (const d of docs.slice(i, i + 400)) {
        batch.delete(d.ref);
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, colPath);
  }
}

export async function logUserActivity(
  user: User,
  action: ActivityAction,
  metadata: Record<string, string | number | boolean> = {}
): Promise<void> {
  if (!user.emailVerified || isAuthEmulatorActive) return;
  const activityId = sanitizeDocId(
    `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  const docPath = `users/${user.uid}/activity/${activityId}`;

  const boundedMeta: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(metadata).slice(0, 10)) {
    const key = k.slice(0, 40);
    if (typeof v === 'string') boundedMeta[key] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) boundedMeta[key] = v;
    else if (typeof v === 'boolean') boundedMeta[key] = v;
  }

  try {
    await setDoc(doc(db, 'users', user.uid, 'activity', activityId), {
      ownerUid: user.uid,
      action,
      timestamp: serverTimestamp(),
      metadata: boundedMeta,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }
}

export async function deleteAllUserFirestoreData(uid: string): Promise<void> {
  if (isAuthEmulatorActive) return;
  const deleteSubcollection = async (sub: 'downloads' | 'activity') => {
    const path = `users/${uid}/${sub}`;
    try {
      const snap = await getDocs(collection(db, 'users', uid, sub));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of snap.docs.slice(i, i + 400)) {
          batch.delete(d.ref);
        }
        await batch.commit();
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  };

  await deleteSubcollection('downloads');
  await deleteSubcollection('activity');

  const profilePath = `users/${uid}`;
  try {
    await deleteDoc(doc(db, 'users', uid));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, profilePath);
  }
}
