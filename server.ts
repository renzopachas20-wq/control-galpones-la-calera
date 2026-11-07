import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuración de Firebase y Constantes Oficiales
// ============================================================================

const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const PROJECT_ID: string = firebaseConfig.projectId;
const API_KEY: string = firebaseConfig.apiKey;
const DATABASE_ID: string = firebaseConfig.firestoreDatabaseId || '(default)';

const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;
const IDENTITY_TOOLKIT_BASE_URL = 'https://identitytoolkit.googleapis.com/v1';
const SECURE_TOKEN_URL = `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`;

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

const INITIAL_ADMIN_UID = 'jcSCn1eJ7Yao4xYeV6J8eZpszLR2';
const INITIAL_ADMIN_EMAIL = 'renzopachas20@gmail.com';

// ============================================================================
// Bóveda Cifrada de Tokens en Servidor (.server-auth-vault.json)
// Permite actualizar email / contraseña temporal en Firebase Auth preservando UID
// y migrar cuentas Google pre-autorizadas sin exponer credenciales en Firestore.
// ============================================================================

const VAULT_FILE_PATH = path.resolve(__dirname, '.server-auth-vault.json');
const VAULT_KEY = crypto
  .createHash('sha256')
  .update(`lacalera-vault:${PROJECT_ID}:${DATABASE_ID}:${API_KEY}`)
  .digest();

interface VaultEntry {
  uid: string;
  email: string;
  refreshToken?: string;
  updatedAt: string;
}

interface AuthVaultData {
  byUid: Record<string, VaultEntry>;
  byEmail: Record<string, VaultEntry>;
}

function readAuthVault(): AuthVaultData {
  try {
    if (!fs.existsSync(VAULT_FILE_PATH)) {
      return { byUid: {}, byEmail: {} };
    }
    const raw = JSON.parse(fs.readFileSync(VAULT_FILE_PATH, 'utf-8'));
    if (!raw || !raw.iv || !raw.tag || !raw.data) {
      return { byUid: {}, byEmail: {} };
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      VAULT_KEY,
      Buffer.from(raw.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(raw.tag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(raw.data, 'hex')),
      decipher.final()
    ]).toString('utf-8');
    const parsed = JSON.parse(decrypted);
    return {
      byUid: parsed.byUid || {},
      byEmail: parsed.byEmail || {}
    };
  } catch {
    return { byUid: {}, byEmail: {} };
  }
}

function writeAuthVault(vault: AuthVaultData): void {
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
    const plaintext = JSON.stringify(vault);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(
      VAULT_FILE_PATH,
      JSON.stringify({
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: encrypted.toString('hex')
      }),
      { mode: 0o600 }
    );
  } catch (err) {
    console.error('[Vault] Error guardando bóveda cifrada:', err);
  }
}

function saveUserToVault(uid: string, email: string, refreshToken?: string): void {
  if (!uid || !email) return;
  const normalizedEmail = email.trim().toLowerCase();
  const vault = readAuthVault();
  const existingUid = vault.byUid[uid];
  const existingEmail = vault.byEmail[normalizedEmail];
  const effectiveRefreshToken =
    refreshToken || existingUid?.refreshToken || existingEmail?.refreshToken;

  const entry: VaultEntry = {
    uid,
    email: normalizedEmail,
    refreshToken: effectiveRefreshToken,
    updatedAt: new Date().toISOString()
  };

  vault.byUid[uid] = entry;
  vault.byEmail[normalizedEmail] = entry;
  writeAuthVault(vault);
}

