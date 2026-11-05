import {
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  onIdTokenChanged,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
} from './config';

export const OFFICIAL_ROLES = [
  'Administrador',
  'Jefe de proyecto',
  'Supervisor',
  'Auxiliar',
  'Almacén',
  'Solo lectura',
] as const;

export type OfficialRole = (typeof OFFICIAL_ROLES)[number];

export const ROOT_ADMIN_EMAIL = 'renzopachas20@gmail.com';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: OfficialRole;
  active: boolean;
  assignedSectorIds: string[];
  assignedGalponIds: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastLoginAt: string;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  password?: string;
  generateTempPassword?: boolean;
  role: OfficialRole;
  active: boolean;
  assignedSectorIds: string[];
  assignedGalponIds: string[];
}

export interface UpdateUserInput {
  displayName?: string;
  role?: OfficialRole;
  active?: boolean;
  assignedSectorIds?: string[];
  assignedGalponIds?: string[];
}

export function mapFirebaseAuthErrorToSpanish(error: unknown): string {
  const code = (error as { code?: string })?.code || '';
  const message = error instanceof Error ? error.message : String(error);

  if (
    code === 'auth/wrong-password' ||
    code === 'auth/invalid-credential' ||
    code === 'auth/invalid-login-credentials' ||
    message.includes('INVALID_LOGIN_CREDENTIALS') ||
    message.includes('INVALID_PASSWORD')
  ) {
    return 'Correo electrónico o contraseña incorrectos. Verifica tus datos e inténtalo nuevamente.';
  }
  if (code === 'auth/user-not-found' || message.includes('EMAIL_NOT_FOUND')) {
    return 'No existe ninguna cuenta registrada con este correo electrónico.';
  }
  if (code === 'auth/invalid-email' || message.includes('INVALID_EMAIL')) {
    return 'El formato del correo electrónico ingresado no es válido.';
  }
  if (code === 'auth/user-disabled' || message.includes('USER_DISABLED')) {
    return 'Esta cuenta de usuario se encuentra desactivada. Contacta al Administrador.';
  }
  if (code === 'auth/too-many-requests' || message.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) {
    return 'Se detectaron demasiados intentos fallidos consecutivos. Por seguridad, espera unos minutos o utiliza la opción de recuperar contraseña.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Error de conexión con el servidor. Verifica tu conexión a internet e inténtalo nuevamente.';
  }
  if (
    code === 'auth/operation-not-allowed' ||
    message.includes('PASSWORD_LOGIN_DISABLED') ||
    message.includes('OPERATION_NOT_ALLOWED')
  ) {
    return 'El inicio de sesión con correo y contraseña está pendiente de activación en Firebase Console (Authentication > Sign-in method > Correo electrónico/contraseña).';
  }
  if (code === 'auth/user-token-expired' || code === 'auth/id-token-expired') {
    return 'Tu sesión ha vencido por seguridad. Inicia sesión nuevamente.';
  }
  return message || 'No se pudo completar la operación de autenticación.';
}

export async function fetchOrBootstrapProfile(user: User): Promise<UserProfile> {
  const userRef = doc(db, 'users', user.uid);
  let snap;
  try {
    snap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${user.uid}`);
  }

  if (snap.exists()) {
    const data = snap.data() as UserProfile;
    return {
      uid: data.uid || user.uid,
      email: data.email || user.email || '',
      displayName: data.displayName || user.displayName || user.email || 'Usuario',
      role: OFFICIAL_ROLES.includes(data.role) ? data.role : 'Solo lectura',
      active: Boolean(data.active),
      assignedSectorIds: Array.isArray(data.assignedSectorIds) ? data.assignedSectorIds : [],
      assignedGalponIds: Array.isArray(data.assignedGalponIds) ? data.assignedGalponIds : [],
      createdAt: data.createdAt || '',
      createdBy: data.createdBy || '',
      updatedAt: data.updatedAt || '',
      updatedBy: data.updatedBy || '',
      lastLoginAt: data.lastLoginAt || '',
    };
  }

  // Si es el correo del Administrador raíz verificado, inicializar su perfil
  const cleanEmail = (user.email || '').toLowerCase();
  if (cleanEmail === ROOT_ADMIN_EMAIL && user.emailVerified) {
    const nowIso = new Date().toISOString();
    const rootProfile: UserProfile = {
      uid: user.uid,
      email: cleanEmail,
      displayName: user.displayName || 'Administrador General',
      role: 'Administrador',
      active: true,
      assignedSectorIds: [],
      assignedGalponIds: [],
      createdAt: nowIso,
      createdBy: cleanEmail,
      updatedAt: nowIso,
      updatedBy: cleanEmail,
      lastLoginAt: nowIso,
    };
    try {
      await setDoc(userRef, rootProfile);
      return rootProfile;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}`);
    }
  }

  throw new Error(
    'Tu cuenta no tiene un perfil activo asignado en Control Galpones La Calera. Solicita tu habilitación al Administrador.'
  );
}

