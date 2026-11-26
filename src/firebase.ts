import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
} from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
} from 'firebase/firestore';
import firebaseConfigJson from '../firebase-applet-config.json';

const firebaseConfig = {
  ...firebaseConfigJson,
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || firebaseConfigJson.apiKey,
};

// A missing public Firebase web API key should not crash the entire React
// module graph before the user can see a useful setup message. The app root
// checks this flag and renders a configuration screen instead of mounting Auth.
export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey?.trim());

const app = initializeApp({
  ...firebaseConfig,
  // Firebase SDK initialization requires a string. This placeholder is never
  // used for Auth/Firestore operations because the app root blocks them.
  apiKey: firebaseConfig.apiKey?.trim() || 'missing-firebase-api-key',
});

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Optional Auth Emulator binding for automated test environments
const emulatorUrl =
  import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL ||
  (typeof window !== 'undefined'
    ? (window as Window & { __DOWNLYX_AUTH_EMULATOR_URL__?: string })
        .__DOWNLYX_AUTH_EMULATOR_URL__
    : undefined);

export const isAuthEmulatorActive = Boolean(emulatorUrl);

if (emulatorUrl) {
  connectAuthEmulator(auth, emulatorUrl, { disableWarnings: true });
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    authenticated: boolean;
  };
  errorCode?: string;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const rawErrorCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  const errInfo: FirestoreErrorInfo = {
    // Do not include raw Firebase messages, account identifiers, email
    // addresses, provider metadata, or user document IDs in client logs/errors.
    error: 'Firestore operation failed.',
    authInfo: {
      authenticated: Boolean(auth.currentUser),
    },
    operationType,
    path: path ? path.replace(/users\/[^/]+/g, 'users/[redacted]') : null,
    ...(rawErrorCode ? { errorCode: rawErrorCode } : {}),
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

if (!emulatorUrl && isFirebaseConfigured) {
  void testConnection();
}