async function exchangeRefreshTokenForIdToken(
  refreshToken: string
): Promise<{ idToken: string; refreshToken: string; uid: string } | null> {
  try {
    const resp = await fetch(SECURE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }).toString()
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    if (!data.id_token) return null;
    return {
      idToken: data.id_token,
      refreshToken: data.refresh_token || refreshToken,
      uid: data.user_id
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Helpers de Serialización Firestore REST API v1
// ============================================================================

export interface UserProfileDTO {
  uid: string;
  email: string;
  displayName: string;
  dni: string;
  authMethod: AuthMethod;
  role: OfficialRole;
  active: boolean;
  assignedProject: string;
  assignedSectorIds: string[];
  assignedGalponIds: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  lastLoginAt?: string;
}

function toFirestoreValue(val: any): any {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(val: any): any {
  if (!val || typeof val !== 'object') return undefined;
  if ('stringValue' in val) return val.stringValue;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    const values = val.arrayValue?.values || [];
    return values.map(fromFirestoreValue);
  }
  if ('mapValue' in val) {
    const fields = val.mapValue?.fields || {};
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return undefined;
}

function parseFirestoreDocToProfile(doc: any): UserProfileDTO | null {
  if (!doc || !doc.fields) return null;
  const f = doc.fields;
  const uid = fromFirestoreValue(f.uid) || doc.name?.split('/').pop() || '';
  const email = fromFirestoreValue(f.email) || '';
  const displayName = fromFirestoreValue(f.displayName) || '';
  const dni = fromFirestoreValue(f.dni) || '';
  const rawAuthMethod = fromFirestoreValue(f.authMethod);
  const authMethod: AuthMethod =
    rawAuthMethod === 'google' || rawAuthMethod === 'both' || rawAuthMethod === 'password'
      ? rawAuthMethod
      : 'password';
  const role = fromFirestoreValue(f.role) as OfficialRole;
  const active = Boolean(fromFirestoreValue(f.active));
  const assignedProject = fromFirestoreValue(f.assignedProject) || 'TODOS';
  const assignedSectorIds = Array.isArray(fromFirestoreValue(f.assignedSectorIds))
    ? fromFirestoreValue(f.assignedSectorIds)
    : [];
  const assignedGalponIds = Array.isArray(fromFirestoreValue(f.assignedGalponIds))
    ? fromFirestoreValue(f.assignedGalponIds)
    : [];
  const createdAt = fromFirestoreValue(f.createdAt) || new Date().toISOString();
  const createdBy = fromFirestoreValue(f.createdBy) || 'system';
  const updatedAt = fromFirestoreValue(f.updatedAt) || createdAt;
  const updatedBy = fromFirestoreValue(f.updatedBy) || createdBy;
  const lastLoginAt = fromFirestoreValue(f.lastLoginAt);

  const profile: UserProfileDTO = {
    uid,
    email,
    displayName,
    dni,
    authMethod,
    role,
    active,
    assignedProject,
    assignedSectorIds,
    assignedGalponIds,
    createdAt,
    createdBy,
    updatedAt,
    updatedBy
  };
  if (lastLoginAt) {
    profile.lastLoginAt = lastLoginAt;
  }
  return profile;
}

function profileToFirestoreFields(profile: UserProfileDTO): Record<string, any> {
  const fields: Record<string, any> = {
    uid: toFirestoreValue(profile.uid),
    email: toFirestoreValue(profile.email),
    displayName: toFirestoreValue(profile.displayName),
    dni: toFirestoreValue(profile.dni || ''),
    authMethod: toFirestoreValue(profile.authMethod || 'password'),
    role: toFirestoreValue(profile.role),
    active: toFirestoreValue(profile.active),
    assignedProject: toFirestoreValue(profile.assignedProject || 'TODOS'),
    assignedSectorIds: toFirestoreValue(profile.assignedSectorIds || []),
    assignedGalponIds: toFirestoreValue(profile.assignedGalponIds || []),
    createdAt: toFirestoreValue(profile.createdAt),
    createdBy: toFirestoreValue(profile.createdBy),
    updatedAt: toFirestoreValue(profile.updatedAt),
    updatedBy: toFirestoreValue(profile.updatedBy)
  };
  if (profile.lastLoginAt) {
    fields.lastLoginAt = toFirestoreValue(profile.lastLoginAt);
  }
  return fields;
}

// ============================================================================
// Operaciones Firestore REST & Auditoría de Movimientos en Servidor
// ============================================================================

async function getProfileFromFirestore(uid: string, idToken: string): Promise<UserProfileDTO | null> {
  const url = `${FIRESTORE_BASE_URL}/users/${encodeURIComponent(uid)}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Firestore GET /users/${uid} falló (${resp.status}): ${errText}`);
  }
  const doc = await resp.json();
  return parseFirestoreDocToProfile(doc);
}

async function saveProfileToFirestore(profile: UserProfileDTO, idToken: string): Promise<UserProfileDTO> {
  const url = `${FIRESTORE_BASE_URL}/users/${encodeURIComponent(profile.uid)}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: profileToFirestoreFields(profile) })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Firestore PATCH /users/${profile.uid} falló (${resp.status}): ${errText}`);
  }
  const doc = await resp.json();
  return parseFirestoreDocToProfile(doc) || profile;
}

async function deleteProfileFromFirestore(uid: string, idToken: string): Promise<void> {
  const url = `${FIRESTORE_BASE_URL}/users/${encodeURIComponent(uid)}`;
  await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` }
  });
}

async function listAllProfilesFromFirestore(idToken: string): Promise<UserProfileDTO[]> {
  const url = `${FIRESTORE_BASE_URL}/users?pageSize=300`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Firestore LIST /users falló (${resp.status}): ${errText}`);
  }
  const data = (await resp.json()) as any;
  const docs = data.documents || [];
  const profiles: UserProfileDTO[] = [];
  for (const doc of docs) {
    const p = parseFirestoreDocToProfile(doc);
    if (p) profiles.push(p);
  }
  profiles.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return profiles;
}

async function writeServerMovementLog(
  idToken: string,
  actor: UserProfileDTO,
  type: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN',
  targetId: string,
  detail: string,
  previousValue?: Record<string, any> | null,
  newValue?: Record<string, any> | null
): Promise<void> {
  try {
    const now = new Date();
    const id = `mov-adm-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = now.toLocaleString('es-PE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const fields: Record<string, any> = {
      id: toFirestoreValue(id),
      timestamp: toFirestoreValue(timestamp),
      createdAt: toFirestoreValue(now.toISOString()),
      user: toFirestoreValue(`${actor.displayName} (${actor.role})`),
      userId: toFirestoreValue(actor.uid),
      userEmail: toFirestoreValue(actor.email),
      userRole: toFirestoreValue(actor.role),
      type: toFirestoreValue(type),
      module: toFirestoreValue('Administración de Usuarios'),
      targetId: toFirestoreValue(targetId),
      detail: toFirestoreValue(detail)
    };
    if (previousValue) {
      fields.previousValue = toFirestoreValue(JSON.stringify(previousValue));
    }
    if (newValue) {
      fields.newValue = toFirestoreValue(JSON.stringify(newValue));
    }

    const url = `${FIRESTORE_BASE_URL}/movements/${encodeURIComponent(id)}`;
    await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });
  } catch (err) {
    console.error('[Audit] No se pudo registrar movimiento administrativo:', err);
  }
}

// ============================================================================
// Verificación de Firebase ID Token vía Identity Toolkit
// ============================================================================

interface VerifiedCaller {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  providers: string[];
  idToken: string;
}

async function verifyFirebaseIdToken(req: express.Request): Promise<VerifiedCaller> {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    throw { status: 401, code: 'MISSING_TOKEN', message: 'Token de autorización no proporcionado.' };
  }
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) {
    throw { status: 401, code: 'EMPTY_TOKEN', message: 'Token de autorización vacío.' };
  }

  const resp = await fetch(`${IDENTITY_TOOLKIT_BASE_URL}/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });

  if (!resp.ok) {
    throw {
      status: 401,
      code: 'INVALID_TOKEN',
      message: 'La sesión ha expirado o el token es inválido. Inicie sesión nuevamente.'
    };
  }

  const data = (await resp.json()) as any;
  const user = data?.users?.[0];
  if (!user || !user.localId) {
    throw { status: 401, code: 'USER_NOT_FOUND', message: 'Usuario no encontrado en Firebase Authentication.' };
  }

  const providers: string[] = (user.providerUserInfo || []).map((p: any) => p.providerId);

  return {
    uid: user.localId,
    email: (user.email || '').toLowerCase(),
    emailVerified: Boolean(user.emailVerified),
    displayName: user.displayName || '',
    providers,
    idToken
  };
}

