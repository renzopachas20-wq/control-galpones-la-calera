import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
};

export const OFFICIAL_ROLES = [
  'Administrador',
  'Jefe de proyecto',
  'Supervisor',
  'Auxiliar',
  'Almacén',
  'Solo lectura',
] as const;

export type OfficialRole = (typeof OFFICIAL_ROLES)[number];

const ROOT_ADMIN_EMAIL = 'renzopachas20@gmail.com';

interface VerifiedCaller {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  idToken: string;
}

interface FirestoreFieldValue {
  stringValue?: string;
  booleanValue?: boolean;
  arrayValue?: { values?: Array<{ stringValue?: string }> };
}

function toFirestoreFields(profile: {
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
}): Record<string, FirestoreFieldValue> {
  return {
    uid: { stringValue: profile.uid },
    email: { stringValue: profile.email },
    displayName: { stringValue: profile.displayName },
    role: { stringValue: profile.role },
    active: { booleanValue: profile.active },
    assignedSectorIds: {
      arrayValue: {
        values: profile.assignedSectorIds.map((id) => ({ stringValue: String(id) })),
      },
    },
    assignedGalponIds: {
      arrayValue: {
        values: profile.assignedGalponIds.map((id) => ({ stringValue: String(id) })),
      },
    },
    createdAt: { stringValue: profile.createdAt },
    createdBy: { stringValue: profile.createdBy },
    updatedAt: { stringValue: profile.updatedAt },
    updatedBy: { stringValue: profile.updatedBy },
    lastLoginAt: { stringValue: profile.lastLoginAt },
  };
}

function fromFirestoreDoc(docObj: {
  fields?: Record<string, FirestoreFieldValue>;
}): {
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
} | null {
  const f = docObj?.fields;
  if (!f || !f.uid?.stringValue) return null;
  const rawRole = (f.role?.stringValue || 'Solo lectura') as OfficialRole;
  const role: OfficialRole = OFFICIAL_ROLES.includes(rawRole) ? rawRole : 'Solo lectura';
  return {
    uid: f.uid.stringValue || '',
    email: f.email?.stringValue || '',
    displayName: f.displayName?.stringValue || '',
    role,
    active: Boolean(f.active?.booleanValue),
    assignedSectorIds: (f.assignedSectorIds?.arrayValue?.values || [])
      .map((v) => v.stringValue || '')
      .filter(Boolean),
    assignedGalponIds: (f.assignedGalponIds?.arrayValue?.values || [])
      .map((v) => v.stringValue || '')
      .filter(Boolean),
    createdAt: f.createdAt?.stringValue || '',
    createdBy: f.createdBy?.stringValue || '',
    updatedAt: f.updatedAt?.stringValue || '',
    updatedBy: f.updatedBy?.stringValue || '',
    lastLoginAt: f.lastLoginAt?.stringValue || '',
  };
}

function getFirestoreBaseUrl(): string {
  const { projectId, firestoreDatabaseId } = firebaseConfig;
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/${encodeURIComponent(firestoreDatabaseId)}/documents`;
}

async function verifyIdTokenWithGoogle(idToken: string): Promise<VerifiedCaller> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
      firebaseConfig.apiKey
    )}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  const data = (await res.json()) as {
    users?: Array<{
      localId: string;
      email?: string;
      emailVerified?: boolean;
      displayName?: string;
      disabled?: boolean;
    }>;
    error?: { message?: string };
  };
  if (!res.ok || !data.users || data.users.length === 0) {
    const code = data?.error?.message || 'INVALID_ID_TOKEN';
    throw new Error(`TOKEN_INVALID:${code}`);
  }
  const account = data.users[0];
  if (account.disabled) {
    throw new Error('USER_DISABLED');
  }
  return {
    uid: account.localId,
    email: (account.email || '').toLowerCase(),
    emailVerified: Boolean(account.emailVerified),
    displayName: account.displayName || account.email || 'Usuario',
    idToken,
  };
}

async function fetchUserProfileFromFirestore(uid: string, idToken: string) {
  const url = `${getFirestoreBaseUrl()}/users/${encodeURIComponent(uid)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`FIRESTORE_READ_ERROR:${res.status}:${errBody}`);
  }
  const docJson = await res.json();
  return fromFirestoreDoc(docJson);
}

