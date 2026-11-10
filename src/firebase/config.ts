import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  setPersistence,
  browserLocalPersistence,
  type Auth,
} from 'firebase/auth';
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
const emulator = env.VITE_CALERA_AUTH_EMULATOR;
const demoProject = env.VITE_CALERA_DEMO_PROJECT;
if (emulator && (!/^http:\/\/127\.0\.0\.1:\d+$/.test(emulator) || !/^demo-[a-z0-9-]+$/.test(demoProject ?? ''))) {
  throw new Error('El entorno sintético de Auth requiere loopback y un proyecto demo.');
}

// Priorizar siempre los identificadores oficiales aprovisionados en firebase-applet-config.json
// para evitar que variables de entorno manuales con errores de transcripción apunten a una BD inexistente.
export const firebaseConfig: ResolvedFirebaseConfig = {
  projectId: emulator ? demoProject! : firebaseAppletConfig.projectId || env.VITE_FIREBASE_PROJECT_ID || '',
  appId: firebaseAppletConfig.appId || env.VITE_FIREBASE_APP_ID || '',
  apiKey: emulator ? 'demo' : firebaseAppletConfig.apiKey || env.VITE_FIREBASE_API_KEY || '',
  authDomain: emulator ? 'localhost' : firebaseAppletConfig.authDomain || env.VITE_FIREBASE_AUTH_DOMAIN || '',
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

export const auth: Auth = getAuth(firebaseApp);
if (emulator && !auth.emulatorConfig) connectAuthEmulator(auth, emulator);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Configurar persistencia local segura de sesión en navegador
setPersistence(auth, browserLocalPersistence).catch(() => {
  console.warn('No se pudo establecer la persistencia local de Auth.');
});