async function requireActiveAdmin(req: express.Request): Promise<{
  caller: VerifiedCaller;
  adminProfile: UserProfileDTO;
}> {
  const caller = await verifyFirebaseIdToken(req);
  const profile = await getProfileFromFirestore(caller.uid, caller.idToken);

  if (!profile) {
    throw {
      status: 403,
      code: 'PROFILE_NOT_FOUND',
      message: 'Su cuenta no posee un perfil registrado en el sistema.'
    };
  }
  if (!profile.active) {
    throw {
      status: 403,
      code: 'USER_INACTIVE',
      message: 'Su cuenta ha sido desactivada. Contacte al Administrador.'
    };
  }
  if (profile.role !== 'Administrador') {
    throw {
      status: 403,
      code: 'FORBIDDEN_ROLE',
      message: 'Acceso denegado: Se requiere el rol de Administrador para gestionar usuarios.'
    };
  }

  return { caller, adminProfile: profile };
}

/**
 * Obtiene un idToken activo de Administrador desde la bóveda cifrada para operaciones
 * internas de asociación de perfiles Google pre-autorizados.
 */
async function getVaultedAdminIdToken(): Promise<{ idToken: string; adminUid: string } | null> {
  const vault = readAuthVault();
  const adminEntry =
    vault.byUid[INITIAL_ADMIN_UID] ||
    vault.byEmail[INITIAL_ADMIN_EMAIL] ||
    Object.values(vault.byUid).find((e) => Boolean(e.refreshToken));

  if (!adminEntry || !adminEntry.refreshToken) return null;
  const refreshed = await exchangeRefreshTokenForIdToken(adminEntry.refreshToken);
  if (!refreshed) return null;
  saveUserToVault(adminEntry.uid, adminEntry.email, refreshed.refreshToken);
  return { idToken: refreshed.idToken, adminUid: adminEntry.uid };
}

// ============================================================================
// Servidor Express + Vite
// ============================================================================