async function verifyAdminCaller(req: Request): Promise<{
  caller: VerifiedCaller;
  adminProfile: NonNullable<ReturnType<typeof fromFirestoreDoc>>;
}> {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('UNAUTHORIZED:Falta el token de sesión Bearer.');
  }
  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) {
    throw new Error('UNAUTHORIZED:Token de sesión vacío.');
  }

  const caller = await verifyIdTokenWithGoogle(idToken);
  let profile = await fetchUserProfileFromFirestore(caller.uid, idToken);

  // Si es el administrador raíz verificado y aún no existe su documento en /users/{uid}, inicializarlo en el servidor
  if (!profile && caller.email === ROOT_ADMIN_EMAIL && caller.emailVerified) {
    const nowIso = new Date().toISOString();
    const bootstrapProfile = {
      uid: caller.uid,
      email: caller.email,
      displayName: caller.displayName || 'Administrador General',
      role: 'Administrador' as OfficialRole,
      active: true,
      assignedSectorIds: [],
      assignedGalponIds: [],
      createdAt: nowIso,
      createdBy: caller.email,
      updatedAt: nowIso,
      updatedBy: caller.email,
      lastLoginAt: nowIso,
    };
    const createUrl = `${getFirestoreBaseUrl()}/users?documentId=${encodeURIComponent(
      caller.uid
    )}`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: toFirestoreFields(bootstrapProfile) }),
    });
    if (createRes.ok) {
      profile = bootstrapProfile;
    }
  }

  if (!profile) {
    throw new Error(
      'FORBIDDEN:Tu cuenta no tiene un perfil autorizado en Control Galpones La Calera.'
    );
  }
  if (!profile.active) {
    throw new Error(
      'FORBIDDEN:Tu cuenta de usuario ha sido desactivada. Contacta al Administrador.'
    );
  }
  if (profile.role !== 'Administrador') {
    throw new Error(
      'FORBIDDEN:Acceso denegado. Solo el rol Administrador está autorizado para gestionar usuarios.'
    );
  }

  return { caller, adminProfile: profile };
}

