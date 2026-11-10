import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { AuthMethod, OfficialRole, UserProfile } from '../src/firebase/authService.ts';

const ROLES: readonly OfficialRole[] = [
  'Administrador', 'Jefe de proyecto', 'Supervisor', 'Auxiliar', 'Almacén', 'Solo lectura'
];
export const PRIMARY_ADMIN_UID = 'jcSCn1eJ7Yao4xYeV6J8eZpszLR2';
const PENDING_PREFIX = 'preauth_';

export type Profile = UserProfile & {
  pendingLink?: boolean;
  linkedUid?: string;
  provisioning?: Provisioning | false;
  sessionValidAfter?: number;
  credentialVersion?: number;
  credentialOperationId?: string | null;
  sessionOperationId?: string | null;
  emergencyOperationId?: string | null;
  securityVersion?: number;
  pendingEmail?: string | null;
};
export type ProfileRecord = { id: string; profile: Profile };
type Provisioning = {
  active: boolean;
  state: 'ready' | 'dispatching' | 'uncertain' | 'rejected' | 'cancelled';
  expiresAt: string;
};

type Identity = {
  uid: string;
  email?: string;
  email_verified?: boolean;
  auth_time: number;
  firebase: { sign_in_provider: string; tenant?: string };
};
type Account = {
  uid: string;
  email?: string;
  emailVerified: boolean;
  disabled: boolean;
  tokensValidAfterTime?: string;
  customClaims?: Record<string, unknown>;
  providerData?: { providerId: string }[];
};
type AccountChanges = {
  email?: string; emailVerified?: boolean; displayName?: string; password?: string;
  validSince?: string; disableUser?: boolean;
};
export const CREDENTIAL_OPERATION_CLAIM = 'caleraCredentialOperation';

export class MutationRejected extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class MutationUncertain extends Error {
  readonly code: string;

  constructor(code: string) {
    super('No se pudo confirmar la mutación de Authentication.');
    this.code = code;
  }
}

export interface IdentityProvider {
  verifyIdToken(token: string, checkRevoked: true): Promise<Identity>;
  getUser(uid: string): Promise<Account>;
  getUserByEmail(email: string): Promise<Account>;
  createUser(input: AccountChanges & { uid: string }): Promise<Account>;
  updateCredential(account: Account, input: AccountChanges, operationId: string): Promise<void>;
  containAccount(uid: string, validSince: string): Promise<void>;
}

type Session = { uid: string; identity: Identity };
export type CredentialOperation = {
  id: string;
  uid: string;
  version: number;
  actor: Pick<Profile, 'uid' | 'displayName' | 'email' | 'role'>;
  kind: 'email' | 'password' | 'active' | 'sessions' | 'profile' | 'emergency';
  state: 'pending' | 'completed' | 'failed';
  authentication: 'ready' | 'dispatching' | 'uncertain' | 'applied' | 'rejected' | 'not_required';
  audit: 'pending' | 'recorded' | 'not_required';
  oldEmail: string;
  newEmail?: string;
  changes?: ProfileInput;
  fingerprint?: string;
  parentOperationId?: string;
  secretVerifier?: { salt: string; digest: string };
  sessionCutoff?: number;
  profileApplied?: boolean;
  securityVersion?: number;
  reactivateEmergencyId?: string;
  authDisabled?: boolean;
  refreshRevoked?: boolean;
  disabledByEmergency?: boolean;
  authDispatchCutoff?: number;
  authAcknowledged?: boolean;
  baseProfileVersion: number;
  createdAt: string;
  failure?: string | null;
};

interface ProfileReader {
  get(uid: string): Promise<Profile | null>;
  list(): Promise<ProfileRecord[]>;
  emailOwner(email: string): Promise<string | null>;
  operation(id: string): Promise<CredentialOperation | null>;
}
export interface ProfileTransaction extends ProfileReader {
  create(profile: Profile): void;
  update(uid: string, changes: Partial<Profile>): void;
  setEmailOwner(email: string, uid: string | null): void;
  createOperation(operation: CredentialOperation): void;
  updateOperation(id: string, changes: Partial<CredentialOperation>): void;
  audit(actor: CredentialOperation['actor'], target: Profile, type: 'REGISTRO' | 'MODIFICACIÓN', detail: string, previous?: Profile, eventId?: string): void;
}
export interface ProfileStore extends ProfileReader {
  transaction<T>(work: (tx: ProfileTransaction) => Promise<T>): Promise<T>;
  outstandingOperations(uid: string): Promise<CredentialOperation[]>;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status: number, code: string, message: string): never {
  throw new AuthError(status, code, message);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function emailKey(email?: string): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function validUid(uid: string): boolean {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 &&
    !uid.includes('/') && uid !== '.' && uid !== '..';
}

function isTemporary(uid: string, profile: Profile): boolean {
  const legacyId = PENDING_PREFIX + createHash('sha1').update(emailKey(profile.email)).digest('hex').slice(0, 24);
  return uid.startsWith(PENDING_PREFIX) && profile.uid === uid &&
    (profile.pendingLink === true || uid === legacyId);
}

function allowsProvider(method: AuthMethod | undefined, provider: string): boolean {
  return (provider === 'password' && (method === undefined || method === 'password' || method === 'both')) ||
    (provider === 'google.com' && (method === 'google' || method === 'both'));
}

export function requireProfile(profile: Profile | null, uid: string, identity: Identity): Profile {
  if (!profile) fail(403, 'PROFILE_NOT_FOUND', 'Su cuenta no está autorizada en el sistema.');
  if (profile.uid !== uid || profile.linkedUid || uid.startsWith(PENDING_PREFIX) || profile.provisioning) {
    fail(403, 'PROFILE_UID_MISMATCH', 'El perfil no corresponde a una identidad habilitada.');
  }
  if (profile.active !== true) fail(403, 'USER_INACTIVE', 'Su cuenta ha sido desactivada.');
  if (!ROLES.includes(profile.role)) fail(403, 'INVALID_ROLE', 'El rol de su cuenta no es válido.');
  if (!allowsProvider(profile.authMethod, identity.firebase.sign_in_provider)) {
    fail(403, 'PROVIDER_NOT_ALLOWED', 'El método de acceso no está autorizado para este perfil.');
  }
  if (identity.auth_time <= (profile.sessionValidAfter ?? 0)) {
    fail(401, 'SESSION_REVOKED', 'La sesión fue revocada. Inicie sesión nuevamente.');
  }
  return profile;
}

function requireAdminProfile(profile: Profile | null, caller: Session): Profile {
  const actor = requireProfile(profile, caller.uid, caller.identity);
  if (actor.role !== 'Administrador') {
    fail(403, 'FORBIDDEN_ROLE', 'Se requiere el rol de Administrador.');
  }
  return actor;
}

function ownsProfileReservation(profile: Profile): boolean {
  return !profile.linkedUid && (!profile.provisioning || profile.provisioning.state !== 'cancelled');
}

function ownersOf(records: ProfileRecord[], email: string): ProfileRecord[] {
  return records.filter(({ profile }) => ownsProfileReservation(profile) &&
    (emailKey(profile.email) === email || emailKey(profile.pendingEmail || undefined) === email));
}

function checkDuplicate(records: ProfileRecord[], email?: string, dni?: string, exceptUid?: string): void {
  if (email && ownersOf(records, email).some(({ id }) => id !== exceptUid)) {
    fail(409, 'DUPLICATE_EMAIL', 'El correo ya está reservado por otro perfil.');
  }
  if (dni && records.some(({ id, profile }) => id !== exceptUid && ownsProfileReservation(profile) && profile.dni?.trim() === dni)) {
    fail(409, 'DUPLICATE_DNI', 'El DNI ya está reservado por otro perfil.');
  }
}

function readTarget(profile: Profile | null, uid: string): Profile {
  if (!profile || profile.linkedUid || profile.provisioning) {
    fail(404, 'PROFILE_NOT_FOUND', 'El perfil de usuario no está disponible.');
  }
  if (profile.uid !== uid || (uid.startsWith(PENDING_PREFIX) && !isTemporary(uid, profile))) {
    fail(409, 'PROFILE_UID_MISMATCH', 'El UID almacenado no corresponde al documento.');
  }
  return profile;
}

function readProfileInput(body: Record<string, unknown>, old?: Profile) {
  const field = (key: string, fallback: string, max: number) => {
    const value = body[key] ?? fallback;
    if (typeof value !== 'string' || value.trim().length > max) {
      fail(400, 'INVALID_PROFILE', `El campo ${key} no es válido.`);
    }
    return value.trim();
  };
  const displayName = field('displayName', old?.displayName ?? '', 150);
  const email = emailKey(field('email', old?.email ?? '', 254));
  const dni = field('dni', old?.dni ?? '', 32);
  const role = field('role', old?.role ?? '', 50) as OfficialRole;
  const authMethod = field('authMethod', old?.authMethod ?? 'password', 20) as AuthMethod;
  const active = body.active ?? old?.active ?? true;
  if (displayName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !ROLES.includes(role) || !['password', 'google', 'both'].includes(authMethod) ||
      typeof active !== 'boolean') {
    fail(400, 'INVALID_PROFILE', 'Verifique el nombre, correo, rol, método de acceso y estado.');
  }
  return { email, displayName, dni, role, authMethod, active };
}

type ProfileInput = ReturnType<typeof readProfileInput>;

const EDITABLE_PROFILE_FIELDS = ['email', 'displayName', 'dni', 'role', 'active', 'authMethod'] as const satisfies readonly (keyof ProfileInput)[];
// Retain the v1 journal digest for exact replays of requests created before role-only access.
const PROFILE_REQUEST_FIELDS = [...EDITABLE_PROFILE_FIELDS, 'assignedProject', 'assignedProjects', 'assignedSectorIds', 'assignedGalponIds'] as const;

function fingerprintRequest(kind: CredentialOperation['kind'], uid: string, actorUid: string,
  expectedVersion: number, body: Record<string, unknown>, secretSource?: 'provided' | 'generated') {
  const fields = PROFILE_REQUEST_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(body, field)).map(field => {
    const value = body[field];
    return [field, field === 'email' && typeof value === 'string' ? emailKey(value) : value];
  });
  // Fixed key order; array order and the presence of fields are part of the edit.
  return createHash('sha256').update(JSON.stringify([1, kind, uid, actorUid, expectedVersion, fields, secretSource])).digest('hex');
}

