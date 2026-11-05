import {
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  type User
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  onSnapshot,
  type Unsubscribe
} from 'firebase/firestore';
import { auth, db } from './config';

// ============================================================================
// 1. Definición de los Seis Roles Oficiales y Perfil de Usuario
// ============================================================================

export const OFFICIAL_ROLES = [
  'Administrador',
  'Jefe de proyecto',
  'Supervisor',
  'Auxiliar',
  'Almacén',
  'Solo lectura'
] as const;

export type OfficialRole = (typeof OFFICIAL_ROLES)[number];
export type AuthMethod = 'password' | 'google' | 'both';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  dni?: string;
  authMethod?: AuthMethod;
  role: OfficialRole;
  active: boolean;
  assignedProject?: string;
  assignedSectorIds: string[];
  assignedGalponIds: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastLoginAt?: string;
}

export interface CreateUserInput {
  email: string;
  password?: string;
  displayName: string;
  dni?: string;
  authMethod?: AuthMethod;
  role: OfficialRole;
  active: boolean;
  assignedProject?: string;
  assignedSectorIds: string[];
  assignedGalponIds: string[];
}

export interface UpdateUserInput {
  displayName?: string;
  dni?: string;
  email?: string;
  authMethod?: AuthMethod;
  role?: OfficialRole;
  active?: boolean;
  assignedProject?: string;
  assignedSectorIds?: string[];
  assignedGalponIds?: string[];
}

// ============================================================================
// 2. Mensajes Claros de Error en Español
// ============================================================================

export function translateFirebaseAuthError(error: any): string {
  const code = error?.code || '';
  const msg = String(error?.message || '');

  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Credenciales incorrectas. Verifique su correo electrónico y contraseña.';
    case 'auth/invalid-email':
      return 'El formato del correo electrónico no es válido.';
    case 'auth/user-disabled':
      return 'Esta cuenta ha sido deshabilitada en el servidor de autenticación.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos fallidos. Por seguridad, espere unos minutos o restablezca su contraseña.';
    case 'auth/network-request-failed':
      return 'Error de conexión a internet. Verifique su red e intente nuevamente.';
    case 'auth/user-token-expired':
    case 'auth/id-token-expired':
      return 'Su sesión ha vencido. Por favor, inicie sesión nuevamente.';
    case 'auth/popup-closed-by-user':
      return 'Se cerró la ventana de inicio de sesión con Google antes de completar la autenticación.';
    case 'auth/popup-blocked':
      return 'El navegador bloqueó la ventana emergente de Google. Permita ventanas emergentes e intente de nuevo.';
    case 'auth/cancelled-popup-request':
      return 'Solicitud de ventana emergente cancelada. Intente nuevamente.';
    case 'auth/account-exists-with-different-credential':
      return 'Ya existe una cuenta con este correo electrónico bajo otro método de acceso.';
    default:
      if (msg.includes('PROFILE_NOT_FOUND') || msg.includes('no está autorizada')) {
        return 'Acceso denegado: Su cuenta no está autorizada en Control Galpones La Calera. Solicite al Administrador que registre su acceso.';
      }
      if (msg.includes('USER_INACTIVE') || msg.includes('desactivada')) {
        return 'Acceso bloqueado: Su cuenta ha sido desactivada por el Administrador.';
      }
      return msg || 'Ocurrió un error inesperado de autenticación.';
  }
}

// ============================================================================
// 3. Autenticación y Gestión de Sesión (Correo/Contraseña + Google)
// ============================================================================

export async function loginWithEmail(
  email: string,
  password: string
): Promise<{ user: User; profile: UserProfile }> {
  await setPersistence(auth, browserLocalPersistence);
  const cleanEmail = email.trim().toLowerCase();
  const credential = await signInWithEmailAndPassword(auth, cleanEmail, password);
  const profile = await fetchOrBootstrapProfile(credential.user);
  return { user: credential.user, profile };
}