export async function loginWithEmailAndPassword(
  email: string,
  password: string
): Promise<UserProfile> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) {
    throw new Error('Ingresa tu correo electrónico.');
  }
  if (!password) {
    throw new Error('Ingresa tu contraseña.');
  }

  let credential;
  try {
    credential = await signInWithEmailAndPassword(auth, cleanEmail, password);
  } catch (error) {
    throw new Error(mapFirebaseAuthErrorToSpanish(error));
  }

  const profile = await fetchOrBootstrapProfile(credential.user);

  if (!profile.active) {
    await signOut(auth);
    throw new Error(
      'Tu cuenta ha sido desactivada por el Administrador y no puede acceder al sistema.'
    );
  }

  // Actualizar fecha de último inicio de sesión (lastLoginAt)
  const nowIso = new Date().toISOString();
  try {
    await updateDoc(doc(db, 'users', credential.user.uid), {
      lastLoginAt: nowIso,
      updatedAt: nowIso,
      updatedBy: profile.email,
    });
    profile.lastLoginAt = nowIso;
    profile.updatedAt = nowIso;
    profile.updatedBy = profile.email;
  } catch {
    // Si la actualización de lastLoginAt no es crítica, continuar con el perfil verificado
  }

  return profile;
}

export async function sendPasswordRecoveryEmail(email: string): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Ingresa un correo electrónico válido para recuperar tu contraseña.');
  }
  try {
    await sendPasswordResetEmail(auth, cleanEmail);
  } catch (error) {
    throw new Error(mapFirebaseAuthErrorToSpanish(error));
  }
}

export async function logoutUser(): Promise<void> {
  await signOut(auth);
}

export function subscribeToAuthChanges(
  onUserChange: (user: User | null) => void
): Unsubscribe {
  return onAuthStateChanged(auth, onUserChange);
}

export function subscribeToTokenChanges(
  onTokenChange: (user: User | null) => void
): Unsubscribe {
  return onIdTokenChanged(auth, onTokenChange);
}

export function subscribeToCurrentUserProfile(
  uid: string,
  onProfile: (profile: UserProfile | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const userRef = doc(db, 'users', uid);
  return onSnapshot(
    userRef,
    (snap) => {
      if (!snap.exists()) {
        onProfile(null);
        return;
      }
      const data = snap.data() as UserProfile;
      onProfile({
        uid: data.uid || uid,
        email: data.email || '',
        displayName: data.displayName || '',
        role: OFFICIAL_ROLES.includes(data.role) ? data.role : 'Solo lectura',
        active: Boolean(data.active),
        assignedSectorIds: Array.isArray(data.assignedSectorIds) ? data.assignedSectorIds : [],
        assignedGalponIds: Array.isArray(data.assignedGalponIds) ? data.assignedGalponIds : [],
        createdAt: data.createdAt || '',
        createdBy: data.createdBy || '',
        updatedAt: data.updatedAt || '',
        updatedBy: data.updatedBy || '',
        lastLoginAt: data.lastLoginAt || '',
      });
    },
    (err) => {
      if (onError) onError(err);
    }
  );
}

export function subscribeToAllUsers(
  onUsers: (users: UserProfile[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const colRef = collection(db, 'users');
  return onSnapshot(
    colRef,
    (snap) => {
      const list: UserProfile[] = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data() as UserProfile;
        list.push({
          uid: d.uid || docSnap.id,
          email: d.email || '',
          displayName: d.displayName || '',
          role: OFFICIAL_ROLES.includes(d.role) ? d.role : 'Solo lectura',
          active: Boolean(d.active),
          assignedSectorIds: Array.isArray(d.assignedSectorIds) ? d.assignedSectorIds : [],
          assignedGalponIds: Array.isArray(d.assignedGalponIds) ? d.assignedGalponIds : [],
          createdAt: d.createdAt || '',
          createdBy: d.createdBy || '',
          updatedAt: d.updatedAt || '',
          updatedBy: d.updatedBy || '',
          lastLoginAt: d.lastLoginAt || '',
        });
      });
      list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      onUsers(list);
    },
    (err) => {
      if (onError) {
        onError(err);
      } else {
        handleFirestoreError(err, OperationType.LIST, 'users');
      }
    }
  );
}

async function getBearerHeader(): Promise<Record<string, string>> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Tu sesión ha expirado. Inicia sesión nuevamente.');
  }
  const idToken = await currentUser.getIdToken(true);
  return {
    Authorization: `Bearer ${idToken}`,
    'Content-Type': 'application/json',
  };
}

export async function adminCreateUserOnServer(input: CreateUserInput): Promise<{
  profile: UserProfile;
  temporaryPassword: string;
}> {
  const headers = await getBearerHeader();
  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    profile?: UserProfile;
    temporaryPassword?: string;
    error?: string;
  };
  if (!res.ok || !data.ok || !data.profile) {
    throw new Error(data.error || 'No se pudo crear el usuario en el servidor.');
  }
  return {
    profile: data.profile,
    temporaryPassword: data.temporaryPassword || '',
  };
}

export async function adminUpdateUserOnServer(
  uid: string,
  input: UpdateUserInput
): Promise<UserProfile> {
  const headers = await getBearerHeader();
  const res = await fetch(`/api/admin/users/${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    profile?: UserProfile;
    error?: string;
  };
  if (!res.ok || !data.ok || !data.profile) {
    throw new Error(data.error || 'No se pudo actualizar el usuario en el servidor.');
  }
  return data.profile;
}

export async function adminSendPasswordResetOnServer(uid: string): Promise<string> {
  const headers = await getBearerHeader();
  const res = await fetch(`/api/admin/users/${encodeURIComponent(uid)}/reset-password`, {
    method: 'POST',
    headers,
  });
  const data = (await res.json()) as {
    ok?: boolean;
    message?: string;
    error?: string;
  };
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'No se pudo enviar el correo de recuperación.');
  }
  return data.message || 'Correo de recuperación enviado.';
}