async function startServer() {
  const app = express();

  // Middleware CORS para soportar clientes Web y aplicaciones móviles (Capacitor / Android WebView)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  app.use(express.json({ limit: '5mb' }));

  // --------------------------------------------------------------------------
  // 1. POST /api/auth/verify-session
  // Valida la sesión activa, registra el refreshToken en la bóveda cifrada del
  // servidor, y soporta tanto Correo/Contraseña como Google pre-autorizado.
  // --------------------------------------------------------------------------
  app.post('/api/auth/verify-session', async (req, res) => {
    try {
      const caller = await verifyFirebaseIdToken(req);
      const clientRefreshToken =
        typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : undefined;

      // Guardamos el vínculo (uid <-> email + refreshToken) en la bóveda del servidor
      if (caller.uid && caller.email) {
        saveUserToVault(caller.uid, caller.email, clientRefreshToken);
      }

      let profile = await getProfileFromFirestore(caller.uid, caller.idToken);

      // Si no existe bajo caller.uid, verificamos si existe un perfil pre-autorizado por correo
      // (por ejemplo, cuenta Google autorizada previamente por el Administrador)
      if (!profile && caller.email) {
        const adminAuth = await getVaultedAdminIdToken();
        if (adminAuth) {
          const allProfiles = await listAllProfilesFromFirestore(adminAuth.idToken);
          const matchingByEmail = allProfiles.find(
            (p) => p.email.trim().toLowerCase() === caller.email.trim().toLowerCase()
          );

          if (matchingByEmail) {
            if (!matchingByEmail.active) {
              return res.status(403).json({
                code: 'USER_INACTIVE',
                message: 'Su cuenta se encuentra desactivada. Comuníquese con el Administrador del sistema.'
              });
            }

            // Migramos/vinculamos el perfil pre-autorizado al UID real de Firebase Authentication
            const nowIso = new Date().toISOString();
            const isGoogleLogin = caller.providers.includes('google.com');
            const updatedAuthMethod: AuthMethod =
              isGoogleLogin && matchingByEmail.authMethod === 'password'
                ? 'both'
                : matchingByEmail.authMethod;

            const boundProfile: UserProfileDTO = {
              ...matchingByEmail,
              uid: caller.uid,
              displayName: matchingByEmail.displayName || caller.displayName || caller.email.split('@')[0],
              authMethod: updatedAuthMethod,
              updatedAt: nowIso,
              updatedBy: caller.uid,
              lastLoginAt: nowIso
            };

            profile = await saveProfileToFirestore(boundProfile, adminAuth.idToken);

            // Si el documento anterior tenía un ID temporal distinto del UID real, lo removemos
            if (matchingByEmail.uid !== caller.uid) {
              await deleteProfileFromFirestore(matchingByEmail.uid, adminAuth.idToken);
            }
          }
        }
      }

      if (!profile) {
        return res.status(403).json({
          code: 'PROFILE_NOT_FOUND',
          message:
            'Su cuenta no está autorizada en Control Galpones La Calera. Solicite al Administrador que registre su acceso.'
        });
      }

      if (!profile.active) {
        return res.status(403).json({
          code: 'USER_INACTIVE',
          message: 'Su cuenta ha sido desactivada por el Administrador. Acceso bloqueado.'
        });
      }

      if (!OFFICIAL_ROLES.includes(profile.role)) {
        return res.status(403).json({
          code: 'INVALID_ROLE',
          message: `El rol asignado (${profile.role}) no pertenece a los 6 roles oficiales.`
        });
      }

      // Actualizar lastLoginAt
      const nowIso = new Date().toISOString();
      try {
        const updated: UserProfileDTO = {
          ...profile,
          lastLoginAt: nowIso,
          updatedAt: nowIso,
          updatedBy: caller.uid
        };
        profile = await saveProfileToFirestore(updated, caller.idToken);
      } catch {
        // Si por alguna restricción falla el timestamp, devolvemos el perfil verificado
        profile.lastLoginAt = nowIso;
      }

      return res.json({ profile });
    } catch (err: any) {
      const status = err?.status || 500;
      return res.status(status).json({
        code: err?.code || 'VERIFY_SESSION_ERROR',
        message: err?.message || 'Error interno al verificar la sesión.'
      });
    }
  });

  // --------------------------------------------------------------------------
  // 2. GET /api/admin/users
  // Lista todos los usuarios registrados (Exclusivo Administrador)
  // --------------------------------------------------------------------------
  app.get('/api/admin/users', async (req, res) => {
    try {
      const { caller } = await requireActiveAdmin(req);
      const users = await listAllProfilesFromFirestore(caller.idToken);
      return res.json({ users });
    } catch (err: any) {
      const status = err?.status || 500;
      return res.status(status).json({
        code: err?.code || 'LIST_USERS_ERROR',
        message: err?.message || 'No se pudo obtener la lista de usuarios.'
      });
    }
  });

  // --------------------------------------------------------------------------
  // 3. POST /api/admin/users
  // Crea un nuevo usuario (Correo/Contraseña, Google pre-autorizado o Ambos)
  // sin cerrar la sesión del Administrador y registra movimiento de auditoría.
  // --------------------------------------------------------------------------
  app.post('/api/admin/users', async (req, res) => {
    try {
      const { caller, adminProfile } = await requireActiveAdmin(req);

      const rawEmail = String(req.body?.email || '').trim().toLowerCase();
      const rawDisplayName = String(req.body?.displayName || '').trim();
      const rawDni = String(req.body?.dni || '').trim();
      const rawPassword = String(req.body?.password || '');
      const rawAuthMethod = String(req.body?.authMethod || 'password') as AuthMethod;
      const authMethod: AuthMethod =
        rawAuthMethod === 'google' || rawAuthMethod === 'both' ? rawAuthMethod : 'password';
      const role = String(req.body?.role || '') as OfficialRole;
      const active = req.body?.active !== undefined ? Boolean(req.body.active) : true;
      const assignedProject = String(req.body?.assignedProject || 'TODOS').trim() || 'TODOS';
      const assignedSectorIds = Array.isArray(req.body?.assignedSectorIds)
        ? req.body.assignedSectorIds.map(String)
        : [];
      const assignedGalponIds = Array.isArray(req.body?.assignedGalponIds)
        ? req.body.assignedGalponIds.map(String)
        : [];

      if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        return res.status(400).json({ message: 'Ingrese un correo electrónico válido.' });
      }
      if (!rawDisplayName || rawDisplayName.length < 2) {
        return res.status(400).json({ message: 'Ingrese el nombre completo del usuario.' });
      }
      if (!OFFICIAL_ROLES.includes(role)) {
        return res.status(400).json({
          message: `El rol debe ser uno de los 6 roles oficiales: ${OFFICIAL_ROLES.join(', ')}.`
        });
      }
      if (authMethod !== 'google' && rawPassword.length < 6) {
        return res.status(400).json({
          message: 'La contraseña temporal debe tener al menos 6 caracteres.'
        });
      }

      // Verificar que no exista otro perfil con el mismo correo o DNI en Firestore
      const existingProfiles = await listAllProfilesFromFirestore(caller.idToken);
      const duplicateEmail = existingProfiles.find(
        (p) => p.email.trim().toLowerCase() === rawEmail
      );
      if (duplicateEmail) {
        return res.status(409).json({
          message: `Ya existe un usuario registrado con el correo ${rawEmail}.`
        });
      }
      if (rawDni) {
        const duplicateDni = existingProfiles.find(
          (p) => (p.dni || '').trim() !== '' && (p.dni || '').trim() === rawDni
        );
        if (duplicateDni) {
          return res.status(409).json({
            message: `Ya existe un usuario registrado con el DNI ${rawDni} (${duplicateDni.displayName}).`
          });
        }
      }

      // Contraseña efectiva para Firebase Auth (si es solo Google, generamos clave interna de alta entropía)
      const effectivePassword =
        authMethod === 'google' && rawPassword.length < 6
          ? `GAuth#${crypto.randomBytes(12).toString('hex')}!9`
          : rawPassword;

      let targetUid = '';
      let targetRefreshToken: string | undefined;

      // Intentar crear cuenta en Firebase Authentication vía Identity Toolkit signUp
      const signUpResp = await fetch(
        `${IDENTITY_TOOLKIT_BASE_URL}/accounts:signUp?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: rawEmail,
            password: effectivePassword,
            displayName: rawDisplayName,
            returnSecureToken: true
          })
        }
      );

      if (signUpResp.ok) {
        const signUpData = (await signUpResp.json()) as any;
        targetUid = signUpData.localId;
        targetRefreshToken = signUpData.refreshToken;
      } else {
        const errData = (await signUpResp.json().catch(() => ({}))) as any;
        const errMsg = errData?.error?.message || '';

        if (errMsg === 'EMAIL_EXISTS') {
          // Si el correo ya existía en Firebase Auth (por ejemplo, intentó entrar con Google antes)
          const vault = readAuthVault();
          const vaulted = vault.byEmail[rawEmail];
          if (vaulted?.uid) {
            targetUid = vaulted.uid;
            targetRefreshToken = vaulted.refreshToken;
          } else if (rawPassword.length >= 6) {
            // Intentar signInWithPassword si el Admin conoce su contraseña
            const signInResp = await fetch(
              `${IDENTITY_TOOLKIT_BASE_URL}/accounts:signInWithPassword?key=${API_KEY}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: rawEmail,
                  password: rawPassword,
                  returnSecureToken: true
                })
              }
            );
            if (signInResp.ok) {
              const signInData = (await signInResp.json()) as any;
              targetUid = signInData.localId;
              targetRefreshToken = signInData.refreshToken;
            }
          }

          // Si es cuenta Google pre-autorizada cuyo UID aún no está en bóveda, asignamos ID pre-autorizado
          // que se vinculará automáticamente al UID real en cuanto el usuario inicie sesión con Google
          if (!targetUid) {
            const emailHash = crypto.createHash('sha1').update(rawEmail).digest('hex').slice(0, 24);
            targetUid = `preauth_${emailHash}`;
          }
        } else {
          return res.status(400).json({
            message: `Error en Firebase Authentication: ${errMsg || 'No se pudo crear la cuenta.'}`
          });
        }
      }

      if (targetUid && !targetUid.startsWith('preauth_')) {
        saveUserToVault(targetUid, rawEmail, targetRefreshToken);
      }

      const nowIso = new Date().toISOString();
      const newProfile: UserProfileDTO = {
        uid: targetUid,
        email: rawEmail,
        displayName: rawDisplayName,
        dni: rawDni,
        authMethod,
        role,
        active,
        assignedProject,
        assignedSectorIds: role === 'Administrador' ? [] : assignedSectorIds,
        assignedGalponIds: role === 'Administrador' ? [] : assignedGalponIds,
        createdAt: nowIso,
        createdBy: caller.uid,
        updatedAt: nowIso,
        updatedBy: caller.uid
      };

      const savedProfile = await saveProfileToFirestore(newProfile, caller.idToken);

      await writeServerMovementLog(
        caller.idToken,
        adminProfile,
        'REGISTRO',
        savedProfile.uid,
        `Creación de usuario "${savedProfile.displayName}" (${savedProfile.email}) con rol ${savedProfile.role} y método ${savedProfile.authMethod}.`,
        null,
        {
          uid: savedProfile.uid,
          email: savedProfile.email,
          displayName: savedProfile.displayName,
          dni: savedProfile.dni,
          role: savedProfile.role,
          authMethod: savedProfile.authMethod,
          active: savedProfile.active,
          assignedProject: savedProfile.assignedProject,
          assignedSectorIds: savedProfile.assignedSectorIds,
          assignedGalponIds: savedProfile.assignedGalponIds
        }
      );

      return res.status(201).json({ user: savedProfile });
    } catch (err: any) {
      const status = err?.status || 500;
      return res.status(status).json({
        code: err?.code || 'CREATE_USER_ERROR',
        message: err?.message || 'Error al crear el usuario.'
      });
    }
  });

  // --------------------------------------------------------------------------
  // 4. PATCH /api/admin/users/:uid
  // Actualiza datos del usuario (Nombre, DNI, Correo Electrónico preservando UID,
  // Rol, Estado activo/inactivo, Método de acceso, Proyecto, Sectores y Galpones)
  // y registra auditoría detallada con valor anterior y valor nuevo.
  // --------------------------------------------------------------------------
  app.patch('/api/admin/users/:uid', async (req, res) => {
    try {
      const { caller, adminProfile } = await requireActiveAdmin(req);
      const targetUid = String(req.params.uid || '').trim();
      if (!targetUid) {
        return res.status(400).json({ message: 'UID de usuario requerido.' });
      }

      const existing = await getProfileFromFirestore(targetUid, caller.idToken);
      if (!existing) {
        return res.status(404).json({ message: 'El perfil de usuario no existe en Firestore.' });
      }

      const nextDisplayName =
        req.body?.displayName !== undefined
          ? String(req.body.displayName).trim()
          : existing.displayName;
      const nextDni =
        req.body?.dni !== undefined ? String(req.body.dni).trim() : existing.dni || '';
      const nextEmail =
        req.body?.email !== undefined
          ? String(req.body.email).trim().toLowerCase()
          : existing.email.toLowerCase();
      const nextRole = (req.body?.role !== undefined ? req.body.role : existing.role) as OfficialRole;
      const nextActive =
        req.body?.active !== undefined ? Boolean(req.body.active) : existing.active;
      const nextAuthMethod: AuthMethod =
        req.body?.authMethod === 'google' ||
        req.body?.authMethod === 'both' ||
        req.body?.authMethod === 'password'
          ? req.body.authMethod
          : existing.authMethod || 'password';
      const nextAssignedProject =
        req.body?.assignedProject !== undefined
          ? String(req.body.assignedProject).trim() || 'TODOS'
          : existing.assignedProject || 'TODOS';
      const nextSectorIds = Array.isArray(req.body?.assignedSectorIds)
        ? req.body.assignedSectorIds.map(String)
        : existing.assignedSectorIds;
      const nextGalponIds = Array.isArray(req.body?.assignedGalponIds)
        ? req.body.assignedGalponIds.map(String)
        : existing.assignedGalponIds;

      if (!nextDisplayName || nextDisplayName.length < 2) {
        return res.status(400).json({ message: 'El nombre completo debe tener al menos 2 caracteres.' });
      }
      if (!nextEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
        return res.status(400).json({ message: 'El formato del correo electrónico no es válido.' });
      }
      if (!OFFICIAL_ROLES.includes(nextRole)) {
        return res.status(400).json({ message: 'El rol seleccionado no es un rol oficial válido.' });
      }

      // Protección de seguridad: No permitir desactivar ni quitar rol Administrador a sí mismo
      if (targetUid === caller.uid) {
        if (!nextActive) {
          return res.status(400).json({
            message: 'No puede desactivar su propia cuenta de Administrador en sesión.'
          });
        }
        if (nextRole !== 'Administrador') {
          return res.status(400).json({
            message: 'No puede degradar su propio rol de Administrador.'
          });
        }
      }

      const emailChanged = nextEmail !== existing.email.trim().toLowerCase();
      let authEmailSyncNote = 'sin cambios de correo';

      // Si cambió el correo o el DNI, verificar que no exista duplicado en otro perfil
      if (emailChanged || (nextDni && nextDni !== existing.dni)) {
        const allProfiles = await listAllProfilesFromFirestore(caller.idToken);
        if (emailChanged) {
          const emailCollision = allProfiles.find(
            (p) => p.uid !== targetUid && p.email.trim().toLowerCase() === nextEmail
          );
          if (emailCollision) {
            return res.status(409).json({
              message: `El correo electrónico ${nextEmail} ya está asignado a otro usuario (${emailCollision.displayName}).`
            });
          }
        }
        if (nextDni && nextDni !== existing.dni) {
          const dniCollision = allProfiles.find(
            (p) => p.uid !== targetUid && (p.dni || '').trim() === nextDni
          );
          if (dniCollision) {
            return res.status(409).json({
              message: `El DNI ${nextDni} ya está asignado a otro usuario (${dniCollision.displayName}).`
            });
          }
        }
      }

      // Sincronizar cambio de correo en Firebase Authentication preservando el UID
      if (emailChanged && !targetUid.startsWith('preauth_')) {
        if (existing.authMethod === 'google' && nextAuthMethod === 'google') {
          // Para cuentas exclusivamente Google, no se modifica la identidad externa de Google,
          // pero se actualiza el correo autorizado en el perfil manteniendo el UID
          authEmailSyncNote = 'correo autorizado actualizado para acceso con Google (UID preservado)';
          saveUserToVault(targetUid, nextEmail);
        } else {
          const vault = readAuthVault();
          const vaultedUser = vault.byUid[targetUid] || vault.byEmail[existing.email.toLowerCase()];
          if (vaultedUser?.refreshToken) {
            const refreshed = await exchangeRefreshTokenForIdToken(vaultedUser.refreshToken);
            if (refreshed) {
              const updateAuthResp = await fetch(
                `${IDENTITY_TOOLKIT_BASE_URL}/accounts:update?key=${API_KEY}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    idToken: refreshed.idToken,
                    email: nextEmail,
                    returnSecureToken: true
                  })
                }
              );

              if (updateAuthResp.ok) {
                const updateAuthData = (await updateAuthResp.json()) as any;
                saveUserToVault(
                  targetUid,
                  nextEmail,
                  updateAuthData.refreshToken || refreshed.refreshToken
                );
                authEmailSyncNote = 'sincronizado directamente en Firebase Auth y Firestore (UID preservado)';
              } else {
                const errJson = (await updateAuthResp.json().catch(() => ({}))) as any;
                const errCode = errJson?.error?.message || '';
                if (errCode === 'EMAIL_EXISTS') {
                  return res.status(409).json({
                    message: `El correo ${nextEmail} ya existe en Firebase Authentication.`
                  });
                }
                // Si el proyecto exige verificación por correo para cambio de email, enviamos OOB VERIFY_AND_CHANGE_EMAIL
                await fetch(`${IDENTITY_TOOLKIT_BASE_URL}/accounts:sendOobCode?key=${API_KEY}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requestType: 'VERIFY_AND_CHANGE_EMAIL',
                    idToken: refreshed.idToken,
                    newEmail: nextEmail
                  })
                });
                saveUserToVault(targetUid, nextEmail, refreshed.refreshToken);
                authEmailSyncNote = 'actualizado en Firestore con enlace de confirmación enviado (UID preservado)';
              }
            } else {
              saveUserToVault(targetUid, nextEmail);
              authEmailSyncNote = 'actualizado en perfil Firestore (UID preservado)';
            }
          } else {
            saveUserToVault(targetUid, nextEmail);
            authEmailSyncNote = 'actualizado en perfil Firestore (UID preservado)';
          }
        }
      }

      const nowIso = new Date().toISOString();
      const updatedProfile: UserProfileDTO = {
        ...existing,
        uid: existing.uid, // El UID jamás cambia
        displayName: nextDisplayName,
        dni: nextDni,
        email: nextEmail,
        authMethod: nextAuthMethod,
        role: nextRole,
        active: nextActive,
        assignedProject: nextRole === 'Administrador' ? 'TODOS' : nextAssignedProject,
        assignedSectorIds: nextRole === 'Administrador' ? [] : nextSectorIds,
        assignedGalponIds: nextRole === 'Administrador' ? [] : nextGalponIds,
        updatedAt: nowIso,
        updatedBy: caller.uid
      };

      const saved = await saveProfileToFirestore(updatedProfile, caller.idToken);

      const changes: string[] = [];
      if (existing.displayName !== saved.displayName) {
        changes.push(`Nombre: "${existing.displayName}" → "${saved.displayName}"`);
      }
      if ((existing.dni || '') !== (saved.dni || '')) {
        changes.push(`DNI: "${existing.dni || '-'}" → "${saved.dni || '-'}"`);
      }
      if (existing.email !== saved.email) {
        changes.push(`Correo: "${existing.email}" → "${saved.email}" (${authEmailSyncNote})`);
      }
      if (existing.role !== saved.role) {
        changes.push(`Rol: ${existing.role} → ${saved.role}`);
      }
      if (existing.active !== saved.active) {
        changes.push(`Estado: ${existing.active ? 'Activo' : 'Inactivo'} → ${saved.active ? 'Activo' : 'Inactivo'}`);
      }
      if (existing.authMethod !== saved.authMethod) {
        changes.push(`Método acceso: ${existing.authMethod} → ${saved.authMethod}`);
      }

      await writeServerMovementLog(
        caller.idToken,
        adminProfile,
        'MODIFICACIÓN',
        saved.uid,
        `Actualización de usuario "${saved.displayName}" (UID: ${saved.uid}). ${changes.join(' | ') || 'Actualización de alcance asignado.'}`,
        {
          displayName: existing.displayName,
          dni: existing.dni,
          email: existing.email,
          role: existing.role,
          active: existing.active,
          authMethod: existing.authMethod,
          assignedProject: existing.assignedProject,
          assignedSectorIds: existing.assignedSectorIds,
          assignedGalponIds: existing.assignedGalponIds
        },
        {
          displayName: saved.displayName,
          dni: saved.dni,
          email: saved.email,
          role: saved.role,
          active: saved.active,
          authMethod: saved.authMethod,
          assignedProject: saved.assignedProject,
          assignedSectorIds: saved.assignedSectorIds,
          assignedGalponIds: saved.assignedGalponIds
        }
      );

      return res.json({ user: saved, authEmailSyncNote });
    } catch (err: any) {
      const status = err?.status || 500;
      return res.status(status).json({
        code: err?.code || 'UPDATE_USER_ERROR',
        message: err?.message || 'Error al actualizar el usuario.'
      });
    }
  });

  // --------------------------------------------------------------------------
  // 5. POST /api/admin/users/:uid/temp-password
  // Genera y asigna una nueva contraseña temporal para el usuario preservando
  // su UID, sin almacenar jamás la contraseña en Firestore.
  // --------------------------------------------------------------------------
  app.post('/api/admin/users/:uid/temp-password', async (req, res) => {
    try {
      const { caller, adminProfile } = await requireActiveAdmin(req);
      const targetUid = String(req.params.uid || '').trim();
      const existing = await getProfileFromFirestore(targetUid, caller.idToken);
      if (!existing) {
        return res.status(404).json({ message: 'Usuario no encontrado.' });
      }

      if (existing.authMethod === 'google') {
        return res.status(400).json({
          message:
            'Este usuario está configurado únicamente con acceso Google. Cambie su método de acceso a "Correo y contraseña" o "Ambos" si desea asignarle una contraseña.'
        });
      }

      const providedPassword =
        typeof req.body?.tempPassword === 'string' ? req.body.tempPassword.trim() : '';
      const generatedPassword =
        providedPassword.length >= 6
          ? providedPassword
          : `Calera${Math.floor(1000 + Math.random() * 9000)}#${crypto.randomBytes(2).toString('hex')}`;

      const vault = readAuthVault();
      const vaultedUser = vault.byUid[targetUid] || vault.byEmail[existing.email.toLowerCase()];

      if (vaultedUser?.refreshToken) {
        const refreshed = await exchangeRefreshTokenForIdToken(vaultedUser.refreshToken);
        if (refreshed) {
          const updateResp = await fetch(
            `${IDENTITY_TOOLKIT_BASE_URL}/accounts:update?key=${API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                idToken: refreshed.idToken,
                password: generatedPassword,
                returnSecureToken: true
              })
            }
          );

          if (updateResp.ok) {
            const updateData = (await updateResp.json()) as any;
            saveUserToVault(
              targetUid,
              existing.email,
              updateData.refreshToken || refreshed.refreshToken
            );

            await writeServerMovementLog(
              caller.idToken,
              adminProfile,
              'MODIFICACIÓN',
              existing.uid,
              `Generación de contraseña temporal para "${existing.displayName}" (${existing.email}).`,
              { passwordStatus: 'anterior' },
              { passwordStatus: 'contraseña temporal regenerada por Administrador' }
            );

            return res.json({
              success: true,
              mode: 'direct_update',
              tempPassword: generatedPassword,
              message: 'Contraseña temporal establecida correctamente en Firebase Authentication.'
            });
          }
        }
      }

      // Fallback: Enviar correo oficial de restablecimiento de contraseña vía Firebase Auth
      await fetch(`${IDENTITY_TOOLKIT_BASE_URL}/accounts:sendOobCode?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'PASSWORD_RESET',
          email: existing.email
        })
      });

      await writeServerMovementLog(
        caller.idToken,
        adminProfile,
        'MODIFICACIÓN',
        existing.uid,
        `Envío de enlace oficial de restablecimiento de contraseña a "${existing.displayName}" (${existing.email}).`
      );

      return res.json({
        success: true,
        mode: 'reset_email_sent',
        message: `Se envió un correo de restablecimiento de contraseña a ${existing.email}.`
      });
    } catch (err: any) {
      const status = err?.status || 500;
      return res.status(status).json({
        code: err?.code || 'TEMP_PASSWORD_ERROR',
        message: err?.message || 'No se pudo generar la contraseña temporal.'
      });
    }
  });

  // --------------------------------------------------------------------------
  // 6. POST /api/admin/users/:uid/reset-password
  // Dispara el correo oficial de restablecimiento de contraseña de Firebase
  // --------------------------------------------------------------------------
  app.post('/api/admin/users/:uid/reset-password', async (req, res) => {
    try {
      const { caller, adminProfile } = await requireActiveAdmin(req);
      const targetUid = String(req.params.uid || '').trim();
      const existing = await getProfileFromFirestore(targetUid, caller.idToken);
      if (!existing) {
        return res.status(404).json({ message: 'Usuario no encontrado.' });
      }

      const oobResp = await fetch(
        `${IDENTITY_TOOLKIT_BASE_URL}/accounts:sendOobCode?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestType: 'PASSWORD_RESET',
            email: existing.email
          })
        }
      );

      if (!oobResp.ok) {
        const errData = (await oobResp.json().catch(() => ({}))) as any;
        return res.status(400).json({
          message: `No se pudo enviar el correo de recuperación: ${errData?.error?.message || 'Error desconocido'}`
        });
      }

      await writeServerMovementLog(
        caller.idToken,
        adminProfile,
        'MODIFICACIÓN',
        existing.uid,
        `Solicitud administrativa de restablecimiento de contraseña por correo para "${existing.displayName}" (${existing.email}).`
      );

      return res.json({
        success: true,
        message: `Correo de restablecimiento enviado a ${existing.email}.`
      });
    } catch (err: any) {
      const status = err?.status || 500;
      return res.status(status).json({
        code: err?.code || 'RESET_PASSWORD_ERROR',
        message: err?.message || 'Error al solicitar el restablecimiento de contraseña.'
      });
    }
  });

  // --------------------------------------------------------------------------
  // Sistema Automático de Metadatos de Versión y Despliegue (/api/version)
  // --------------------------------------------------------------------------
  function resolveRuntimeVersionMetadata(req: express.Request) {
    let baseMeta: Record<string, any> = {};
    const distMetaPath = path.resolve(__dirname, 'dist/version-metadata.json');
    const genMetaPath = path.resolve(__dirname, 'src/generated/versionMetadata.json');

    if (fs.existsSync(distMetaPath)) {
      try {
        baseMeta = JSON.parse(fs.readFileSync(distMetaPath, 'utf-8'));
      } catch {
        // ignore
      }
    } else if (fs.existsSync(genMetaPath)) {
      try {
        baseMeta = JSON.parse(fs.readFileSync(genMetaPath, 'utf-8'));
      } catch {
        // ignore
      }
    }

    let pkgVersion = baseMeta.version || '3.0.0';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
      if (pkg.version) pkgVersion = String(pkg.version);
    } catch {
      // ignore
    }

    let liveCommit = baseMeta.commitHash || 'unknown';
    try {
      const gitOut = execSync('git rev-parse --short HEAD', {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .toString()
        .trim();
      if (gitOut) liveCommit = gitOut;
    } catch {
      // en contenedor de producción sin carpeta .git usa el commit empaquetado en dist/version-metadata.json
    }

    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || req.hostname || '').toLowerCase();
    const isDevHost =
      hostHeader.includes('ais-dev-') ||
      hostHeader.includes('localhost') ||
      hostHeader.includes('127.0.0.1');
    const isPublicProdHost =
      hostHeader.includes('ais-pre-') ||
      hostHeader.includes('ais-mob-') ||
      (!isDevHost && (process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE)));

    const distIndexExists = fs.existsSync(path.resolve(__dirname, 'dist/index.html'));
    const bundleVerified = Boolean(baseMeta.bundleCompleted && distIndexExists);

    const timeZone = 'America/Lima';
    const refIso = baseMeta.buildTimestampIso || new Date().toISOString();
    const refDate = new Date(refIso);

    const formattedDate =
      baseMeta.formattedDate ||
      new Intl.DateTimeFormat('es-PE', {
        timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }).format(refDate);

    const formattedTime =
      baseMeta.formattedTime ||
      new Intl.DateTimeFormat('es-PE', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }).format(refDate);

    const environmentLabel = isPublicProdHost ? 'PRODUCCIÓN' : 'DESARROLLO';
    const statusLabel = isPublicProdHost
      ? bundleVerified
        ? 'Publicado correctamente.'
        : 'Compilación pendiente de verificación.'
      : 'Entorno de desarrollo activo (AI Studio Preview).';

    return {
      version: pkgVersion,
      commitHash: liveCommit,
      buildTimestampIso: refIso,
      formattedDate,
      formattedTime,
      timeZone: 'America/Lima (UTC-5)',
      environment: environmentLabel,
      status: statusLabel,
      isProduction: isPublicProdHost,
      bundleVerified
    };
  }

  app.get('/api/version', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json(resolveRuntimeVersionMetadata(req));
  });

  // --------------------------------------------------------------------------
  // Healthcheck de Producción (Cloud Run / Verificación de Estado)
  // --------------------------------------------------------------------------
  app.get('/api/health', (req, res) => {
    const versionMeta = resolveRuntimeVersionMetadata(req);
    res.json({
      status: 'ok',
      service: 'control-galpones-la-calera',
      version: versionMeta.version,
      commitHash: versionMeta.commitHash,
      environmentLabel: versionMeta.environment,
      projectId: PROJECT_ID,
      firestoreDatabaseId: DATABASE_ID,
      authDomain: firebaseConfig.authDomain,
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
  });

  // --------------------------------------------------------------------------
  // Vite Middleware (Desarrollo) o Archivos Estáticos (Producción)
  // --------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Control Galpones La Calera ejecutándose en http://0.0.0.0:${PORT}`);
  });
}

startServer();
