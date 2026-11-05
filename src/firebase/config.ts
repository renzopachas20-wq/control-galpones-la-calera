import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  browserLocalPersistence,
  type Auth,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  type Firestore,
} from 'firebase/firestore';
import firebaseAppletConfig from '../../firebase-applet-config.json';

export interface ResolvedFirebaseConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};

// Priorizar siempre los identificadores oficiales aprovisionados en firebase-applet-config.json
// para evitar que variables de entorno manuales con errores de transcripción apunten a una BD inexistente.
export const firebaseConfig: ResolvedFirebaseConfig = {
  projectId: firebaseAppletConfig.projectId || env.VITE_FIREBASE_PROJECT_ID || '',
  appId: firebaseAppletConfig.appId || env.VITE_FIREBASE_APP_ID || '',
  apiKey: firebaseAppletConfig.apiKey || env.VITE_FIREBASE_API_KEY || '',
  authDomain: firebaseAppletConfig.authDomain || env.VITE_FIREBASE_AUTH_DOMAIN || '',
  firestoreDatabaseId:
    firebaseAppletConfig.firestoreDatabaseId || env.VITE_FIREBASE_FIRESTORE_DATABASE_ID || '',
  storageBucket: firebaseAppletConfig.storageBucket || env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId:
    firebaseAppletConfig.messagingSenderId || env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  measurementId: firebaseAppletConfig.measurementId,
};

// Inicialización segura y desacoplada de componentes visuales
export const firebaseApp: FirebaseApp =
  getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db: Firestore = getFirestore(
  firebaseApp,
  firebaseConfig.firestoreDatabaseId
);

export const auth: Auth = getAuth(firebaseApp);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Configurar persistencia local segura de sesión en navegador
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn('No se pudo establecer browserLocalPersistence:', err);
});

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
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export type FirebaseConnectionStatus =
  | 'connected_and_authorized'
  | 'connected_rules_enforced'
  | 'configuration_or_network_error';

/**
 * Valida la conectividad inicial con Cloud Firestore al iniciar la aplicación,
 * distinguiendo entre lectura autorizada, servidor conectado con reglas activas (permission-denied)
 * y error real de red o configuración.
 */
export async function testFirebaseConnection(): Promise<{
  ok: boolean;
  status: FirebaseConnectionStatus;
  databaseId: string;
}> {
  const databaseId = firebaseConfig.firestoreDatabaseId;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return {
      ok: true,
      status: 'connected_and_authorized',
      databaseId,
    };
  } catch (error) {
    const code = (error as { code?: string })?.code || '';
    const message = error instanceof Error ? error.message : String(error);

    if (
      code === 'permission-denied' ||
      message.includes('Missing or insufficient permissions')
    ) {
      // El servidor de Firestore respondió desde la base de datos real y aplicó firestore.rules
      return {
        ok: true,
        status: 'connected_rules_enforced',
        databaseId,
      };
    }

    if (message.includes('the client is offline') || message.includes('not found')) {
      console.error('Please check your Firebase configuration.');
    }

    return {
      ok: false,
      status: 'configuration_or_network_error',
      databaseId,
    };
  }
}