function passwordDigest(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, 'hex'), 32,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    }));
}

function containmentEditId(id: string) {
  const hex = createHash('sha256').update(JSON.stringify(['calera-emergency', id, 'profile'])).digest('hex');
  return hex.replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, '$1-$2-8$3-8$4-$5');
}

function matchesInput(profile: Profile, input: ProfileInput): boolean {
  return (Object.keys(input) as (keyof ProfileInput)[]).every(key =>
    JSON.stringify(input[key]) === JSON.stringify(profile[key]));
}

function publicProfile(profile: Profile): UserProfile {
  const createdAt = profile.createdAt || profile.updatedAt || new Date().toISOString();
  return {
    uid: profile.uid, email: emailKey(profile.email), displayName: profile.displayName || profile.uid,
    dni: profile.dni || '', authMethod: profile.authMethod || 'password',
    role: profile.role, active: profile.active === true, profileVersion: profile.profileVersion ?? 0,
    credentialVersion: profile.credentialVersion ?? 0,
    createdAt, createdBy: profile.createdBy || 'system',
    updatedAt: profile.updatedAt || createdAt, updatedBy: profile.updatedBy || 'system',
    ...(profile.lastLoginAt ? { lastLoginAt: profile.lastLoginAt } : {})
  };
}

export function createAuthService(
  identity: IdentityProvider,
  profiles: ProfileStore
) {
  async function authenticate(authorization?: string): Promise<Identity> {
    const token = /^Bearer ([^\s]+)$/i.exec(authorization ?? '')?.[1];
    if (!token) fail(401, 'MISSING_TOKEN', 'Se requiere un token de sesión Firebase.');
    let verified: Identity;
    try {
      verified = await identity.verifyIdToken(token, true);
    } catch (error) {
      return rejectUnverifiedSession(error);
    }
    if (!validUid(verified.uid) || verified.uid.startsWith(PENDING_PREFIX) || !verified.firebase || verified.firebase.tenant ||
        !Number.isSafeInteger(verified.auth_time) || verified.auth_time <= 0) {
      fail(401, 'INVALID_TOKEN', 'La identidad de Firebase no es válida para este proyecto.');
    }
    return verified;
  }

  function rejectUnverifiedSession(error: unknown): never {
    const code = errorCode(error);
    if (code === 'auth/id-token-revoked') fail(401, 'TOKEN_REVOKED', 'La sesión de Firebase fue revocada.');
    if (['auth/argument-error', 'auth/invalid-argument', 'auth/invalid-id-token', 'auth/id-token-expired',
      'auth/user-disabled', 'auth/user-not-found'].includes(code ?? '')) {
      fail(401, 'INVALID_TOKEN', 'La sesión de Firebase no es válida o ha expirado.');
    }
    fail(503, 'AUTHORIZATION_UNAVAILABLE', 'No se pudo comprobar la vigencia de la sesión en Firebase Authentication. Intente nuevamente.');
  }

  async function requireAdmin(authorization?: string) {
    const token = await authenticate(authorization);
    const caller: Session = { uid: token.uid, identity: token };
    return { caller, actor: await adminIn(profiles, caller) };
  }

  async function adminIn(reader: ProfileReader, caller: Session) {
    return requireAdminProfile(await reader.get(caller.uid), caller);
  }

  async function currentProfile(authorization?: string) {
    const caller = await authenticate(authorization);
    return publicProfile(requireProfile(await profiles.get(caller.uid), caller.uid, caller));
  }

  async function verifySession(authorization?: string): Promise<UserProfile> {
    const caller = await authenticate(authorization);
    const uid = caller.uid;
    const direct = await profiles.get(uid);
    const email = emailKey(caller.email);
    const provider = caller.firebase.sign_in_provider;
    if (direct) {
      requireProfile(direct, uid, caller);
    } else {
      if (!email || caller.email_verified !== true || !['google.com', 'password'].includes(provider)) {
        fail(403, 'PROFILE_NOT_FOUND', 'Su cuenta no está autorizada en el sistema.');
      }
      const account = await lookupAccount(email);
      if (!account || account.uid !== uid || account.disabled || account.emailVerified !== true || emailKey(account.email) !== email) {
        fail(403, 'IDENTITY_MISMATCH', 'La identidad actual de Firebase no coincide con la sesión.');
      }
    }
    const now = new Date().toISOString();
    return profiles.transaction(async tx => {
      const current = await tx.get(uid);
      if (current || direct) {
        const profile = requireProfile(current, uid, caller);
        const login = { lastLoginAt: now };
        tx.update(uid, login);
        return publicProfile({ ...profile, ...login });
      }
      const owner = await tx.emailOwner(email);
      const profile = owner ? await tx.get(owner) : null;
      if (!owner || !profile || !ownsProfileReservation(profile) || !isTemporary(owner, profile) || emailKey(profile.email) !== email ||
          !allowsProvider(profile.authMethod, provider) ||
          profile.active !== true || !ROLES.includes(profile.role)) {
        fail(403, 'PROFILE_NOT_FOUND', 'Su cuenta no está autorizada en el sistema.');
      }
      const linked: Profile = {
        ...publicProfile(profile), uid, lastLoginAt: now, updatedAt: now, updatedBy: uid
      };
      tx.create(linked);
      tx.update(owner, { linkedUid: uid });
      tx.setEmailOwner(email, uid);
      tx.audit(linked, linked, 'REGISTRO', 'Vinculación verificada de un perfil temporal.', profile);
      return linked;
    });
  }

  async function listUsers(authorization?: string): Promise<UserProfile[]> {
    await requireAdmin(authorization);
    return (await profiles.list())
      .filter(({ id, profile }) => id === profile.uid && !profile.linkedUid && !profile.provisioning)
      .map(({ profile }) => publicProfile(profile))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async function lookupAccount(email: string): Promise<Account | null> {
    try {
      return await identity.getUserByEmail(email);
    } catch (error) {
      if (errorCode(error) === 'auth/user-not-found') return null;
      throw error;
    }
  }

  async function accountByUid(uid: string): Promise<Account | null> {
    try {
      const account = await identity.getUser(uid);
      if (account.uid !== uid) fail(409, 'AUTH_IDENTITY_CONFLICT', 'Firebase devolvió otro UID.');
      return account;
    } catch (error) {
      if (errorCode(error) === 'auth/user-not-found') return null;
      throw error;
    }
  }

  async function checkEmailOwner(reader: ProfileReader, email: string, uid?: string) {
    const owner = await reader.emailOwner(email);
    if (owner && owner !== uid) {
      fail(409, 'DUPLICATE_EMAIL', 'El correo está reservado por otro perfil.');
    }
  }

  function canManageReservation(actor: Profile, reservation: Profile) {
    if (reservation.createdBy !== actor.uid && actor.uid !== PRIMARY_ADMIN_UID) {
      fail(403, 'RESERVATION_OWNER_REQUIRED', 'La reserva requiere al administrador que la creó o al principal.');
    }
  }

  function checkedPassword(value: unknown) {
    if (typeof value !== 'string' || value.length < 20 || value.length > 4096 ||
        !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9\s]/.test(value)) {
      fail(400, 'INVALID_PASSWORD', 'Use al menos 20 caracteres con mayúsculas, minúsculas, números y símbolos.');
    }
    return value;
  }

  async function createUser(authorization: string | undefined, body: Record<string, unknown>): Promise<UserProfile> {
    const { caller } = await requireAdmin(authorization);
    const input = readProfileInput(body);
    const googleOnly = input.authMethod === 'google';
    const password = googleOnly ? undefined : checkedPassword(body.password);
    const account = googleOnly ? null : await lookupAccount(input.email);
    const reserved = await profiles.transaction(async tx => {
      const actor = await adminIn(tx, caller);
      const records = await tx.list();
      const previous = ownersOf(records, input.email);
      const retry = previous.length === 1 ? previous[0] : undefined;
      if (!googleOnly && retry?.profile.provisioning && retry.id === retry.profile.uid &&
          retry.profile.createdBy === actor.uid &&
          matchesInput({ ...retry.profile, active: retry.profile.provisioning.active }, input)) {
        if (account && account.uid !== retry.id) {
          fail(409, 'AUTH_EMAIL_EXISTS', 'El correo pertenece a otra cuenta de Firebase.');
        }
        await checkEmailOwner(tx, input.email, retry.id);
        return retry.profile;
      }
      checkDuplicate(records, input.email, input.dni);
      await checkEmailOwner(tx, input.email);
      if (account) fail(409, 'AUTH_EMAIL_EXISTS', 'El correo ya pertenece a una cuenta de Firebase.');
      const now = new Date().toISOString();
      const profile: Profile = {
        ...input, uid: googleOnly ? PENDING_PREFIX + randomUUID() : randomUUID(),
        createdAt: now, createdBy: actor.uid, updatedAt: now, updatedBy: actor.uid,
        ...(googleOnly ? { pendingLink: true } : {
          active: false, provisioning: {
            active: input.active, state: 'ready', expiresAt: new Date(Date.now() + 86400_000).toISOString()
          }
        })
      };
      tx.create(profile);
      tx.setEmailOwner(input.email, profile.uid);
      tx.audit(actor, profile, 'REGISTRO', googleOnly
        ? 'Preautorización de acceso con Google.' : 'Reserva para alta de identidad Firebase.');
      return profile;
    });
    if (googleOnly) return publicProfile(reserved);
    return (await resumeProvisioning(caller, reserved.uid, password)).user;
  }

  async function resumeProvisioning(caller: Session, uid: string, password?: string) {
    const reserved = await profiles.get(uid);
    if (!reserved || reserved.provisioning === undefined || reserved.uid !== uid ||
        (reserved.provisioning && reserved.provisioning.state === 'cancelled')) {
      fail(404, 'RESERVATION_NOT_FOUND', 'La reserva de alta no está disponible.');
    }
    canManageReservation(await adminIn(profiles, caller), reserved);
    if (reserved.provisioning === false) return { user: publicProfile(reserved), passwordApplied: false };
    let created = await accountByUid(uid);
    let passwordApplied = false;
    if (!created) {
      const emailAccount = await lookupAccount(emailKey(reserved.email));
      if (emailAccount && emailAccount.uid !== uid) {
        fail(409, 'AUTH_EMAIL_EXISTS', 'El correo pertenece a otro UID de Firebase.');
      }
      if (emailAccount) created = emailAccount;
    }
    if (!created) {
      if (!['ready', 'rejected'].includes(reserved.provisioning.state)) {
        fail(409, 'PROVISIONING_UNCERTAIN', 'El alta está en curso o requiere reconciliación por UID.');
      }
      const secret = checkedPassword(password);
      await profiles.transaction(async tx => {
        const actor = await adminIn(tx, caller);
        const current = await tx.get(uid);
        if (!current?.provisioning || !['ready', 'rejected'].includes(current.provisioning.state)) {
          fail(409, 'PROVISIONING_UNCERTAIN', 'El alta está en curso o requiere reconciliación por UID.');
        }
        canManageReservation(actor, current);
        await checkEmailOwner(tx, emailKey(current.email), uid);
        tx.update(uid, { provisioning: { ...current.provisioning, state: 'dispatching' } });
      });
      try {
        created = await identity.createUser({
          uid, email: emailKey(reserved.email), displayName: reserved.displayName, password: secret
        });
        passwordApplied = true;
      } catch (error) {
        created = await accountByUid(uid).catch(() => null);
        if (!created) {
          const definitive = error instanceof MutationRejected;
          await profiles.transaction(async tx => {
            const current = await tx.get(uid);
            if (current?.provisioning && current.provisioning.state === 'dispatching') {
              tx.update(uid, { provisioning: { ...current.provisioning, state: definitive ? 'rejected' : 'uncertain' } });
            }
          });
          fail(definitive ? 409 : 503, definitive ? 'PROVISIONING_REJECTED' : 'PROVISIONING_UNCERTAIN',
            'El alta requiere revisión en el listado de reservas.');
        }
      }
    }
    if (created.uid !== uid || emailKey(created.email) !== emailKey(reserved.email) || created.disabled) {
      fail(409, 'AUTH_IDENTITY_CONFLICT', 'No se pudo confirmar la identidad reservada en Firebase.');
    }
    const user = await profiles.transaction(async tx => {
      const admin = await adminIn(tx, caller);
      const current = await tx.get(uid);
      if (!current || current.uid !== created.uid || emailKey(current.email) !== emailKey(reserved.email)) {
        fail(409, 'PROFILE_UID_MISMATCH', 'La identidad reservada ya no corresponde al perfil.');
      }
      canManageReservation(admin, current);
      await checkEmailOwner(tx, emailKey(current.email), uid);
      if (current.provisioning) {
        if (current.provisioning.state === 'cancelled') fail(409, 'RESERVATION_CANCELLED', 'La reserva fue cancelada.');
        const completed: Profile = { ...current, active: current.provisioning.active, provisioning: false };
        tx.update(current.uid, { active: completed.active, provisioning: false });
        tx.audit(admin, completed, 'REGISTRO', 'Creación de usuario con identidad Firebase confirmada.');
        return publicProfile(completed);
      }
      return publicProfile(current);
    });
    return { user, passwordApplied };
  }

  async function listReservations(authorization?: string) {
    const { actor } = await requireAdmin(authorization);
    return (await profiles.list()).flatMap(({ profile }) => {
      const reservation = profile.provisioning;
      if (!reservation || reservation.state === 'cancelled') return [];
      return [{
        uid: profile.uid, email: profile.email, displayName: profile.displayName, ...reservation,
        manageable: profile.createdBy === actor.uid || actor.uid === PRIMARY_ADMIN_UID
      }];
    });
  }

  async function manageReservation(authorization: string | undefined, uid: string, body: Record<string, unknown>) {
    const { caller, actor } = await requireAdmin(authorization);
    if (!validUid(uid)) fail(400, 'INVALID_UID', 'El UID no es válido.');
    if (body.action === 'resume') {
      return resumeProvisioning(caller, uid, typeof body.password === 'string' ? body.password : undefined);
    }
    if (body.action !== 'cancel') fail(400, 'INVALID_ACTION', 'Indique reanudar o cancelar.');
    const reservation = await profiles.get(uid);
    if (!reservation?.provisioning) fail(404, 'RESERVATION_NOT_FOUND', 'La reserva de alta no está disponible.');
    canManageReservation(actor, reservation);
    if (reservation.provisioning.state === 'cancelled') return { cancelled: true };
    if (await accountByUid(uid) || await lookupAccount(emailKey(reservation.email))) {
      fail(409, 'AUTH_ACCOUNT_EXISTS', 'Existe una cuenta en Firebase. La reserva requiere revisión por UID.');
    }
    return profiles.transaction(async tx => {
      const admin = await adminIn(tx, caller);
      const current = await tx.get(uid);
      const state = current?.provisioning;
      if (!current || !state) fail(404, 'RESERVATION_NOT_FOUND', 'La reserva de alta no está disponible.');
      canManageReservation(admin, current);
      if (state.state === 'cancelled') return { cancelled: true };
      if (!['ready', 'rejected'].includes(state.state) || state.expiresAt > new Date().toISOString()) {
        fail(409, 'RESERVATION_NOT_CANCELLABLE', 'Solo se cancela una reserva vencida sin una mutación incierta.');
      }
      const email = emailKey(current.email);
      await checkEmailOwner(tx, email, uid);
      tx.update(uid, { provisioning: { ...state, state: 'cancelled' }, active: false });
      tx.setEmailOwner(email, null);
      tx.audit(admin, current, 'MODIFICACIÓN', 'Cancelación de reserva vencida tras comprobar Firebase Auth.');
      return { cancelled: true };
    });
  }

  function operationId(value: unknown): string {
    if (value === undefined) return randomUUID();
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) {
      fail(400, 'INVALID_OPERATION_ID', 'El identificador de la operación debe ser un UUID.');
    }
    return value.toLowerCase();
  }

  function protectPrimary(actor: Profile, uid: string, credentialChange: boolean) {
    if (uid === PRIMARY_ADMIN_UID && actor.uid !== uid && credentialChange) {
      fail(403, 'PROTECTED_ADMIN', 'Solo el administrador principal puede cambiar sus credenciales.');
    }
  }

  function canManageOperation(actor: Profile, operation: CredentialOperation) {
    protectPrimary(actor, operation.uid, operation.kind !== 'profile' && !isPrimaryReactivation(operation));
    if (operation.kind !== 'emergency' && operation.actor.uid !== actor.uid && actor.uid !== PRIMARY_ADMIN_UID) {
      fail(403, 'OPERATION_OWNER_REQUIRED', 'La operación requiere al administrador que la inició o al principal.');
    }
  }

  function isPrimaryReactivation(operation: CredentialOperation) {
    return operation.kind === 'active' && operation.changes?.active === true && !operation.newEmail;
  }

  function newOperation(id: string, actor: Profile, current: Profile, kind: CredentialOperation['kind']): CredentialOperation {
    return {
      id, uid: current.uid, version: (current.credentialVersion ?? 0) + 1,
      actor: { uid: actor.uid, displayName: actor.displayName, email: actor.email, role: actor.role },
      kind, state: 'pending', authentication: 'ready', audit: 'pending', oldEmail: emailKey(current.email),
      baseProfileVersion: current.profileVersion ?? 0,
      securityVersion: current.securityVersion ?? 0,
      createdAt: new Date().toISOString()
    };
  }

  async function reserveEmergency(caller: Session, uid: string, id: string, body: Record<string, unknown>, expected?: number,
    edit?: Record<string, unknown>) {
    if (!validUid(uid)) fail(400, 'INVALID_UID', 'El UID no es válido.');
    return profiles.transaction(async tx => {
      const admin = await adminIn(tx, caller);
      if (uid === admin.uid || uid === PRIMARY_ADMIN_UID) {
        fail(403, 'PROTECTED_ADMIN', 'No se puede desactivar esta cuenta administrativa.');
      }
      const previous = await tx.operation(id);
      const child = edit ? await tx.operation(containmentEditId(id)) : null;
      if (previous) {
        assertSameRequest(previous, fingerprintRequest('emergency', uid, admin.uid, expected ?? previous.baseProfileVersion, body));
        if (child) assertDerivedEdit(child, previous, edit!);
        return { operation: previous };
      }
      if (child) fail(409, 'OPERATION_ID_CONFLICT', 'El identificador corresponde a otra operación.');
      const target = readTarget(await tx.get(uid), uid);
      if (isTemporary(uid, target)) fail(409, 'PROFILE_NOT_LINKED', 'El perfil todavía no está vinculado a Authentication.');
      if (expected !== undefined && expected !== (target.profileVersion ?? 0)) {
        fail(409, 'STALE_PROFILE_VERSION', 'El perfil cambió. Actualice el formulario o use la desactivación de emergencia.');
      }
      const pending = target.emergencyOperationId ? await tx.operation(target.emergencyOperationId) : null;
      if (pending?.state === 'pending') fail(409, 'EMERGENCY_PENDING', 'La cuenta ya está bloqueada. Consulte Operaciones.');
      // Require Auth evidence newer than sessions that could already exist in this same second.
      const cutoff = Math.max((target.sessionValidAfter ?? 0) + 1, epoch() + 1);
      const operation: CredentialOperation = {
        ...newOperation(id, admin, target, 'emergency'),
        version: (target.profileVersion ?? 0) + 1, securityVersion: (target.securityVersion ?? 0) + 1,
        fingerprint: fingerprintRequest('emergency', uid, admin.uid, expected ?? target.profileVersion ?? 0, body),
        sessionCutoff: cutoff, profileApplied: true, authDisabled: false, refreshRevoked: false,
        disabledByEmergency: pending?.disabledByEmergency === true
      };
      tx.createOperation(operation);
      tx.update(uid, {
        active: false, sessionValidAfter: cutoff, emergencyOperationId: id,
        profileVersion: operation.version, securityVersion: operation.securityVersion,
        updatedAt: new Date().toISOString(), updatedBy: admin.uid
      });
      return { operation, target };
    });
  }

  async function emergencyDisable(authorization: string | undefined, uid: string, body: Record<string, unknown>) {
    const { caller } = await requireAdmin(authorization);
    if (uid === caller.uid || uid === PRIMARY_ADMIN_UID) fail(403, 'PROTECTED_ADMIN', 'No se puede desactivar esta cuenta administrativa.');
    if (body.operationId === undefined) fail(400, 'OPERATION_ID_REQUIRED', 'Se requiere un UUID para desactivar la cuenta.');
    const reserved = await reserveEmergency(caller, uid, operationId(body.operationId), { active: false });
    return viewCredentialResult(await runEmergency(caller, reserved.operation));
  }

  function assertUnlocked(profile: Profile) {
    if (profile.credentialOperationId || profile.pendingEmail || profile.sessionOperationId) {
      fail(409, 'CREDENTIAL_OPERATION_PENDING', 'Ya existe una operación de credenciales pendiente para este UID.');
    }
  }

  function assertSameRequest(operation: CredentialOperation, fingerprint: string) {
    if (operation.fingerprint !== fingerprint) {
      fail(409, 'OPERATION_ID_CONFLICT', 'El identificador corresponde a otra solicitud. Consulte Operaciones.');
    }
  }

  function assertDerivedEdit(operation: CredentialOperation, root: CredentialOperation, body: Record<string, unknown>) {
    if (root.kind !== 'emergency' || operation.id !== containmentEditId(root.id) || operation.parentOperationId !== root.id ||
        operation.uid !== root.uid || operation.actor.uid !== root.actor.uid ||
        operation.baseProfileVersion !== root.version || !['email', 'profile'].includes(operation.kind) ||
        !['pending', 'completed', 'failed'].includes(operation.state)) {
      fail(409, 'OPERATION_ID_CONFLICT', 'El identificador corresponde a otra operación.');
    }
    assertSameRequest(operation, fingerprintRequest(operation.kind, root.uid, root.actor.uid, root.version, body));
  }

  function reserveSessionOperation(tx: ProfileTransaction, id: string, admin: Profile, target: Profile,
    kind: 'active' | 'sessions', fingerprint: string, changes?: ProfileInput, newEmail?: string,
    reactivateEmergencyId?: string) {
    if (target.sessionOperationId) {
      fail(409, 'CREDENTIAL_OPERATION_PENDING', 'Ya existe un cambio de sesiones pendiente para este UID.');
    }
    const cutoff = Math.max((target.sessionValidAfter ?? 0) + 1, epoch());
    // Deactivate immediately, even if a previous credential change is still in flight.
    // Activation (and an edit that also changes email) waits for the provider confirmation.
    const applyNow = kind === 'sessions' || (!newEmail && changes?.active === false);
    const revision = (target.profileVersion ?? 0) + 1;
    const operation: CredentialOperation = {
      ...newOperation(id, admin, target, kind), version: revision, fingerprint,
      sessionCutoff: cutoff, profileApplied: applyNow,
      ...(changes ? { changes } : {}), ...(newEmail ? { newEmail } : {}),
      ...(reactivateEmergencyId ? { reactivateEmergencyId } : {})
    };
    tx.createOperation(operation);
    if (newEmail) tx.setEmailOwner(newEmail, target.uid);
    tx.update(target.uid, {
      sessionOperationId: id,
      ...(newEmail ? { pendingEmail: newEmail } : {}),
      ...(applyNow ? {
        ...changes, sessionValidAfter: cutoff, profileVersion: revision,
        updatedBy: admin.uid, updatedAt: new Date().toISOString()
      } : {})
    });
    return operation;
  }

  async function compatibleMethods(uid: string): Promise<AuthMethod[]> {
    const account = await accountByUid(uid);
    const providers = account?.providerData?.map(p => p.providerId) ?? [];
    const methods: AuthMethod[] = ['password', 'google', 'both'];
    return methods.filter(method => providers.some(provider => allowsProvider(method, provider)));
  }

  async function listAuthMethods(authorization: string | undefined, uid: string) {
    const { actor } = await requireAdmin(authorization);
    if (!validUid(uid)) fail(400, 'INVALID_UID', 'El UID no es válido.');
    const target = readTarget(await profiles.get(uid), uid);
    if (isTemporary(uid, target) || (uid === PRIMARY_ADMIN_UID && uid !== actor.uid)) {
      return [target.authMethod ?? 'password'];
    }
    return compatibleMethods(uid);
  }

  async function updateUser(authorization: string | undefined, uid: string, body: Record<string, unknown>, parent?: CredentialOperation) {
    if (!validUid(uid)) fail(400, 'INVALID_UID', 'El UID no es válido.');
    const { caller, actor } = await requireAdmin(authorization);
    if (body.active === false && (uid === caller.uid || uid === PRIMARY_ADMIN_UID)) {
      fail(403, 'PROTECTED_ADMIN', 'No se puede desactivar esta cuenta administrativa.');
    }
    const expectedVersion = body.expectedProfileVersion;
    const validVersion = typeof expectedVersion === 'number' && Number.isSafeInteger(expectedVersion) && expectedVersion >= 0;
    const id = body.operationId === undefined ? undefined : operationId(body.operationId);
    const replay = id ? await profiles.operation(id) : null;
    const preflight = replay ? null : readTarget(await profiles.get(uid), uid);
    if (body.active === false && validVersion &&
        (replay?.kind === 'emergency' || (preflight?.active && !isTemporary(uid, preflight)))) {
      if (!id) fail(400, 'OPERATION_ID_REQUIRED', 'Se requiere un UUID para desactivar la cuenta.');
      const edit = Object.fromEntries(PROFILE_REQUEST_FIELDS
        .filter(field => field !== 'active' && Object.prototype.hasOwnProperty.call(body, field))
        .map(field => [field, body[field]]));
      const editId = containmentEditId(id);
      const hasEdit = Object.keys(edit).length > 0;
      const reserved = await reserveEmergency(caller, uid, id, body, expectedVersion, hasEdit ? edit : undefined);
      const blocked = await runEmergency(caller, reserved.operation);
      const response = {
        ...viewCredentialResult(blocked),
        ...(body.tempPassword !== undefined || body.password !== undefined ? { passwordRequiresSeparateRequest: true } : {})
      };
      if (!hasEdit) return response;
      if (!reserved.target) {
        const previous = await profiles.operation(editId);
        if (previous) assertDerivedEdit(previous, reserved.operation, edit);
        return { ...response, profileEdit: { id: editId, state: previous?.state ?? 'review' } };
      }
      try {
        if (JSON.stringify(readProfileInput(edit, reserved.target)) === JSON.stringify(readProfileInput({}, reserved.target))) {
          return response;
        }
        const updated = await updateUser(authorization, uid, {
          ...edit, expectedProfileVersion: reserved.operation.version, operationId: editId
        }, reserved.operation);
        return {
          ...response, user: updated.user, profileRefreshRequired: updated.profileRefreshRequired,
          profileEdit: { id: editId, state: updated.operation?.state ?? 'completed' }
        };
      } catch (error) {
        if (error instanceof AuthError && error.code === 'OPERATION_ID_CONFLICT') throw error;
        return {
          ...response, profileEdit: {
            id: editId, state: error instanceof AuthError ? 'failed' : 'review',
            ...(error instanceof AuthError ? { code: error.code } : {})
          }
        };
      }
    }
    const checkMethod = preflight && (preflight.profileVersion ?? 0) === expectedVersion && body.authMethod !== undefined &&
      body.authMethod !== (preflight.authMethod ?? 'password') && !isTemporary(uid, preflight);
    let methodAllowed = false;
    if (checkMethod) {
      protectPrimary(actor, uid, true);
      methodAllowed = (await compatibleMethods(uid)).some(value => value === body.authMethod);
    }
    const change = await profiles.transaction(async tx => {
      const admin = await adminIn(tx, caller);
      const previous = id ? await tx.operation(id) : null;
      if (previous) {
        if (!validVersion || !['email', 'active', 'profile'].includes(previous.kind) ||
            previous.parentOperationId !== parent?.id) {
          fail(409, 'OPERATION_ID_CONFLICT', 'El identificador corresponde a otra operación.');
        }
        assertSameRequest(previous, fingerprintRequest(previous.kind, uid, admin.uid, expectedVersion, body));
        canManageOperation(admin, previous);
        return { operation: previous };
      }
      if (!validVersion) fail(400, 'INVALID_PROFILE_VERSION', 'Se requiere la versión del perfil que se cargó para editar.');
      const current = readTarget(await tx.get(uid), uid);
      if ((current.profileVersion ?? 0) !== expectedVersion) {
        fail(409, 'STALE_PROFILE_VERSION', 'El perfil cambió desde que se abrió. Actualice la lista y vuelva a abrir el formulario.');
      }
      const input = readProfileInput(body, current);
      if ((uid === caller.uid || uid === PRIMARY_ADMIN_UID) && (!input.active || input.role !== 'Administrador')) {
        fail(403, 'PROTECTED_ADMIN', 'No se puede desactivar o degradar este administrador.');
      }
      const emailChanged = input.email !== emailKey(current.email);
      const dniChanged = input.dni !== (current.dni || '').trim();
      const methodChanged = input.authMethod !== (current.authMethod ?? 'password');
      const activeChanged = input.active !== current.active;
      protectPrimary(admin, uid, emailChanged || methodChanged);
      const temporary = isTemporary(uid, current);
      if (temporary && methodChanged) {
        fail(409, 'TEMPORARY_AUTH_METHOD', 'El método de acceso se puede cambiar después de vincular el perfil.');
      }
      if (methodChanged && !methodAllowed) {
        fail(409, 'AUTH_METHOD_UNAVAILABLE', 'Firebase no tiene un proveedor compatible con el método solicitado.');
      }
      if (emailChanged || methodChanged || (activeChanged && input.active)) assertUnlocked(current);
      const oldEmail = emailKey(current.email);
      const previousOwner = emailChanged ? await tx.emailOwner(oldEmail) : null;
      if (emailChanged || dniChanged || temporary) {
        checkDuplicate(await tx.list(), emailChanged || temporary ? input.email : undefined, dniChanged ? input.dni : undefined, uid);
      }
      if (emailChanged || temporary) await checkEmailOwner(tx, input.email, uid);
      if (activeChanged && !temporary) {
        if (!id) fail(400, 'OPERATION_ID_REQUIRED', 'Se requiere un UUID para cambiar el estado de la cuenta.');
        let reactivateEmergencyId: string | undefined;
        if (input.active && current.emergencyOperationId) {
          const emergency = await tx.operation(current.emergencyOperationId);
          if (emergency?.state !== 'completed') {
            fail(409, 'EMERGENCY_PENDING', 'Reconcilie la desactivación en Authentication antes de reactivar.');
          }
          if (!emergency.disabledByEmergency) {
            fail(409, 'AUTH_DISABLED_EXTERNALLY', 'Authentication ya estaba deshabilitado fuera de esta operación.');
          }
          reactivateEmergencyId = emergency.id;
        }
        const operation = reserveSessionOperation(tx, id, admin, current, 'active',
          fingerprintRequest('active', uid, admin.uid, expectedVersion, body), input,
          emailChanged ? input.email : undefined, reactivateEmergencyId);
        return { operation };
      }
      if (emailChanged && !temporary) {
        if (!id) fail(400, 'OPERATION_ID_REQUIRED', 'Se requiere un UUID para cambiar el correo.');
        const operation: CredentialOperation = {
          ...newOperation(id, admin, current, 'email'), newEmail: input.email, changes: input,
          ...(parent ? { parentOperationId: parent.id } : {}),
          fingerprint: fingerprintRequest('email', uid, admin.uid, expectedVersion, body)
        };
        tx.createOperation(operation);
        tx.setEmailOwner(input.email, uid);
        tx.update(uid, { credentialVersion: operation.version, credentialOperationId: id, pendingEmail: input.email });
        return { operation };
      }
      const changes: Partial<Profile> = {
        ...input, updatedAt: new Date().toISOString(), updatedBy: caller.uid,
        profileVersion: (current.profileVersion ?? 0) + 1,
        ...(temporary ? { pendingLink: true } : {})
      };
      if (methodChanged) changes.sessionValidAfter = Math.max(current.sessionValidAfter ?? 0, epoch());
      const updated = { ...current, ...changes };
      tx.update(uid, changes);
      if (temporary) {
        tx.setEmailOwner(input.email, uid);
        if (emailChanged && previousOwner === uid) tx.setEmailOwner(oldEmail, null);
      }
      const operation: CredentialOperation | undefined = id ? {
        ...newOperation(id, admin, current, 'profile'), version: changes.profileVersion!,
        ...(parent ? { parentOperationId: parent.id } : {}),
        fingerprint: fingerprintRequest('profile', uid, admin.uid, expectedVersion, body),
        state: 'completed', authentication: 'not_required', audit: 'recorded'
      } : undefined;
      if (operation) tx.createOperation(operation);
      tx.audit(admin, updated, 'MODIFICACIÓN', 'Actualización de perfil.', current, id);
      return { updated, operation };
    });
    if (change.updated) return {
      user: publicProfile(change.updated), profileRefreshRequired: false,
      operation: change.operation ? viewOperation(change.operation) : undefined
    };
    const outcome = await runCredential(caller, change.operation);
    return {
      ...viewCredentialResult(outcome),
      providerAcknowledged: outcome.providerAcknowledged,
      ...(outcome.operation.newEmail ? {
        authEmailSyncNote: outcome.operation.state === 'completed'
          ? 'Correo confirmado en Firebase Auth y Firestore. UID preservado.'
          : 'Cambio de correo pendiente de confirmación.'
      } : {})
    };
  }

  function epoch() {
    return Math.floor(Date.now() / 1000);
  }

  function viewOperation(operation: CredentialOperation) {
    return {
      id: operation.id, uid: operation.uid, version: operation.version, kind: operation.kind,
      state: operation.state, authentication: operation.authentication, audit: operation.audit,
      ...(operation.sessionCutoff !== undefined ? {
        sessionCutoff: operation.sessionCutoff, profileApplied: operation.profileApplied === true
      } : {}),
      ...(operation.kind === 'emergency' ? {
        authDisabled: operation.authDisabled === true, refreshRevoked: operation.refreshRevoked === true
      } : {}),
      ...(operation.failure ? { failure: operation.failure } : {})
    };
  }

  function viewCredentialResult(outcome: {
    operation: CredentialOperation;
    user: Profile | null;
    currentAuthentication?: { disabled: boolean; profileVersion: number } | null;
  }) {
    return {
      operation: viewOperation(outcome.operation),
      user: outcome.user ? publicProfile(outcome.user) : null,
      profileRefreshRequired: outcome.user === null,
      ...(outcome.currentAuthentication !== undefined ? { currentAuthentication: outcome.currentAuthentication } : {})
    };
  }

  function matchesReservation(user: Profile, operation: CredentialOperation) {
    return user.uid === operation.uid && (operation.sessionCutoff !== undefined
      ? user.sessionOperationId === operation.id
      : user.credentialOperationId === operation.id && user.credentialVersion === operation.version);
  }

  function providerCutoff(account: Account) {
    const timestamp = Date.parse(account.tokensValidAfterTime ?? '');
    return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
  }

  async function setUncertain(operation: CredentialOperation, failure?: string) {
    return profiles.transaction(async tx => {
      const latest = await tx.operation(operation.id);
      if (latest?.state === 'pending' && latest.authentication === 'dispatching') {
        const changes = { authentication: 'uncertain' as const, ...(failure ? { failure } : {}) };
        tx.updateOperation(operation.id, changes);
        return { ...latest, ...changes };
      }
      return latest || operation;
    });
  }

  async function rejectCredential(operation: CredentialOperation, code: string, wasDispatched: boolean) {
    return profiles.transaction(async tx => {
      const latest = await tx.operation(operation.id);
      const user = await tx.get(operation.uid);
      if (!latest || !user) fail(409, 'OPERATION_MISSING', 'La operación no está disponible.');
      const reservation = operation.newEmail ? await tx.emailOwner(operation.newEmail) : null;
      if (latest.state !== 'pending' || !matchesReservation(user, latest)) return latest;
      if (wasDispatched ? !['dispatching', 'uncertain'].includes(latest.authentication) : latest.authentication !== 'ready') {
        return latest;
      }
      if (latest.sessionCutoff !== undefined &&
          (latest.profileApplied || code === 'AUTH_CREDENTIAL_UNAVAILABLE' || code === 'AUTH_LOOKUP_UNAVAILABLE')) {
        const retry = { authentication: 'ready', failure: code } as const;
        tx.updateOperation(operation.id, retry);
        return { ...latest, ...retry };
      }
      const changes = {
        state: 'failed', authentication: 'rejected', audit: 'not_required', failure: code
      } as const;
      tx.updateOperation(operation.id, changes);
      tx.update(user.uid, latest.sessionCutoff === undefined
        ? { credentialOperationId: null, pendingEmail: null }
        : { sessionOperationId: null, ...(latest.newEmail ? { pendingEmail: null } : {}) });
      if (reservation === user.uid && operation.newEmail) tx.setEmailOwner(operation.newEmail, null);
      return { ...latest, ...changes };
    });
  }

  async function confirmCredential(operation: CredentialOperation, account: Account) {
    if (account.customClaims?.[CREDENTIAL_OPERATION_CLAIM] !== operation.id ||
        (operation.newEmail && emailKey(account.email) !== operation.newEmail) ||
        (operation.reactivateEmergencyId && account.disabled) ||
        (operation.sessionCutoff !== undefined && providerCutoff(account) < operation.sessionCutoff)) {
      return setUncertain(operation);
    }
    return profiles.transaction(async tx => {
      const latest = await tx.operation(operation.id);
      const user = await tx.get(operation.uid);
      if (!latest || !user) fail(409, 'OPERATION_MISSING', 'La operación no está disponible.');
      if (latest.state !== 'pending') return latest;
      if (!matchesReservation(user, latest) ||
          !['dispatching', 'uncertain'].includes(latest.authentication)) {
        fail(409, 'OPERATION_VERSION_CONFLICT', 'La versión de la operación ya no coincide.');
      }
      const previousOwner = operation.newEmail ? await tx.emailOwner(operation.oldEmail) : null;
      const reservedOwner = operation.newEmail ? await tx.emailOwner(operation.newEmail) : null;
      const otherEdits = (user.profileVersion ?? 0) !== latest.baseProfileVersion;
      const securityChanged = (user.securityVersion ?? 0) !== (latest.securityVersion ?? 0);
      let profileFields: Partial<Profile> = {};
      if (latest.newEmail && reservedOwner !== user.uid) {
        fail(409, 'EMAIL_RESERVATION_LOST', 'La reserva de correo requiere revisión.');
      }
      if (latest.newEmail) profileFields.email = latest.newEmail;
      if (latest.kind === 'active' && latest.changes) profileFields.active = latest.changes.active;
      if (!latest.profileApplied && !otherEdits && latest.changes) {
        const { dni } = latest.changes;
        const records = dni !== (user.dni || '') ? await tx.list() : [];
        const duplicateDni = dni && records.some(({ id, profile }) =>
          id !== user.uid && ownsProfileReservation(profile) && profile.dni?.trim() === dni);
        profileFields = Object.fromEntries(EDITABLE_PROFILE_FIELDS.filter(field => (!duplicateDni || field !== 'dni') &&
          Object.prototype.hasOwnProperty.call(latest.changes, field)).map(field => [field, latest.changes![field]]));
      }
      if (securityChanged) delete profileFields.active;
      const lock = latest.sessionCutoff === undefined
        ? { credentialOperationId: null, pendingEmail: null }
        : { sessionOperationId: null, ...(latest.newEmail ? { pendingEmail: null } : {}) };
      const cutoff = Math.max(user.sessionValidAfter ?? 0, latest.sessionCutoff ?? 0,
        latest.sessionCutoff !== undefined ? providerCutoff(account) : 0, latest.profileApplied ? 0 : epoch());
      const updated = latest.profileApplied ? { ...lock, sessionValidAfter: cutoff } : {
        ...profileFields, ...lock, updatedAt: new Date().toISOString(),
        updatedBy: latest.actor.uid, profileVersion: (user.profileVersion ?? 0) + 1,
        sessionValidAfter: cutoff,
        ...(latest.kind === 'active' && !securityChanged ? {
          securityVersion: (user.securityVersion ?? 0) + 1,
          ...(latest.reactivateEmergencyId === user.emergencyOperationId && latest.reactivateEmergencyId
            ? { emergencyOperationId: null } : {})
        } : {})
      };
      const outcome = {
        state: 'completed', authentication: 'applied',
        failure: securityChanged && latest.kind === 'active' ? 'SECURITY_STATE_CHANGED' : null,
        ...(latest.sessionCutoff !== undefined ? { profileApplied: latest.profileApplied || !securityChanged } : {})
      } as const;
      tx.update(user.uid, updated);
      tx.updateOperation(latest.id, outcome);
      if (previousOwner === user.uid) tx.setEmailOwner(latest.oldEmail, null);
      return { ...latest, ...outcome };
    });
  }

  async function recordCredentialAudit(operation: CredentialOperation) {
    if ((operation.state !== 'completed' && operation.kind !== 'emergency') || operation.audit !== 'pending') return operation;
    try {
      return await profiles.transaction(async tx => {
        const latest = await tx.operation(operation.id);
        const target = await tx.get(operation.uid);
        if (!latest || !target || latest.audit !== 'pending') return latest || operation;
        const details = {
          email: 'Cambio de correo confirmado por UID.',
          password: 'Contraseña temporal confirmada por UID.',
          active: latest.changes?.active ? 'Cuenta reactivada y sesiones anteriores revocadas.'
            : 'Cuenta desactivada y sesiones anteriores revocadas.',
          sessions: 'Revocación operativa de sesiones confirmada.',
          profile: 'Actualización de perfil.',
          emergency: 'Desactivación operativa de emergencia confirmada en Firestore.'
        };
        const detail = (latest.failure === 'SECURITY_STATE_CHANGED'
          ? 'El cambio de estado anterior quedó superado por un bloqueo de seguridad.' : details[latest.kind]) +
          (latest.newEmail ? ' ' + latest.oldEmail + ' → ' + latest.newEmail + '.' : '');
        tx.audit(latest.actor, target, 'MODIFICACIÓN', detail, undefined, latest.id);
        tx.updateOperation(latest.id, { audit: 'recorded' });
        return { ...latest, audit: 'recorded' as const };
      });
    } catch {
      return operation;
    }
  }

  async function waitingForAuthEnable(tx: ProfileTransaction, profile: Profile) {
    const previous = profile.sessionOperationId ? await tx.operation(profile.sessionOperationId) : null;
    return !!previous?.reactivateEmergencyId && previous.state === 'pending' &&
      ['dispatching', 'uncertain'].includes(previous.authentication);
  }

  async function runEmergency(caller: Session, initial: CredentialOperation) {
    let operation = await profiles.operation(initial.id) ?? initial;
    canManageOperation(await adminIn(profiles, caller), operation);
    operation = await recordCredentialAudit(operation);
    if (operation.state === 'pending') {
      const account = await accountByUid(operation.uid).catch(() => null);
      if (account && operation.authentication === 'ready') {
        const dispatch = await profiles.transaction(async tx => {
          await adminIn(tx, caller);
          const latest = await tx.operation(operation.id);
          const user = await tx.get(operation.uid);
          if (!latest || !user || user.emergencyOperationId !== latest.id || latest.authentication !== 'ready' ||
              await waitingForAuthEnable(tx, user)) return null;
          if (account.disabled && providerCutoff(account) >= latest.sessionCutoff!) return null;
          const cutoff = Math.max(latest.sessionCutoff!, providerCutoff(account), epoch());
          const claimed = {
            authentication: 'dispatching' as const, authDispatchCutoff: cutoff, failure: null,
            authAcknowledged: false, disabledByEmergency: latest.disabledByEmergency || !account.disabled
          };
          tx.updateOperation(latest.id, claimed);
          return { ...latest, ...claimed };
        });
        if (dispatch) {
          operation = dispatch;
          try {
            await identity.containAccount(dispatch.uid, String(dispatch.authDispatchCutoff));
            await profiles.transaction(async tx => {
              const latest = await tx.operation(dispatch.id);
              if (latest?.state === 'pending') tx.updateOperation(dispatch.id, { authAcknowledged: true });
            });
          } catch (error) {
            if (error instanceof MutationRejected) {
              operation = await profiles.transaction(async tx => {
                const latest = await tx.operation(dispatch.id);
                if (!latest || latest.state !== 'pending') return latest ?? dispatch;
                const retry = {
                  authentication: 'ready' as const, failure: error.code, disabledByEmergency: initial.disabledByEmergency === true
                };
                tx.updateOperation(latest.id, retry);
                return { ...latest, ...retry };
              });
            } else {
              operation = await setUncertain(dispatch, error instanceof MutationUncertain ? error.code : 'AUTH_RESPONSE_AMBIGUOUS');
            }
          }
        }
      }
      const observed = await accountByUid(operation.uid).catch(() => null);
      operation = await profiles.transaction(async tx => {
        const latest = await tx.operation(operation.id);
        const user = await tx.get(operation.uid);
        if (!latest || !user || latest.state !== 'pending' || user.emergencyOperationId !== latest.id ||
            await waitingForAuthEnable(tx, user)) return latest ?? operation;
        const authDisabled = observed?.disabled === true;
        const refreshRevoked = !!observed && providerCutoff(observed) >= (latest.authDispatchCutoff ?? latest.sessionCutoff!);
        if (authDisabled && refreshRevoked) {
          const completed = { state: 'completed', authentication: 'applied', authDisabled, refreshRevoked, failure: null } as const;
          tx.updateOperation(latest.id, completed);
          tx.update(user.uid, { sessionValidAfter: Math.max(user.sessionValidAfter ?? 0, providerCutoff(observed!)) });
          return { ...latest, ...completed };
        }
        const partial = {
          authDisabled, refreshRevoked,
          authentication: observed && latest.authAcknowledged ? 'ready' as const :
            latest.authentication === 'dispatching' ? 'uncertain' as const : latest.authentication
        };
        if (partial.authentication !== latest.authentication || partial.authDisabled !== latest.authDisabled ||
            partial.refreshRevoked !== latest.refreshRevoked) tx.updateOperation(latest.id, partial);
        return { ...latest, ...partial };
      });
    }
    const before = await profiles.get(operation.uid).catch(() => null);
    const account = before ? await accountByUid(operation.uid).catch(() => null) : null;
    const profile = await profiles.get(operation.uid).catch(() => null);
    const user = profile?.uid === operation.uid ? profile : null;
    const revision = user?.profileVersion ?? 0;
    // An Auth read that overlaps a profile change cannot describe the newer revision.
    return {
      operation, user,
      currentAuthentication: user && account && (before?.profileVersion ?? 0) === revision
        ? { disabled: account.disabled, profileVersion: revision } : null
    };
  }

  async function runCredential(caller: Session, initial: CredentialOperation, password?: string) {
    let operation = await profiles.operation(initial.id) || initial;
    const operator = async (reader: ProfileReader) => {
      const profile = await reader.get(caller.uid);
      // This request was authorized before committing its own revocation cutoff.
      const ownRevocation = initial.kind === 'sessions' && initial.uid === caller.uid && initial.actor.uid === caller.uid &&
        profile?.sessionOperationId === initial.id && profile.sessionValidAfter === initial.sessionCutoff;
      return requireAdminProfile(ownRevocation ? { ...profile, sessionValidAfter: 0 } : profile, caller);
    };
    const actor = await operator(profiles);
    canManageOperation(actor, operation);
    let attemptedPassword: string | undefined;
    let providerAcknowledged = false;
    if (operation.state === 'pending') {
      let account = await accountByUid(operation.uid).catch(error => {
        if (error instanceof AuthError) throw error;
        return undefined;
      });
      const sessionCutoff = operation.sessionCutoff;
      const changesCredentials = sessionCutoff === undefined || Boolean(operation.newEmail);
      if (account !== undefined && operation.authentication === 'ready' && (operation.kind !== 'password' || password)) {
        if (!account || (changesCredentials && emailKey(account.email) !== operation.oldEmail)) {
          operation = await rejectCredential(operation, 'AUTH_IDENTITY_CONFLICT', false);
        } else {
          const claimed = await profiles.transaction(async tx => {
            const admin = await operator(tx);
            const latest = await tx.operation(operation.id);
            const target = await tx.get(operation.uid);
            if (!latest || !target || !matchesReservation(target, latest) || latest.authentication !== 'ready') return false;
            if (sessionCutoff !== undefined && target.credentialOperationId) return false;
            canManageOperation(admin, latest);
            if (latest.kind === 'password' && target.authMethod === 'google') return false;
            if (latest.reactivateEmergencyId && target.emergencyOperationId !== latest.reactivateEmergencyId) return 'superseded';
            const contained = target.active === false && !!target.emergencyOperationId;
            if (account?.disabled && changesCredentials && !contained) return 'disabled';
            tx.updateOperation(operation.id, { authentication: 'dispatching' });
            return { contained };
          });
          if (claimed === 'superseded' || claimed === 'disabled') {
            operation = await rejectCredential(operation,
              claimed === 'superseded' ? 'SECURITY_STATE_CHANGED' : 'AUTH_IDENTITY_CONFLICT', false);
          } else if (claimed) {
            operation = { ...operation, authentication: 'dispatching' };
            attemptedPassword = password;
            try {
              const changes: AccountChanges = operation.newEmail
                ? { email: operation.newEmail, emailVerified: false }
                : operation.kind === 'password' ? { password } : {};
              if (sessionCutoff !== undefined) {
                // The queued revocation may have waited for a credential write with a later Auth cutoff.
                account = await accountByUid(operation.uid).catch(() => null);
                if (!account) throw new MutationRejected('AUTH_LOOKUP_UNAVAILABLE');
                if (changesCredentials && (emailKey(account.email) !== operation.oldEmail || (account.disabled && !claimed.contained))) {
                  throw new MutationRejected('AUTH_IDENTITY_CONFLICT');
                }
                changes.validSince = String(Math.max(sessionCutoff, providerCutoff(account), epoch()));
                if (operation.reactivateEmergencyId) changes.disableUser = false;
              }
              await identity.updateCredential(account, changes, operation.id);
              providerAcknowledged = true;
            } catch (error) {
              operation = error instanceof MutationRejected
                ? await rejectCredential(operation, error.code, true).catch(() => operation)
                : await setUncertain(operation, error instanceof MutationUncertain ? error.code : 'AUTH_RESPONSE_AMBIGUOUS').catch(() => operation);
            }
          }
          account = await accountByUid(operation.uid).catch(() => null);
        }
      }
      operation = await profiles.operation(operation.id).catch(() => null) || operation;
      if (operation.state === 'pending' && operation.authentication !== 'ready') {
        if (account) {
          operation = await confirmCredential(operation, account).catch(() =>
            setUncertain(operation).catch(() => operation));
        } else {
          operation = await setUncertain(operation).catch(() => operation);
        }
      }
    }
    operation = await recordCredentialAudit(operation);
    const read = await profiles.get(operation.uid).catch(() => null);
    const user = read?.uid === operation.uid ? read : null;
    const sentPassword = user?.credentialVersion === operation.version &&
      (providerAcknowledged || operation.state === 'completed') ? attemptedPassword : undefined;
    return { operation, user, sentPassword, providerAcknowledged };
  }

  async function setTemporaryPassword(authorization: string | undefined, uid: string, body: Record<string, unknown>) {
    const { caller, actor } = await requireAdmin(authorization);
    if (!validUid(uid)) fail(400, 'INVALID_UID', 'El UID no es válido.');
    protectPrimary(actor, uid, true);
    const id = operationId(body.operationId);
    const supplied = body.tempPassword === undefined ? undefined : checkedPassword(body.tempPassword);
    const secretSource = supplied === undefined ? 'generated' : 'provided';
    const observed = await profiles.operation(id);
    const password = supplied ?? (observed ? undefined : 'Calera#9' + randomBytes(18).toString('hex'));
    const salt = observed?.secretVerifier?.salt ?? randomBytes(16).toString('hex');
    const digest = password ? await passwordDigest(password, salt) : undefined;
    const reserved = await profiles.transaction(async tx => {
      const admin = await adminIn(tx, caller);
      protectPrimary(admin, uid, true);
      const previous = await tx.operation(id);
      const current = previous ? null : readTarget(await tx.get(uid), uid);
      const expectedVersion = body.expectedProfileVersion === undefined
        ? previous?.baseProfileVersion ?? current?.profileVersion ?? 0 : body.expectedProfileVersion;
      if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        if (previous) fail(409, 'OPERATION_ID_CONFLICT', 'El identificador corresponde a otra solicitud.');
        fail(400, 'INVALID_PROFILE_VERSION', 'La versión del perfil no es válida.');
      }
      const fingerprint = fingerprintRequest('password', uid, admin.uid, expectedVersion, {}, secretSource);
      if (previous) {
        assertSameRequest(previous, fingerprint);
        canManageOperation(admin, previous);
        if (supplied) {
          const verifier = previous.secretVerifier;
          const stored = Buffer.from(verifier?.digest ?? '', 'hex');
          if (!verifier || stored.length !== 32) fail(409, 'OPERATION_ID_CONFLICT', 'La contraseña no coincide con la solicitud original.');
          const actual = digest && salt === verifier.salt ? digest : await passwordDigest(supplied, verifier.salt);
          if (!timingSafeEqual(stored, actual)) fail(409, 'OPERATION_ID_CONFLICT', 'La contraseña no coincide con la solicitud original.');
        }
        return previous;
      }
      if ((current.profileVersion ?? 0) !== expectedVersion) {
        fail(409, 'STALE_PROFILE_VERSION', 'El perfil cambió. Actualice la lista y vuelva a intentarlo.');
      }
      if (isTemporary(uid, current) || current.authMethod === 'google') {
        fail(409, 'PASSWORD_NOT_AVAILABLE', 'El perfil debe estar vinculado y admitir contraseña.');
      }
      assertUnlocked(current);
      if (!digest) fail(409, 'OPERATION_ID_CONFLICT', 'La solicitud de contraseña ya no está disponible.');
      const operation = {
        ...newOperation(id, admin, current, 'password'), fingerprint,
        secretVerifier: { salt, digest: digest.toString('hex') }
      };
      tx.createOperation(operation);
      tx.update(uid, { credentialVersion: operation.version, credentialOperationId: id });
      return operation;
    });
    // A generated password is available only to the request that reserved it.
    const outcome = await runCredential(caller, reserved, supplied ?? (reserved.secretVerifier?.salt === salt ? password : undefined));
    return {
      success: outcome.operation.state === 'completed', mode: 'direct_update',
      ...viewCredentialResult(outcome),
      providerAcknowledged: outcome.providerAcknowledged,
      ...(outcome.sentPassword ? { tempPassword: outcome.sentPassword } : {}),
      message: outcome.operation.state === 'completed'
        ? 'Cambio de contraseña confirmado.' : 'Consulte el estado de la operación de contraseña.'
    };
  }

  async function cancelReadyPassword(authorization: string | undefined, id: string) {
    const { caller } = await requireAdmin(authorization);
    return profiles.transaction(async tx => {
      const admin = await adminIn(tx, caller);
      const latest = await tx.operation(operationId(id));
      if (!latest) fail(404, 'OPERATION_NOT_FOUND', 'La operación no está disponible.');
      canManageOperation(admin, latest);
      if (latest.failure === 'PASSWORD_CANCELLED') return { cancelled: true };
      const user = await tx.get(latest.uid);
      if (latest.kind !== 'password' || latest.state !== 'pending' || latest.authentication !== 'ready' ||
          !user || !matchesReservation(user, latest)) {
        fail(409, 'OPERATION_NOT_CANCELLABLE', 'Solo se puede cancelar una contraseña que todavía no se envió a Firebase.');
      }
      tx.updateOperation(latest.id, {
        state: 'failed', authentication: 'rejected', audit: 'not_required', failure: 'PASSWORD_CANCELLED'
      });
      tx.update(user.uid, { credentialOperationId: null });
      return { cancelled: true };
    });
  }

  async function reconcileOperation(authorization: string | undefined, id: string) {
    const { caller } = await requireAdmin(authorization);
    const operation = await profiles.operation(operationId(id));
    if (!operation) fail(404, 'OPERATION_NOT_FOUND', 'La operación no está disponible.');
    if (operation.kind === 'emergency') return viewCredentialResult(await runEmergency(caller, operation));
    const outcome = await runCredential(caller, operation);
    return viewCredentialResult(outcome);
  }

  async function listCredentialOperations(authorization: string | undefined, uid: string) {
    const { actor } = await requireAdmin(authorization);
    if (!validUid(uid)) fail(400, 'INVALID_UID', 'El UID no es válido.');
    const profile = await profiles.get(uid);
    const activeIds = [profile?.credentialOperationId, profile?.sessionOperationId, profile?.emergencyOperationId]
      .filter((id): id is string => !!id);
    const [outstanding, active] = await Promise.all([
      profiles.outstandingOperations(uid).catch(() => []), Promise.all(activeIds.map(id => profiles.operation(id)))
    ]);
    return [...new Map([...active, ...outstanding].flatMap(operation => operation && operation.uid === uid &&
        (operation.state === 'pending' || operation.audit === 'pending') ? [[operation.id, operation] as const] : [])).values()]
      .filter(operation => operation.kind === 'emergency' || operation.actor.uid === actor.uid || actor.uid === PRIMARY_ADMIN_UID)
      .filter(operation => uid !== PRIMARY_ADMIN_UID || actor.uid === uid || isPrimaryReactivation(operation))
      .map(viewOperation);
  }

  async function revokeSessions(authorization: string | undefined, uid: string, body: Record<string, unknown> = {}) {
    if (!validUid(uid)) fail(400, 'INVALID_UID', 'El UID no es válido.');
    const { caller } = await requireAdmin(authorization);
    const id = operationId(body.operationId);
    const operation = await profiles.transaction(async tx => {
      const admin = await adminIn(tx, caller);
      protectPrimary(admin, uid, true);
      const previous = await tx.operation(id);
      if (previous) {
        assertSameRequest(previous, fingerprintRequest('sessions', uid, admin.uid, previous.baseProfileVersion, {}));
        canManageOperation(admin, previous);
        return previous;
      }
      const target = readTarget(await tx.get(uid), uid);
      if (isTemporary(uid, target)) fail(409, 'PROFILE_NOT_LINKED', 'El perfil aún no tiene sesiones.');
      const fingerprint = fingerprintRequest('sessions', uid, admin.uid, target.profileVersion ?? 0, {});
      return reserveSessionOperation(tx, id, admin, target, 'sessions', fingerprint);
    });
    const outcome = await runCredential(caller, operation);
    return { ...viewCredentialResult(outcome), cutoff: operation.sessionCutoff!, firebaseRevoked: outcome.operation.authentication === 'applied' };
  }

  async function resetPassword(authorization: string | undefined, uid: string): Promise<never> {
    if (!validUid(uid)) fail(400, 'INVALID_UID', 'El UID no es válido.');
    const { actor } = await requireAdmin(authorization);
    protectPrimary(actor, uid, true);
    fail(410, 'ADMIN_RESET_DISABLED', 'El titular debe iniciar la recuperación desde la pantalla de acceso.');
  }

  return {
    authenticate, currentProfile, verifySession, listUsers, createUser, updateUser, setTemporaryPassword, resetPassword,
    listReservations, manageReservation, reconcileOperation, cancelReadyPassword, listCredentialOperations, listAuthMethods,
    revokeSessions, emergencyDisable
  };
}
