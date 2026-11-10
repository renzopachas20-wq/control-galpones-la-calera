import {
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
  type User
} from 'firebase/auth';
import { auth } from './config';
import { getApiUrl } from './apiConfig';

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
export const PRIMARY_ADMIN_UID = 'jcSCn1eJ7Yao4xYeV6J8eZpszLR2';

export interface CredentialOperationStatus {
  id: string;
  uid: string;
  version: number;
  kind: 'email' | 'password' | 'active' | 'sessions' | 'profile' | 'emergency';
  state: 'pending' | 'completed' | 'failed';
  authentication: 'ready' | 'dispatching' | 'uncertain' | 'applied' | 'rejected' | 'not_required';
  audit: 'pending' | 'recorded' | 'not_required';
  failure?: string;
  sessionCutoff?: number;
  profileApplied?: boolean;
  authDisabled?: boolean;
  refreshRevoked?: boolean;
}

interface ProfileMutationResult {
  user: UserProfile | null;
  profileRefreshRequired: boolean;
  currentAuthentication?: { disabled: boolean; profileVersion: number } | null;
}

interface CredentialOperationResult extends ProfileMutationResult {
  operation: CredentialOperationStatus;
}

export interface ProvisioningReservation {
  uid: string;
  email: string;
  displayName: string;
  state: 'ready' | 'dispatching' | 'uncertain' | 'rejected';
  expiresAt: string;
  manageable: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  dni?: string;
  authMethod?: AuthMethod;
  role: OfficialRole;
  active: boolean;
  status?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastLoginAt?: string;
  profileVersion?: number;
  credentialVersion?: number;
}

export interface CreateUserInput {
  email: string;
  password?: string;
  displayName: string;
  dni?: string;
  authMethod?: AuthMethod;
  role: OfficialRole;
  active: boolean;
}

export interface UpdateUserInput {
  expectedProfileVersion: number;
  operationId?: string;
  displayName?: string;
  dni?: string;
  email?: string;
  authMethod?: AuthMethod;
  role?: OfficialRole;
  active?: boolean;
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

/**
 * Configuración segura de persistencia de sesión:
 * Soporta Safari con ITP (Intelligent Tracking Prevention), modo privado y
 * WebView móvil (Capacitor/Android) donde localStorage puede arrojar SecurityError.
 * Degrada suavemente: browserLocalPersistence -> browserSessionPersistence -> inMemoryPersistence.
 */
export async function ensureAuthPersistence(): Promise<void> {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (err1) {
    try {
      await setPersistence(auth, browserSessionPersistence);
    } catch {
      await setPersistence(auth, inMemoryPersistence).catch(() => {});
    }
  }
}

export async function loginWithEmail(
  email: string,
  password: string
): Promise<void> {
  await ensureAuthPersistence();
  const cleanEmail = email.trim().toLowerCase();
  await signInWithEmailAndPassword(auth, cleanEmail, password);
}

export function googleAuthFailure(error: unknown) {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' && [
    'auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request',
    'auth/operation-not-allowed', 'auth/network-request-failed', 'auth/unauthorized-domain',
    'auth/account-exists-with-different-credential', 'auth/credential-already-in-use',
    'auth/user-disabled', 'auth/operation-not-supported-in-this-environment'
  ].includes(raw) ? raw : 'auth/google-unknown';
  return Object.assign(new Error('No se pudo iniciar sesión con Google.'), { code });
}

/**
 * Inicio de sesión con Google utilizando Firebase Authentication (GoogleAuthProvider).
 * Compatible con navegador de escritorio, Safari iOS y contenedor móvil Capacitor/Android.
 * Si el navegador móvil bloquea la ventana emergente ('auth/popup-blocked'), realiza
 * fallback automático y transparente a signInWithRedirect para garantizar compatibilidad completa.
 */