/**
 * Inicio de sesión con Google utilizando Firebase Authentication (GoogleAuthProvider).
 * Compatible con navegador web y preparado para contenedor móvil Capacitor/Android.
 * Verifica obligatoriamente que exista un perfil activo autorizado en /users/{uid}.
 */
export async function loginWithGoogle(): Promise<{ user: User; profile: UserProfile }> {
  await setPersistence(auth, browserLocalPersistence);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const credential = await signInWithPopup(auth, provider);
  try {
    const profile = await fetchOrBootstrapProfile(credential.user);
    return { user: credential.user, profile };
  } catch (err) {
    await signOut(auth).catch(() => {});
    throw err;
  }
}

export async function logoutSession(): Promise<void> {
  await signOut(auth);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  await sendPasswordResetEmail(auth, cleanEmail);
}

/**
 * Obtiene y valida el perfil del usuario en `/users/{uid}`.
 * Sincroniza con `/api/auth/verify-session` para:
 * - Soportar vinculación segura de cuentas Google pre-autorizadas por el Administrador.
 * - Actualizar `lastLoginAt` y registrar el refreshToken en la bóveda cifrada del servidor.
 * - Rechazar inmediatamente cualquier cuenta no autorizada o desactivada.
 */
export async function fetchOrBootstrapProfile(user: User): Promise<UserProfile> {
  const idToken = await user.getIdToken();
  const refreshToken = user.refreshToken || '';

  // 1. Verificar sesión en el backend primero (permite vincular cuentas Google pre-autorizadas y validar estado)
  try {
    const resp = await fetch('/api/auth/verify-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({ refreshToken })
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data?.profile) {
        return normalizeUserProfile(data.profile);
      }
    } else if (resp.status === 403) {
      const errData = await resp.json().catch(() => ({}));
      await signOut(auth).catch(() => {});
      throw new Error(
        errData?.message ||
          'Su cuenta no tiene autorización activa para ingresar al sistema.'
      );
    }
  } catch (err: any) {
    if (
      err?.message?.includes('autorizada') ||
      err?.message?.includes('desactivada') ||
      err?.message?.includes('autorización') ||
      err?.message?.includes('bloqueado')
    ) {
      throw err;
    }
    // Si hay un fallo transitorio de red hacia /api, continuamos con verificación directa en Firestore
  }

  // 2. Lectura directa desde Firestore SDK como respaldo
  const userRef = doc(db, 'users', user.uid);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    await signOut(auth).catch(() => {});
    throw new Error(
      'Su cuenta no está autorizada en Control Galpones La Calera. Solicite al Administrador que registre su acceso.'
    );
  }

  const profile = normalizeUserProfile(snap.data() as UserProfile);

  if (!profile.active) {
    await signOut(auth).catch(() => {});
    throw new Error(
      'Su cuenta ha sido desactivada por el Administrador. Comuníquese con la gerencia de proyecto.'
    );
  }

  if (!OFFICIAL_ROLES.includes(profile.role)) {
    await signOut(auth).catch(() => {});
    throw new Error(
      `El rol asignado (${profile.role}) no es válido en la matriz oficial de permisos.`
    );
  }

  const nowIso = new Date().toISOString();
  try {
    await setDoc(
      userRef,
      {
        ...profile,
        lastLoginAt: nowIso,
        updatedAt: nowIso,
        updatedBy: user.uid
      },
      { merge: true }
    );
    profile.lastLoginAt = nowIso;
  } catch {
    // Ignorar fallo no crítico de actualización de lastLoginAt
  }

  return profile;
}

