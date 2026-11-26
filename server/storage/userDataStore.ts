import { getFirestore } from 'firebase-admin/firestore';
import type { HistoryItem, UserPreferences } from '../../src/types/media.ts';
import { DEFAULT_PREFERENCES } from '../../src/utils/platformDetector.ts';
import { getFirebaseAdminApp } from '../security/firebaseAdmin.ts';

interface StoredUserData {
  history?: HistoryItem[];
  preferences?: UserPreferences;
}

// Test-only adapter keeps auth-emulator integration tests hermetic. Production
// always uses Firestore; no in-memory fallback is permitted in deployed mode.
const testData = new Map<string, StoredUserData>();

function userDocument(uid: string) {
  if (!uid || uid.length > 256) throw new Error('Invalid user identifier.');
  const documentId = Buffer.from(uid, 'utf8').toString('base64url');
  return getFirestore(getFirebaseAdminApp())
    .collection('downlyxUserData')
    .doc(documentId);
}

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readHistory(data?: StoredUserData): HistoryItem[] {
  return Array.isArray(data?.history) ? data.history.slice(0, 100) : [];
}

function readPreferences(data?: StoredUserData): UserPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...(data?.preferences ?? {}),
  };
}

export async function getUserHistory(uid: string): Promise<HistoryItem[]> {
  if (process.env.NODE_ENV === 'test') return readHistory(testData.get(uid));
  const snapshot = await userDocument(uid).get();
  return readHistory(snapshot.data() as StoredUserData | undefined);
}

export async function updateUserHistory<T>(
  uid: string,
  updater: (history: HistoryItem[]) => { history: HistoryItem[]; result: T }
): Promise<T> {
  if (process.env.NODE_ENV === 'test') {
    const current = testData.get(uid) ?? {};
    const updated = updater(readHistory(current));
    testData.set(uid, { ...current, history: updated.history.slice(0, 100) });
    return updated.result;
  }
  const ref = userDocument(uid);
  return getFirestore(getFirebaseAdminApp()).runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() as StoredUserData | undefined;
    const updated = updater(readHistory(data));
    transaction.set(
      ref,
      { history: withoutUndefined(updated.history.slice(0, 100)) },
      { merge: true }
    );
    return updated.result;
  });
}

export async function getUserPreferences(uid: string): Promise<UserPreferences> {
  if (process.env.NODE_ENV === 'test') return readPreferences(testData.get(uid));
  const snapshot = await userDocument(uid).get();
  return readPreferences(snapshot.data() as StoredUserData | undefined);
}

export async function setUserPreferences(
  uid: string,
  preferences: UserPreferences
): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    const current = testData.get(uid) ?? {};
    testData.set(uid, { ...current, preferences });
    return;
  }
  await userDocument(uid).set(
    { preferences: withoutUndefined(preferences) },
    { merge: true }
  );
}

export async function deleteUserData(uid: string): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    testData.delete(uid);
    return;
  }
  await userDocument(uid).delete();
}