export async function loginWithGoogle(): Promise<void> {
  await ensureAuthPersistence();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    const failure = googleAuthFailure(err);
    const { code } = failure;
    if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
      console.warn('Ventana emergente de Google bloqueada o restringida. Iniciando redirección segura para Safari/Móvil...');
      await signInWithRedirect(auth, provider).catch(error => { throw googleAuthFailure(error); });
      return;
    }
    throw failure;
  }
}

/**
 * Procesa el resultado de signInWithRedirect al cargar la aplicación (Safari iOS / Móvil).
 */
export async function handleGoogleRedirectResult(): Promise<void> {
  try {
    await getRedirectResult(auth);
  } catch (err) {
    const failure = googleAuthFailure(err);
    console.warn('Google Sign-In, redirección:', failure.code);
    throw failure;
  }
}

export async function logoutSession(): Promise<void> {
  await signOut(auth);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  await sendPasswordResetEmail(auth, cleanEmail);
}

/** Verifica el ID token y el perfil con el backend, incluida la vinculación temporal. */
export async function fetchOrBootstrapProfile(user: User, bootstrap = true): Promise<UserProfile> {
  const idToken = await user.getIdToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  let data: any;
  try {
    response = await fetch(getApiUrl(bootstrap ? '/api/auth/verify-session' : '/api/auth/profile'), {
      method: bootstrap ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + idToken },
      signal: controller.signal
    });
    data = await response.json().catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(data?.message || 'No se pudo verificar la sesión con el servidor.'),
      { code: data?.code, status: response.status }
    );
  }
  const profile = data?.profile;
  if (profile?.uid !== user.uid || profile.active !== true || !OFFICIAL_ROLES.includes(profile.role) ||
      auth.currentUser !== user) {
    throw new Error('El perfil verificado no corresponde a la sesión activa.');
  }
  return normalizeUserProfile(profile);
}

export function normalizeUserProfile(raw: any): UserProfile {
  const isActive = raw?.active === true;
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
    active: isActive,
    status: isActive ? 'activo' : 'inactivo',
    createdAt: String(raw?.createdAt || new Date().toISOString()),
    createdBy: String(raw?.createdBy || 'system'),
    updatedAt: String(raw?.updatedAt || new Date().toISOString()),
    updatedBy: String(raw?.updatedBy || 'system'),
    profileVersion: Number.isSafeInteger(raw?.profileVersion) && raw.profileVersion >= 0 ? raw.profileVersion : 0,
    credentialVersion: Number.isSafeInteger(raw?.credentialVersion) && raw.credentialVersion >= 0 ? raw.credentialVersion : 0,
    ...(raw?.lastLoginAt ? { lastLoginAt: String(raw.lastLoginAt) } : {})
  };
}

/**
 * Consulta el perfil autorizado sin registrar un nuevo inicio de sesión.
 */
export function subscribeToUserProfile(
  user: User,
  onProfileChange: (profile: UserProfile) => void,
  onError: (err: unknown) => void
): () => void {
  let stopped = false;
  let refreshing = false;
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    clearTimeout(timer);
    try {
      const profile = await fetchOrBootstrapProfile(user, false);
      if (!stopped) onProfileChange(profile);
    } catch (err) {
      if (!stopped) onError(err);
    } finally {
      refreshing = false;
      if (!stopped) timer = setTimeout(refresh, 10_000);
    }
  };
  timer = setTimeout(refresh, 10_000);
  window.addEventListener('online', refresh);
  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('online', refresh);
  };
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
  const headers = await getAdminAuthHeaders();
  const response = await fetch(getApiUrl('/api/admin/users'), { method: 'GET', headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || 'Error al listar los usuarios.');
  return (data.users || []).map(normalizeUserProfile);
}