export function normalizeUserProfile(raw: any): UserProfile {
  return {
    uid: String(raw?.uid || ''),
    email: String(raw?.email || '').toLowerCase(),
    displayName: String(raw?.displayName || ''),
    dni: raw?.dni ? String(raw.dni) : '',
    authMethod:
      raw?.authMethod === 'google' || raw?.authMethod === 'both' || raw?.authMethod === 'password'
        ? raw.authMethod
        : 'password',
    role: (OFFICIAL_ROLES.includes(raw?.role) ? raw.role : 'Solo lectura') as OfficialRole,
    active: Boolean(raw?.active),
    assignedProject: raw?.assignedProject ? String(raw.assignedProject) : 'TODOS',
    assignedSectorIds: Array.isArray(raw?.assignedSectorIds)
      ? raw.assignedSectorIds.map(String)
      : [],
    assignedGalponIds: Array.isArray(raw?.assignedGalponIds)
      ? raw.assignedGalponIds.map(String)
      : [],
    createdAt: String(raw?.createdAt || new Date().toISOString()),
    createdBy: String(raw?.createdBy || 'system'),
    updatedAt: String(raw?.updatedAt || new Date().toISOString()),
    updatedBy: String(raw?.updatedBy || 'system'),
    ...(raw?.lastLoginAt ? { lastLoginAt: String(raw.lastLoginAt) } : {})
  };
}

/**
 * Suscripción en tiempo real al documento `/users/{uid}` del usuario autenticado.
 * Permite detectar inmediatamente desactivación de cuenta o cambios de rol/alcance en vivo.
 */
export function subscribeToUserProfile(
  uid: string,
  onProfileChange: (profile: UserProfile | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const userRef = doc(db, 'users', uid);
  return onSnapshot(
    userRef,
    (snap) => {
      if (!snap.exists()) {
        onProfileChange(null);
        return;
      }
      onProfileChange(normalizeUserProfile(snap.data()));
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

export { onAuthStateChanged };

// ============================================================================
// 4. Funciones de Administración de Usuarios (Exclusivas para Administrador)
// ============================================================================

async function getAdminAuthHeaders(): Promise<Record<string, string>> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Sesión no encontrada. Inicie sesión nuevamente.');
  }
  const idToken = await currentUser.getIdToken();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${idToken}`
  };
}

export async function adminListUsers(): Promise<UserProfile[]> {
  try {
    const snap = await getDocs(collection(db, 'users'));
    const list: UserProfile[] = [];
    snap.forEach((docSnap) => {
      list.push(normalizeUserProfile(docSnap.data()));
    });
    list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return list;
  } catch {
    const headers = await getAdminAuthHeaders();
    const resp = await fetch('/api/admin/users', { method: 'GET', headers });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data?.message || 'Error al listar los usuarios.');
    }
    return (data.users || []).map(normalizeUserProfile);
  }
}

export async function adminCreateUser(input: CreateUserInput): Promise<UserProfile> {
  const headers = await getAdminAuthHeaders();
  const resp = await fetch('/api/admin/users', {
    method: 'POST',
    headers,
    body: JSON.stringify(input)
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.message || 'Error al crear el usuario.');
  }
  return normalizeUserProfile(data.user);
}

export async function adminUpdateUser(
  uid: string,
  updates: UpdateUserInput
): Promise<{ user: UserProfile; authEmailSyncNote?: string }> {
  const headers = await getAdminAuthHeaders();
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(updates)
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.message || 'Error al actualizar el usuario.');
  }
  return {
    user: normalizeUserProfile(data.user),
    authEmailSyncNote: data.authEmailSyncNote
  };
}

export async function adminGenerateTempPassword(
  uid: string,
  tempPassword?: string
): Promise<{ mode: 'direct_update' | 'reset_email_sent'; tempPassword?: string; message: string }> {
  const headers = await getAdminAuthHeaders();
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(uid)}/temp-password`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tempPassword })
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.message || 'Error al generar contraseña temporal.');
  }
  return data;
}

export async function adminSendPasswordReset(uid: string): Promise<string> {
  const headers = await getAdminAuthHeaders();
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(uid)}/reset-password`, {
    method: 'POST',
    headers
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.message || 'Error al enviar el correo de recuperación.');
  }
  return data.message || 'Correo de restablecimiento enviado.';
}