export function generateSecureTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%';
  const all = upper + lower + digits + symbols;
  const bytes = crypto.randomBytes(12);
  const chars = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digits[bytes[2] % digits.length],
    symbols[bytes[3] % symbols.length],
  ];
  for (let i = 4; i < 10; i++) {
    chars.push(all[bytes[i] % all.length]);
  }
  return chars.join('');
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Endpoint de verificación de sesión y estado activo desde el servidor
  app.post('/api/auth/verify-session', async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        res.status(401).json({ ok: false, code: 'NO_TOKEN', error: 'Sesión no iniciada.' });
        return;
      }
      const idToken = authHeader.slice('Bearer '.length).trim();
      const caller = await verifyIdTokenWithGoogle(idToken);
      let profile = await fetchUserProfileFromFirestore(caller.uid, idToken);

      if (!profile && caller.email === ROOT_ADMIN_EMAIL && caller.emailVerified) {
        const nowIso = new Date().toISOString();
        const bootstrapProfile = {
          uid: caller.uid,
          email: caller.email,
          displayName: caller.displayName || 'Administrador General',
          role: 'Administrador' as OfficialRole,
          active: true,
          assignedSectorIds: [],
          assignedGalponIds: [],
          createdAt: nowIso,
          createdBy: caller.email,
          updatedAt: nowIso,
          updatedBy: caller.email,
          lastLoginAt: nowIso,
        };
        const createUrl = `${getFirestoreBaseUrl()}/users?documentId=${encodeURIComponent(
          caller.uid
        )}`;
        const createRes = await fetch(createUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${idToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fields: toFirestoreFields(bootstrapProfile) }),
        });
        if (createRes.ok) {
          profile = bootstrapProfile;
        }
      }

      if (!profile) {
        res.status(403).json({
          ok: false,
          code: 'PROFILE_NOT_FOUND',
          error:
            'Tu cuenta no está registrada en el padrón de usuarios autorizados. Solicita tu alta al Administrador.',
        });
        return;
      }

      if (!profile.active) {
        res.status(403).json({
          ok: false,
          code: 'ACCOUNT_DEACTIVATED',
          error:
            'Tu cuenta ha sido desactivada por el Administrador y no tiene permiso para acceder al sistema.',
        });
        return;
      }

      res.json({ ok: true, profile });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith('TOKEN_INVALID') || msg === 'USER_DISABLED') {
        res.status(401).json({
          ok: false,
          code: 'SESSION_EXPIRED',
          error: 'Tu sesión ha expirado o no es válida. Por favor inicia sesión nuevamente.',
        });
        return;
      }
      res.status(500).json({
        ok: false,
        code: 'SERVER_ERROR',
        error: 'Error al verificar la sesión con el servidor.',
      });
    }
  });

  // Crear nuevo usuario en Firebase Auth + Firestore desde el servidor (Solo Administrador activo)
  app.post('/api/admin/users', async (req: Request, res: Response) => {
    try {
      const { caller } = await verifyAdminCaller(req);
      const {
        email,
        displayName,
        password,
        generateTempPassword,
        role,
        active = true,
        assignedSectorIds = [],
        assignedGalponIds = [],
      } = req.body || {};

      const cleanEmail = String(email || '')
        .trim()
        .toLowerCase();
      const cleanName = String(displayName || '').trim();
      const targetRole = String(role || '') as OfficialRole;

      if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) {
        res.status(400).json({
          ok: false,
          error: 'Ingresa un correo electrónico válido (máximo 254 caracteres).',
        });
        return;
      }

      if (!cleanName || cleanName.length > 150) {
        res.status(400).json({
          ok: false,
          error: 'El nombre completo del usuario es obligatorio (máximo 150 caracteres).',
        });
        return;
      }

      if (!OFFICIAL_ROLES.includes(targetRole)) {
        res.status(400).json({
          ok: false,
          error: `Rol inválido. Debe ser uno de los 6 roles oficiales: ${OFFICIAL_ROLES.join(', ')}.`,
        });
        return;
      }

      const finalPassword = generateTempPassword
        ? generateSecureTempPassword()
        : String(password || '');

      if (finalPassword.length < 6) {
        res.status(400).json({
          ok: false,
          error: 'La contraseña temporal o inicial debe tener al menos 6 caracteres.',
        });
        return;
      }

      // 1. Crear cuenta en Firebase Authentication desde el servidor (sin cerrar la sesión del Administrador)
      const signUpRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(
          firebaseConfig.apiKey
        )}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: cleanEmail,
            password: finalPassword,
            returnSecureToken: true,
          }),
        }
      );

      const signUpData = (await signUpRes.json()) as {
        localId?: string;
        idToken?: string;
        error?: { message?: string };
      };

      if (!signUpRes.ok || !signUpData.localId) {
        const errCode = signUpData?.error?.message || 'UNKNOWN_AUTH_ERROR';
        if (errCode === 'EMAIL_EXISTS') {
          res.status(409).json({
            ok: false,
            code: 'EMAIL_EXISTS',
            error: 'Este correo electrónico ya está registrado en Firebase Authentication.',
          });
          return;
        }
        if (errCode === 'PASSWORD_LOGIN_DISABLED' || errCode === 'OPERATION_NOT_ALLOWED') {
          res.status(400).json({
            ok: false,
            code: 'PASSWORD_LOGIN_DISABLED',
            error:
              'El método "Correo electrónico/contraseña" aún está deshabilitado en Firebase Console. Actívalo en Authentication > Sign-in method de tu proyecto phonic-tree-clcf1.',
          });
          return;
        }
        if (errCode.includes('WEAK_PASSWORD')) {
          res.status(400).json({
            ok: false,
            code: 'WEAK_PASSWORD',
            error: 'La contraseña es demasiado débil (mínimo 6 caracteres).',
          });
          return;
        }
        res.status(400).json({
          ok: false,
          code: errCode,
          error: `No se pudo crear la cuenta en Firebase Authentication (${errCode}).`,
        });
        return;
      }

      const newUid = signUpData.localId;

      // Actualizar displayName en Firebase Authentication
      if (signUpData.idToken) {
        await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${encodeURIComponent(
            firebaseConfig.apiKey
          )}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              idToken: signUpData.idToken,
              displayName: cleanName,
              returnSecureToken: false,
            }),
          }
        ).catch(() => undefined);
      }

      // 2. Guardar el perfil en Cloud Firestore (/users/{newUid}) SIN almacenar la contraseña
      const nowIso = new Date().toISOString();
      const newProfile = {
        uid: newUid,
        email: cleanEmail,
        displayName: cleanName,
        role: targetRole,
        active: Boolean(active),
        assignedSectorIds: Array.isArray(assignedSectorIds)
          ? assignedSectorIds.map(String).slice(0, 100)
          : [],
        assignedGalponIds: Array.isArray(assignedGalponIds)
          ? assignedGalponIds.map(String).slice(0, 200)
          : [],
        createdAt: nowIso,
        createdBy: caller.email,
        updatedAt: nowIso,
        updatedBy: caller.email,
        lastLoginAt: '',
      };

      const createDocUrl = `${getFirestoreBaseUrl()}/users?documentId=${encodeURIComponent(
        newUid
      )}`;
      const createDocRes = await fetch(createDocUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${caller.idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: toFirestoreFields(newProfile) }),
      });

      if (!createDocRes.ok) {
        const errText = await createDocRes.text();
        res.status(403).json({
          ok: false,
          code: 'FIRESTORE_CREATE_DENIED',
          error: `Las reglas de Firestore rechazaron la creación del perfil: ${errText}`,
        });
        return;
      }

      res.status(201).json({
        ok: true,
        profile: newProfile,
        temporaryPassword: finalPassword,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith('UNAUTHORIZED:')) {
        res.status(401).json({ ok: false, error: msg.slice('UNAUTHORIZED:'.length) });
        return;
      }
      if (msg.startsWith('TOKEN_INVALID') || msg === 'USER_DISABLED') {
        res.status(401).json({
          ok: false,
          code: 'SESSION_EXPIRED',
          error: 'Token de sesión inválido, vencido o cuenta deshabilitada.',
        });
        return;
      }
      if (msg.startsWith('FORBIDDEN:')) {
        res.status(403).json({ ok: false, error: msg.slice('FORBIDDEN:'.length) });
        return;
      }
      res.status(500).json({
        ok: false,
        error: 'Error interno del servidor al procesar la creación de usuario.',
      });
    }
  });

  // Actualizar datos, rol o estado activo/inactivo de un usuario desde el servidor (Solo Administrador activo)
  app.patch('/api/admin/users/:uid', async (req: Request, res: Response) => {
    try {
      const { caller } = await verifyAdminCaller(req);
      const targetUid = String(req.params.uid || '').trim();
      if (!targetUid) {
        res.status(400).json({ ok: false, error: 'UID de usuario requerido.' });
        return;
      }

      const existingProfile = await fetchUserProfileFromFirestore(targetUid, caller.idToken);
      if (!existingProfile) {
        res.status(404).json({ ok: false, error: 'El perfil de usuario no existe en Firestore.' });
        return;
      }

      const { displayName, role, active, assignedSectorIds, assignedGalponIds } = req.body || {};

      const nextRole: OfficialRole =
        role !== undefined ? (String(role) as OfficialRole) : existingProfile.role;
      if (!OFFICIAL_ROLES.includes(nextRole)) {
        res.status(400).json({
          ok: false,
          error: `Rol inválido. Debe ser uno de los 6 roles oficiales: ${OFFICIAL_ROLES.join(', ')}.`,
        });
        return;
      }

      const nextActive = active !== undefined ? Boolean(active) : existingProfile.active;

      if (targetUid === caller.uid && (!nextActive || nextRole !== 'Administrador')) {
        res.status(400).json({
          ok: false,
          error:
            'Por seguridad, no puedes desactivar tu propia cuenta ni quitarte el rol de Administrador.',
        });
        return;
      }

      const updatedProfile = {
        ...existingProfile,
        displayName:
          displayName !== undefined
            ? String(displayName).trim() || existingProfile.displayName
            : existingProfile.displayName,
        role: nextRole,
        active: nextActive,
        assignedSectorIds: Array.isArray(assignedSectorIds)
          ? assignedSectorIds.map(String).slice(0, 100)
          : existingProfile.assignedSectorIds,
        assignedGalponIds: Array.isArray(assignedGalponIds)
          ? assignedGalponIds.map(String).slice(0, 200)
          : existingProfile.assignedGalponIds,
        updatedAt: new Date().toISOString(),
        updatedBy: caller.email,
      };

      const patchUrl = `${getFirestoreBaseUrl()}/users/${encodeURIComponent(targetUid)}`;
      const patchRes = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${caller.idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: toFirestoreFields(updatedProfile) }),
      });

      if (!patchRes.ok) {
        const errText = await patchRes.text();
        res.status(403).json({
          ok: false,
          error: `Firestore rechazó la actualización del perfil: ${errText}`,
        });
        return;
      }

      res.json({ ok: true, profile: updatedProfile });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith('UNAUTHORIZED:')) {
        res.status(401).json({ ok: false, error: msg.slice('UNAUTHORIZED:'.length) });
        return;
      }
      if (msg.startsWith('TOKEN_INVALID') || msg === 'USER_DISABLED') {
        res.status(401).json({
          ok: false,
          code: 'SESSION_EXPIRED',
          error: 'Token de sesión inválido, vencido o cuenta deshabilitada.',
        });
        return;
      }
      if (msg.startsWith('FORBIDDEN:')) {
        res.status(403).json({ ok: false, error: msg.slice('FORBIDDEN:'.length) });
        return;
      }
      res.status(500).json({
        ok: false,
        error: 'Error del servidor al actualizar el perfil de usuario.',
      });
    }
  });

  // Enviar correo de recuperación de contraseña desde el servidor
  app.post('/api/admin/users/:uid/reset-password', async (req: Request, res: Response) => {
    try {
      const { caller } = await verifyAdminCaller(req);
      const targetUid = String(req.params.uid || '').trim();
      const existingProfile = await fetchUserProfileFromFirestore(targetUid, caller.idToken);
      if (!existingProfile || !existingProfile.email) {
        res.status(404).json({ ok: false, error: 'Usuario no encontrado.' });
        return;
      }

      const oobRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(
          firebaseConfig.apiKey
        )}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestType: 'PASSWORD_RESET',
            email: existingProfile.email,
          }),
        }
      );
      const oobData = (await oobRes.json()) as { error?: { message?: string } };
      if (!oobRes.ok) {
        res.status(400).json({
          ok: false,
          error: `No se pudo enviar el correo de restablecimiento (${
            oobData?.error?.message || 'ERROR'
          }).`,
        });
        return;
      }

      res.json({
        ok: true,
        message: `Correo de restablecimiento enviado a ${existingProfile.email}.`,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith('UNAUTHORIZED:')) {
        res.status(401).json({ ok: false, error: msg.slice('UNAUTHORIZED:'.length) });
        return;
      }
      if (msg.startsWith('TOKEN_INVALID') || msg === 'USER_DISABLED') {
        res.status(401).json({
          ok: false,
          code: 'SESSION_EXPIRED',
          error: 'Token de sesión inválido, vencido o cuenta deshabilitada.',
        });
        return;
      }
      if (msg.startsWith('FORBIDDEN:')) {
        res.status(403).json({ ok: false, error: msg.slice('FORBIDDEN:'.length) });
        return;
      }
      res.status(500).json({
        ok: false,
        error: 'Error del servidor al enviar el correo de recuperación.',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
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
    console.log(`Servidor Control Galpones La Calera activo en http://0.0.0.0:${PORT}`);
  });
}

void startServer();