export async function adminCreateUser(input: CreateUserInput): Promise<UserProfile> {
  const headers = await getAdminAuthHeaders();
  const resp = await fetch(getApiUrl('/api/admin/users'), {
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
): Promise<ProfileMutationResult & {
  authEmailSyncNote?: string; operation?: CredentialOperationStatus;
  profileEdit?: { id: string; state: 'pending' | 'completed' | 'failed' | 'review'; code?: string };
  passwordRequiresSeparateRequest?: boolean;
}> {
  const headers = await getAdminAuthHeaders();
  const resp = await fetch(getApiUrl(`/api/admin/users/${encodeURIComponent(uid)}`), {
    method: 'PATCH',
    headers,
    body: JSON.stringify(updates)
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.message || data?.operation?.failure || 'Error al actualizar el usuario.');
  }
  return {
    ...readProfileMutation(data),
    authEmailSyncNote: data.authEmailSyncNote,
    operation: data.operation,
    profileEdit: data.profileEdit,
    passwordRequiresSeparateRequest: data.passwordRequiresSeparateRequest
  };
}

function readProfileMutation(data: Partial<ProfileMutationResult>): ProfileMutationResult {
  return {
    user: data.user ? normalizeUserProfile(data.user) : null,
    profileRefreshRequired: data.profileRefreshRequired === true || !data.user,
    currentAuthentication: data.currentAuthentication
  };
}

export async function adminGenerateTempPassword(
  uid: string,
  tempPassword: string,
  operationId: string = crypto.randomUUID()
): Promise<CredentialOperationResult & { tempPassword?: string; providerAcknowledged: boolean; message: string }> {
  const headers = await getAdminAuthHeaders();
  const resp = await fetch(getApiUrl(`/api/admin/users/${encodeURIComponent(uid)}/temp-password`), {
    method: 'POST',
    headers,
    body: JSON.stringify({ tempPassword, operationId })
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw Object.assign(new Error(data?.operation?.failure || data?.message || 'Error al generar contraseña temporal.'), {
      definitiveFailure: data?.operation?.state === 'failed'
    });
  }
  return { ...data, ...readProfileMutation(data) };
}

async function adminOperation(path: string, body?: Record<string, unknown>) {
  const headers = await getAdminAuthHeaders();
  const resp = await fetch(getApiUrl(path), {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.operation?.failure || data?.message || 'No se pudo gestionar la operación.');
  }
  return data;
}

export async function adminListReservations(): Promise<ProvisioningReservation[]> {
  return (await adminOperation('/api/admin/provisioning')).reservations;
}

export async function adminManageReservation(uid: string, action: 'resume' | 'cancel', password?: string) {
  return adminOperation(`/api/admin/provisioning/${encodeURIComponent(uid)}`, { action, password });
}

export async function adminListCredentialOperations(uid: string): Promise<CredentialOperationStatus[]> {
  return (await adminOperation(`/api/admin/users/${encodeURIComponent(uid)}/credential-operations`)).operations;
}

export async function adminListAuthMethods(uid: string): Promise<AuthMethod[]> {
  return (await adminOperation(`/api/admin/users/${encodeURIComponent(uid)}/auth-methods`)).methods;
}

export async function adminReconcileCredential(id: string): Promise<CredentialOperationResult> {
  const data = await adminOperation(`/api/admin/credential-operations/${encodeURIComponent(id)}/reconcile`, {});
  return { ...data, ...readProfileMutation(data) };
}

export async function adminEmergencyDisable(uid: string, operationId: string): Promise<CredentialOperationResult> {
  const data = await adminOperation('/api/admin/users/' + encodeURIComponent(uid) + '/emergency-disable', { operationId });
  return { ...data, ...readProfileMutation(data) };
}

export async function adminCancelReadyPassword(id: string): Promise<void> {
  await adminOperation(`/api/admin/credential-operations/${encodeURIComponent(id)}/reconcile`, { action: 'cancel-ready-password' });
}

export async function adminRevokeSessions(uid: string, operationId: string): Promise<CredentialOperationResult & { cutoff: number; firebaseRevoked: boolean }> {
  const data = await adminOperation(`/api/admin/users/${encodeURIComponent(uid)}/revoke-sessions`, { operationId });
  return { ...data, ...readProfileMutation(data) };
}
