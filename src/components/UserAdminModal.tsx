import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Users,
  UserPlus,
  Shield,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  KeyRound,
  Edit3,
  Copy,
  Check,
  RefreshCw,
  CreditCard,
  Table2
} from 'lucide-react';
import {
  OFFICIAL_ROLES,
  PRIMARY_ADMIN_UID,
  adminListUsers,
  adminCreateUser,
  adminUpdateUser,
  adminGenerateTempPassword,
  adminListReservations,
  adminManageReservation,
  adminListCredentialOperations,
  adminListAuthMethods,
  adminReconcileCredential,
  adminCancelReadyPassword,
  adminEmergencyDisable,
  adminRevokeSessions,
  type CredentialOperationStatus,
  type ProvisioningReservation,
  type OfficialRole,
  type AuthMethod,
  type UpdateUserInput,
  type UserProfile
} from '../firebase/authService';
import { preferCurrentProfile } from '../firebase/profileVersion';
import { describeEmergencyStatus, type EmergencyStatus } from '../firebase/emergencyStatus';
import {
  ROLE_PERMISSION_MATRIX,
  MODULE_LABELS,
  ACTION_LABELS,
  type AppModuleId,
  type PermissionAction
} from '../firebase/permissions';

interface UserAdminModalProps {
  currentUserProfile: UserProfile;
  onClose: () => void;
}

const ROLE_DESCRIPTIONS: Record<OfficialRole, string> = {
  'Administrador':
    'Acceso total al sistema, gestión de usuarios, roles, catálogo maestro, sectores, galpones, materiales, personal y auditoría.',
  'Jefe de proyecto':
    'Gestión de cronogramas, sectores, galpones, avances, asistencia e informes. Catálogo, actividades, materiales y personal en consulta.',
  'Supervisor':
    'Consulta de sectores y galpones, registro y edición de avances diarios y las demás acciones de la matriz del rol.',
  'Auxiliar':
    'Apoyo operativo en avances, asistencia, galpones y personal. Puede consultar la bitácora. Dashboard, Gantt y catálogo están restringidos.',
  'Almacén':
    'Control especializado de inventario de materiales: ingresos, salidas, stock mínimo, kardex y alertas por galpón.',
  'Solo lectura':
    'El perfil puede autenticarse. La matriz vigente no habilita módulos operativos para este rol.'
};

const AUTH_METHOD_LABELS: Record<AuthMethod, string> = {
  password: 'Correo y contraseña',
  google: 'Google (Pre-autorizado)',
  both: 'Ambos (Contraseña + Google)'
};

function generateRandomPassword(): string {
  return 'Calera#9' + Array.from(crypto.getRandomValues(new Uint8Array(18)),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

export const UserAdminModal: React.FC<UserAdminModalProps> = ({
  currentUserProfile,
  onClose
}) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const knownProfiles = useRef(new Map<string, UserProfile>());
  const [reservations, setReservations] = useState<ProvisioningReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | (EmergencyStatus & { additional: string }) | null>(null);

  // Vistas del modal: lista, crear, editar, matriz de permisos
  const [viewMode, setViewMode] = useState<'list' | 'create' | 'edit' | 'matrix'>('list');
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const editOperationIds = useRef(new Map<string, string>());
  const sessionOperationIds = useRef(new Map<string, string>());
  const passwordRequests = useRef(new Map<string, { id: string; password: string }>());
  const [cancellablePassword, setCancellablePassword] = useState<string | null>(null);
  const [matrixSelectedRole, setMatrixSelectedRole] = useState<OfficialRole>('Administrador');

  // Formulario de Usuario (Crear / Editar)
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formDni, setFormDni] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formAuthMethod, setFormAuthMethod] = useState<AuthMethod>('password');
  const [availableAuthMethods, setAvailableAuthMethods] = useState<AuthMethod[]>([]);
  const [formPassword, setFormPassword] = useState(generateRandomPassword());
  const [formRole, setFormRole] = useState<OfficialRole>('Supervisor');
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);

  // Modal de Contraseña Temporal Generada
  const [generatedTempCreds, setGeneratedTempCreds] = useState<{
    uid: string;
    operationId: string;
    profileVersion: number;
    credentialVersion: number;
    displayName: string;
    email: string;
    tempPassword: string;
  } | null>(null);
  const visibleTempCreds = generatedTempCreds && users.some(user =>
    user.uid === generatedTempCreds.uid && (user.profileVersion ?? 0) === generatedTempCreds.profileVersion &&
    (user.credentialVersion ?? 0) === generatedTempCreds.credentialVersion
  ) ? generatedTempCreds : null;
  useEffect(() => {
    if (generatedTempCreds && !visibleTempCreds) setGeneratedTempCreds(null);
  }, [generatedTempCreds, visibleTempCreds]);

  const rememberVersion = (received: UserProfile) => {
    const known = knownProfiles.current.get(received.uid);
    const current = known ? preferCurrentProfile(known, received) : received;
    knownProfiles.current.set(received.uid, current);
    return current;
  };

  const rememberUser = (updated: UserProfile) => {
    const current = rememberVersion(updated);
    setUsers(prev => prev.map(user => user.uid === current.uid ? preferCurrentProfile(user, current) : user));
  };

  useEffect(() => {
    if (!generatedTempCreds) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const verify = async () => {
      const profile = await adminListUsers().then(list => list.find(user => user.uid === generatedTempCreds.uid)).catch(() => undefined);
      if (stopped) return;
      if (!profile) {
        setGeneratedTempCreds(null);
        return;
      }
      rememberUser(profile);
      timer = setTimeout(verify, 5_000);
    };
    timer = setTimeout(verify, 5_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [generatedTempCreds]);

  const fetchUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, incomplete] = await Promise.all([adminListUsers(), adminListReservations()]);
      const currentList = list.map(rememberVersion);
      setUsers(prev => {
        const existing = new Map<string, UserProfile>(prev.map(user => [user.uid, user]));
        return currentList.map(user => {
          const known = existing.get(user.uid);
          return known ? preferCurrentProfile(known, user) : user;
        });
      });
      setReservations(incomplete);
      return currentList;
    } catch (err: any) {
      setError(err?.message || 'Error al cargar la lista de usuarios.');
    } finally {
      setLoading(false);
    }
  };

  const applyProfileResult = async (result: { user: UserProfile | null; profileRefreshRequired: boolean }, uid?: string) => {
    if (result.profileRefreshRequired) return (await fetchUsers())?.find(user => user.uid === uid) ?? null;
    if (result.user) rememberUser(result.user);
    return result.user;
  };

  function showEmergencyStatus(status: EmergencyStatus, additional = '') {
    setSuccessBanner(previous => {
      if (previous && typeof previous !== 'string' && previous.operation.id === status.operation.id &&
          previous.operation.state === 'completed' && status.operation.state === 'pending') return previous;
      return { ...status, additional };
    });
  }

  function pendingOperationMessage(operation: CredentialOperationStatus) {
    if (operation.profileApplied === true) {
      return `Cambio aplicado en la aplicación. Revocación en Firebase Auth pendiente. Consulte Operaciones. Referencia ${operation.id}.`;
    }
    return `Cambio pendiente de confirmación. Consulte Operaciones. Referencia ${operation.id}.`;
  }

  useEffect(() => {
    fetchUsers();
  }, []);

  useEffect(() => {
    let current = true;
    setAvailableAuthMethods([]);
    if (viewMode === 'edit' && editingUser) {
      adminListAuthMethods(editingUser.uid).then(methods => {
        if (current) setAvailableAuthMethods(methods);
      }).catch(() => {
        if (current) setError('No se pudieron verificar los proveedores de este usuario.');
      });
    }
    return () => { current = false; };
  }, [viewMode, editingUser]);

  const openCreateForm = () => {
    setError(null);
    setSuccessBanner(null);
    setFormDisplayName('');
    setFormDni('');
    setFormEmail('');
    setFormAuthMethod('password');
    setFormPassword(generateRandomPassword());
    setFormRole('Supervisor');
    setFormActive(true);
    setViewMode('create');
  };

  const openEditForm = (u: UserProfile) => {
    setError(null);
    setSuccessBanner(null);
    editOperationIds.current = new Map();
    setEditingUser(u);
    setFormDisplayName(u.displayName);
    setFormDni(u.dni || '');
    setFormEmail(u.email);
    setFormAuthMethod(u.authMethod || 'password');
    setFormRole(u.role);
    setFormActive(u.active);
    setViewMode('edit');
  };

  const handleCopyPassword = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPass(true);
    setTimeout(() => setCopiedPass(false), 2000);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessBanner(null);
    setSaving(true);

    try {
      const created = await adminCreateUser({
        email: formEmail.trim().toLowerCase(),
        password: formAuthMethod === 'google' ? undefined : formPassword,
        displayName: formDisplayName.trim(),
        dni: formDni.trim(),
        authMethod: formAuthMethod,
        role: formRole,
        active: formActive,
      });

      setUsers((prev) => [created, ...prev.filter((u) => u.uid !== created.uid)]);
      setSuccessBanner(
        `Usuario ${created.displayName} (${created.email}) creado con rol ${created.role} y método "${AUTH_METHOD_LABELS[created.authMethod || 'password']}".`
      );
      setViewMode('list');
    } catch (err: any) {
      setError(err?.message || 'Error al crear el usuario.');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setError(null);
    setSuccessBanner(null);
    setSaving(true);

    const operationIds = editOperationIds.current;
    try {
      const updates: UpdateUserInput = {
        expectedProfileVersion: editingUser.profileVersion ?? 0,
        displayName: formDisplayName.trim(),
        dni: formDni.trim(),
        email: formEmail.trim().toLowerCase(),
        authMethod: formAuthMethod,
        role: formRole,
        active: formActive,
      };
      const submission = JSON.stringify(updates);
      const operationId = operationIds.get(submission) ?? crypto.randomUUID();
      operationIds.set(submission, operationId);
      const result = await adminUpdateUser(editingUser.uid, {
        ...updates, operationId
      });
      const current = await applyProfileResult(result, editingUser.uid);
      if (editOperationIds.current !== operationIds) return;
      const { user: updated, authEmailSyncNote, operation } = result;
      const known = knownProfiles.current.get(editingUser.uid);
      const outdated = updated && known && preferCurrentProfile(known, updated) !== updated;
      const additional = result.profileEdit && result.profileEdit.state !== 'completed'
        ? ' La edición adicional requiere revisión. Referencia ' + result.profileEdit.id + '.'
        : result.passwordRequiresSeparateRequest ? ' Use Clave Temp. para cambiar la contraseña por separado.' : '';
      if (operation?.kind === 'emergency') {
        showEmergencyStatus({ operation, user: current, currentAuthentication: result.currentAuthentication }, additional);
        setEditingUser(null);
        setViewMode('list');
        return;
      }
      if (operation?.state === 'pending') {
        setSuccessBanner(pendingOperationMessage(operation) + additional);
        setViewMode('list');
        return;
      }
      const emailMsg =
        updated && !outdated && editingUser.email !== updated.email
          ? ` Correo actualizado a ${updated.email} (${authEmailSyncNote || 'UID preservado'}).`
          : '';
      setSuccessBanner(
        (outdated ? 'Operación confirmada. La lista conserva la versión más reciente.' :
          'Perfil de ' + (updated?.displayName ?? editingUser.displayName) + ' actualizado correctamente.' + emailMsg) +
        additional + (operation?.audit === 'pending' ? ' Bitácora pendiente.' : '')
      );
      setEditingUser(null);
      setViewMode('list');
    } catch (err: any) {
      if (editOperationIds.current === operationIds) setError(err?.message || 'Error al actualizar el usuario.');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickToggleActive = async (u: UserProfile) => {
    if (u.uid === currentUserProfile.uid) {
      setError('Por seguridad, no puede desactivar su propia cuenta de Administrador.');
      return;
    }
    setError(null);
    setSuccessBanner(null);
    try {
      const key = `${u.uid}:${u.profileVersion ?? 0}:${!u.active}`;
      const operationId = sessionOperationIds.current.get(key) ?? crypto.randomUUID();
      sessionOperationIds.current.set(key, operationId);
      const result = u.active && !u.uid.startsWith('preauth_') ? await adminEmergencyDisable(u.uid, operationId) :
        await adminUpdateUser(u.uid, {
        expectedProfileVersion: u.profileVersion ?? 0, active: !u.active, operationId
      });
      const current = await applyProfileResult(result, u.uid);
      if (result.operation?.state !== 'pending') {
        sessionOperationIds.current.delete(key);
      }
      if (result.operation?.kind === 'emergency') {
        showEmergencyStatus({ operation: result.operation, user: current, currentAuthentication: result.currentAuthentication });
      } else if (result.operation?.state === 'pending') {
        setSuccessBanner(pendingOperationMessage(result.operation));
      } else if (current && preferCurrentProfile(current, knownProfiles.current.get(u.uid) ?? current).active === !u.active) {
        setSuccessBanner(`Usuario ${u.displayName} ${!u.active ? 'activado' : 'desactivado'}.`);
      } else {
        setSuccessBanner('Operación confirmada. Consulte el estado de la cuenta en la lista.');
      }
    } catch (err: any) {
      setError(err?.message || 'Error al cambiar el estado del usuario.');
    }
  };

  const handleGenerateTempPassword = async (u: UserProfile) => {
    setError(null);
    setSuccessBanner(null);
    const request = passwordRequests.current.get(u.uid) ?? { id: crypto.randomUUID(), password: generateRandomPassword() };
    setGeneratedTempCreds(current => current?.uid === u.uid ? null : current);
    passwordRequests.current.set(u.uid, request);
    try {
      const result = await adminGenerateTempPassword(u.uid, request.password, request.id);
      await applyProfileResult(result, u.uid);
      if (passwordRequests.current.get(u.uid) !== request) return;
      const checked = result.tempPassword ? await fetchUsers() : undefined;
      if (passwordRequests.current.get(u.uid) !== request) return;
      showPasswordResult(u.uid, request.id, result, checked?.some(user => user.uid === u.uid) === true);
      if (result.operation.state === 'completed') passwordRequests.current.delete(u.uid);
    } catch (err: any) {
      if (err?.definitiveFailure) passwordRequests.current.delete(u.uid);
      setError(err?.message || 'Error al generar contraseña temporal.');
    }
  };

  function showPasswordResult(uid: string, operationId: string, result: Awaited<ReturnType<typeof adminGenerateTempPassword>>, confirmed: boolean) {
    const current = knownProfiles.current.get(uid);
    if (confirmed && result.tempPassword && current && result.user?.uid === uid && result.operation.uid === uid &&
        result.operation.id === operationId && (result.user.profileVersion ?? 0) === (current.profileVersion ?? 0) &&
        result.operation.version === current.credentialVersion &&
        (result.providerAcknowledged || result.operation.state === 'completed')) {
      setGeneratedTempCreds({ uid, operationId, profileVersion: current.profileVersion ?? 0, credentialVersion: current.credentialVersion,
        displayName: current.displayName, email: current.email, tempPassword: result.tempPassword });
    }
    const audit = result.operation.audit === 'pending' && result.operation.state === 'completed' ? ' Bitácora pendiente.' : '';
    setSuccessBanner(`${result.message}${audit} Referencia ${result.operation.id}.`);
  }

  const handleReconcileOperations = async (u: UserProfile) => {
    setError(null);
    setSuccessBanner(null);
    setCancellablePassword(null);
    try {
      const operations = await adminListCredentialOperations(u.uid);
      if (!operations.length) {
        setSuccessBanner('No hay operaciones pendientes que pueda gestionar.');
        return;
      }
      for (const operation of operations) {
        if (operation.kind === 'password' && operation.authentication === 'ready') {
          const request = passwordRequests.current.get(u.uid);
          if (request?.id !== operation.id) {
            setError('La contraseña original ya no está disponible. Puede cancelar esta solicitud sin enviar una contraseña a Firebase.');
            setCancellablePassword(operation.id);
            continue;
          }
          await handleGenerateTempPassword(u);
        } else {
          const result = await adminReconcileCredential(operation.id);
          const current = await applyProfileResult(result, result.operation.uid);
          if (operation.kind === 'password' && result.operation.state === 'completed') passwordRequests.current.delete(u.uid);
          if (result.operation.kind === 'emergency') {
            showEmergencyStatus({ operation: result.operation, user: current, currentAuthentication: result.currentAuthentication });
          } else {
            setSuccessBanner(result.operation.state === 'completed'
              ? `Operación confirmada. Bitácora ${result.operation.audit === 'recorded' ? 'registrada' : 'pendiente'}.`
              : pendingOperationMessage(result.operation));
          }
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Error al comprobar las operaciones.');
    }
  };

  const handleCancelReadyPassword = async (id: string) => {
    try {
      await adminCancelReadyPassword(id);
      setCancellablePassword(null);
      setError(null);
      setSuccessBanner('Solicitud cancelada. Ya puede generar una nueva contraseña temporal.');
    } catch (err: any) {
      setError(err?.message || 'No se pudo cancelar la solicitud.');
    }
  };

  const handleReservation = async (reservation: ProvisioningReservation, action: 'resume' | 'cancel') => {
    setError(null);
    try {
      const password = action === 'resume' && ['ready', 'rejected'].includes(reservation.state)
        ? generateRandomPassword() : undefined;
      const result = await adminManageReservation(reservation.uid, action, password);
      await fetchUsers();
      const current = knownProfiles.current.get(reservation.uid);
      if (password && result.passwordApplied && current && result.user?.uid === current.uid &&
          (result.user.profileVersion ?? 0) === (current.profileVersion ?? 0)) {
        setGeneratedTempCreds({ uid: current.uid, operationId: reservation.uid, profileVersion: current.profileVersion ?? 0,
          credentialVersion: current.credentialVersion ?? 0,
          displayName: current.displayName, email: current.email, tempPassword: password });
      }
      setSuccessBanner(action === 'resume' ? 'Alta reconciliada.' : 'Reserva vencida cancelada.');
    } catch (err: any) {
      setError(err?.message || 'No se pudo gestionar la reserva.');
    }
  };

  const handleRevokeSessions = async (u: UserProfile) => {
    setError(null);
    try {
      const key = `revoke:${u.uid}`;
      const operationId = sessionOperationIds.current.get(key) ?? crypto.randomUUID();
      sessionOperationIds.current.set(key, operationId);
      const result = await adminRevokeSessions(u.uid, operationId);
      await applyProfileResult(result);
      if (result.firebaseRevoked) sessionOperationIds.current.delete(key);
      setSuccessBanner(result.firebaseRevoked
        ? 'Sesiones revocadas en la aplicación y Firebase Auth.'
        : pendingOperationMessage(result.operation));
    } catch (err: any) {
      setError(err?.message || 'No se pudieron revocar las sesiones.');
    }
  };

  return (
    <div className="modal-viewport fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex justify-center p-3 sm:p-6">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Cabecera */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center">
              <Users className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold tracking-tight">
                Administración de Usuarios, Cuentas Google y Matriz de Roles
              </h2>
              <p className="text-xs text-slate-400">
                Control Galpones La Calera • Gestión exclusiva para Administrador
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Barra de Acciones y Alertas */}
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-slate-900 text-white'
                  : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-100'
              }`}
            >
              Usuarios Registrados ({users.length})
            </button>
            <button
              type="button"
              onClick={openCreateForm}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                viewMode === 'create'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Nuevo Usuario</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('matrix')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                viewMode === 'matrix'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-indigo-700 border border-indigo-200 hover:bg-indigo-50'
              }`}
            >
              <Table2 className="w-3.5 h-3.5" />
              <span>Matriz Oficial de Permisos (6 Roles × 11 Módulos)</span>
            </button>
          </div>

          <button
            type="button"
            onClick={fetchUsers}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Actualizar</span>
          </button>
        </div>

        {/* Banners de Notificación */}
        {error && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-700">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span>{error}</span>
            {cancellablePassword && (
              <button type="button" className="font-semibold underline" onClick={() => handleCancelReadyPassword(cancellablePassword)}>
                Cancelar solicitud de contraseña
              </button>
            )}
          </div>
        )}

        {successBanner && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-2.5 text-xs text-emerald-800">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>{typeof successBanner === 'string' ? successBanner :
              describeEmergencyStatus(successBanner, users.find(user => user.uid === successBanner.operation.uid)) + successBanner.additional}</span>
          </div>
        )}

        {/* Recuadro de Contraseña Temporal Generada */}
        {visibleTempCreds && (
          <div className="mx-6 mt-4 p-4 rounded-xl bg-indigo-50 border border-indigo-200 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div>
              <div className="font-bold text-indigo-950">
                Contraseña temporal asignada para {visibleTempCreds.displayName} ({visibleTempCreds.email})
              </div>
              <div className="text-indigo-700 mt-0.5">
                Por seguridad Zero Trust, esta clave no se almacena en Firestore. Cópiela ahora:
              </div>
            </div>
            <div className="flex items-center gap-2">
              <code className="px-3 py-1.5 rounded-lg bg-white border border-indigo-300 font-mono text-sm font-bold text-indigo-900">
                {visibleTempCreds.tempPassword}
              </code>
              <button
                type="button"
                onClick={() => handleCopyPassword(visibleTempCreds.tempPassword)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold cursor-pointer"
              >
                {copiedPass ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedPass ? 'Copiada' : 'Copiar'}</span>
              </button>
              <button
                type="button"
                onClick={() => setGeneratedTempCreds(null)}
                className="p-1.5 text-indigo-500 hover:text-indigo-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Cuerpo Principal */}
        <div className="p-6 overflow-y-auto flex-1">
          {viewMode === 'list' && reservations.length > 0 && (
            <section className="mb-4 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
              <h3 className="font-semibold">Altas pendientes de confirmación</h3>
              {reservations.map(reservation => (
                <div key={reservation.uid} className="flex flex-wrap items-center gap-2">
                  <span>{reservation.displayName} · {reservation.email} · {reservation.state}</span>
                  {reservation.manageable && (
                    <button type="button" className="rounded bg-white px-2 py-1"
                      onClick={() => handleReservation(reservation, 'resume')}>Reanudar</button>
                  )}
                  {reservation.manageable && Date.parse(reservation.expiresAt) <= Date.now() &&
                    ['ready', 'rejected'].includes(reservation.state) && (
                    <button type="button" className="rounded bg-white px-2 py-1"
                      onClick={() => handleReservation(reservation, 'cancel')}>Cancelar reserva vencida</button>
                  )}
                </div>
              ))}
            </section>
          )}
          {viewMode === 'matrix' ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Matriz Oficial de Roles y Permisos por Módulo
                  </h3>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Seleccione cualquiera de los 6 roles oficiales para inspeccionar sus permisos de Consultar, Crear, Editar, Eliminar, Importar y Exportar en los 11 módulos.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {OFFICIAL_ROLES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setMatrixSelectedRole(r)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                        matrixSelectedRole === r
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-indigo-50/70 border border-indigo-200 text-xs text-indigo-950">
                <span className="font-bold">{matrixSelectedRole}:</span>{' '}
                {ROLE_DESCRIPTIONS[matrixSelectedRole]}
              </div>

              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-900 text-white">
                      <th className="py-3 px-4 font-semibold">Módulo del Sistema (11)</th>
                      {(Object.keys(ACTION_LABELS) as PermissionAction[]).map((act) => (
                        <th key={act} className="py-3 px-3 text-center font-semibold">
                          {ACTION_LABELS[act]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {(Object.keys(MODULE_LABELS) as AppModuleId[]).map((modId) => {
                      const perms = ROLE_PERMISSION_MATRIX[matrixSelectedRole][modId];
                      return (
                        <tr key={modId} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-semibold text-slate-800">
                            {MODULE_LABELS[modId]}
                          </td>
                          {(Object.keys(ACTION_LABELS) as PermissionAction[]).map((act) => (
                            <td key={act} className="py-2.5 px-3 text-center">
                              {perms[act] ? (
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 text-emerald-700">
                                  <Check className="w-3.5 h-3.5" />
                                </span>
                              ) : (
                                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 text-slate-400">
                                  <X className="w-3.5 h-3.5" />
                                </span>
                              )}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : viewMode === 'list' ? (
            loading ? (
              <div className="py-16 flex flex-col items-center justify-center text-slate-500 gap-2">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
                <span className="text-xs font-medium">Cargando usuarios desde Firestore...</span>
              </div>
            ) : users.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-sm">
                No se encontraron usuarios registrados.
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700 border-b border-slate-200">
                      <th className="py-3 px-4 font-semibold">Usuario / DNI / Correo</th>
                      <th className="py-3 px-4 font-semibold">Método Acceso</th>
                      <th className="py-3 px-4 font-semibold">Rol Oficial</th>
                      <th className="py-3 px-4 font-semibold">Estado</th>
                      <th className="py-3 px-4 font-semibold">Último Acceso</th>
                      <th className="py-3 px-4 font-semibold text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {users.map((u) => (
                      <tr key={u.uid} className="hover:bg-slate-50/80 transition">
                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-900 flex items-center gap-1.5">
                            <span>{u.displayName}</span>
                            {u.uid === currentUserProfile.uid && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-semibold">
                                Tú
                              </span>
                            )}
                          </div>
                          <div className="text-slate-600 font-medium">{u.email}</div>
                          <div className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                            <span>DNI: {u.dni || 'No registrado'}</span>
                            <span>•</span>
                            <span className="font-mono" title="UID permanente en Firebase">
                              UID: {u.uid.slice(0, 10)}...
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 border border-slate-300 text-slate-700 font-medium text-[11px]">
                            {AUTH_METHOD_LABELS[u.authMethod || 'password']}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 font-semibold">
                            <Shield className="w-3 h-3" />
                            <span>{u.role}</span>
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          {u.active ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-semibold">
                              <CheckCircle2 className="w-3 h-3" />
                              <span>Activo</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-800 font-semibold">
                              <XCircle className="w-3 h-3" />
                              <span>Inactivo</span>
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-500">
                          <div>
                            {u.lastLoginAt
                              ? new Date(u.lastLoginAt).toLocaleString('es-PE', {
                                  dateStyle: 'short',
                                  timeStyle: 'short'
                                })
                              : 'Sin ingresos aún'}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            Creado:{' '}
                            {u.createdAt
                              ? new Date(u.createdAt).toLocaleDateString('es-PE')
                              : '-'}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                            <button
                              type="button"
                              onClick={() => openEditForm(u)}
                              className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium inline-flex items-center gap-1 transition cursor-pointer"
                              title="Editar usuario, correo electrónico, DNI, rol y alcance"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>Editar</span>
                            </button>
                            {u.authMethod !== 'google' && !u.uid.startsWith('preauth_') &&
                              (u.uid !== PRIMARY_ADMIN_UID || u.uid === currentUserProfile.uid) && (
                              <button
                                type="button"
                                onClick={() => handleGenerateTempPassword(u)}
                                className="px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-medium inline-flex items-center gap-1 transition cursor-pointer"
                                title="Generar nueva contraseña temporal"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                                <span>Clave Temp.</span>
                              </button>
                            )}
                            {!u.uid.startsWith('preauth_') &&
                              (u.uid !== PRIMARY_ADMIN_UID || u.uid === currentUserProfile.uid || !u.active) && (
                                <button type="button" className="px-2.5 py-1 rounded-lg bg-slate-100"
                                  onClick={() => handleReconcileOperations(u)}>Operaciones</button>
                            )}
                            {!u.uid.startsWith('preauth_') &&
                              (u.uid !== PRIMARY_ADMIN_UID || u.uid === currentUserProfile.uid) && (
                                <button type="button" className="px-2.5 py-1 rounded-lg bg-amber-50"
                                  onClick={() => handleRevokeSessions(u)}>Revocar sesiones</button>
                            )}
                            {u.uid !== currentUserProfile.uid && (u.uid !== PRIMARY_ADMIN_UID || !u.active) && (
                              <button
                                type="button"
                                onClick={() => handleQuickToggleActive(u)}
                                className={`px-2.5 py-1 rounded-lg font-medium transition cursor-pointer ${
                                  u.active
                                    ? 'bg-red-50 hover:bg-red-100 text-red-700'
                                    : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'
                                }`}
                              >
                                {u.active ? 'Desactivar' : 'Activar'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <form
              onSubmit={viewMode === 'create' ? handleCreateUser : handleUpdateUser}
              className="space-y-6 max-w-4xl mx-auto"
            >
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    {viewMode === 'create'
                      ? 'Registrar Nuevo Usuario Autorizado'
                      : `Editar Usuario: ${editingUser?.displayName}`}
                  </h3>
                  {viewMode === 'edit' && editingUser && (
                    <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
                      UID permanente: {editingUser.uid} (se conserva intacto aunque cambie el correo)
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className="text-xs text-slate-500 hover:text-slate-800 font-medium cursor-pointer"
                >
                  Cancelar y volver a la lista
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nombre Completo *
                  </label>
                  <input
                    type="text"
                    required
                    value={formDisplayName}
                    onChange={(e) => setFormDisplayName(e.target.value)}
                    placeholder="Ej. Juan Pérez Quispe"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    DNI / Documento de Identidad
                  </label>
                  <div className="relative">
                    <CreditCard className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      maxLength={15}
                      value={formDni}
                      onChange={(e) => setFormDni(e.target.value.replace(/[^0-9A-Za-z-]/g, ''))}
                      placeholder="Ej. 45892103"
                      className="w-full pl-9 pr-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Correo Electrónico *
                  </label>
                  <input
                    type="email"
                    required
                    value={formEmail}
                    onChange={(e) => setFormEmail(e.target.value)}
                    placeholder="usuario@lacalera.pe"
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:border-indigo-500"
                  />
                  {viewMode === 'edit' && editingUser && formEmail.trim().toLowerCase() !== editingUser.email && (
                    <p className="text-[11px] text-amber-700 mt-1 font-medium">
                      Al guardar, se actualizará el correo conservando el mismo UID ({editingUser.uid.slice(0, 8)}...) y todo su historial.
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Método de Autenticación Habilitado *
                  </label>
                  <select
                    value={formAuthMethod}
                    disabled={Boolean(editingUser && (editingUser.uid.startsWith('preauth_') ||
                      (editingUser.uid === PRIMARY_ADMIN_UID && currentUserProfile.uid !== PRIMARY_ADMIN_UID)))}
                    onChange={(e) => setFormAuthMethod(e.target.value as AuthMethod)}
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="password" disabled={viewMode === 'edit' && !availableAuthMethods.includes('password')}>
                      Correo y contraseña
                    </option>
                    <option value="google" disabled={viewMode === 'edit' && !availableAuthMethods.includes('google')}>
                      {viewMode === 'create' ? 'Solo Google (Preautorizar)' : 'Solo Google'}
                    </option>
                    <option value="both" disabled={viewMode === 'edit' && !availableAuthMethods.includes('both')}>
                      Ambos (Correo/contraseña + Google)
                    </option>
                  </select>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Google requiere una cuenta vinculada al mismo UID. Ambos permite usar cualquiera de los dos proveedores cuando esté configurado en Firebase.
                  </p>
                </div>

                {viewMode === 'create' && formAuthMethod !== 'google' && (
                  <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200">
                    <label className="block text-xs font-bold text-amber-900 mb-1">
                      Contraseña Temporal Inicial *
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        required
                        minLength={20}
                        value={formPassword}
                        onChange={(e) => setFormPassword(e.target.value)}
                        className="flex-1 px-3 py-1.5 bg-white border border-amber-300 rounded-lg text-sm font-mono text-slate-900"
                      />
                      <button
                        type="button"
                        onClick={() => setFormPassword(generateRandomPassword())}
                        className="px-2.5 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-900 rounded-lg text-xs font-semibold transition cursor-pointer"
                      >
                        Generar
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCopyPassword(formPassword)}
                        className="px-2.5 py-1.5 bg-amber-800 hover:bg-amber-700 text-white rounded-lg text-xs font-semibold inline-flex items-center gap-1 transition cursor-pointer"
                      >
                        {copiedPass ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedPass ? 'Copiada' : 'Copiar'}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Rol Oficial (6 Roles) *
                  </label>
                  <select
                    value={formRole}
                    onChange={(e) => setFormRole(e.target.value as OfficialRole)}
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:border-indigo-500"
                  >
                    {OFFICIAL_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Estado de la Cuenta
                  </label>
                  <div className="flex items-center gap-3 pt-1.5">
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formActive}
                        onChange={(e) => setFormActive(e.target.checked)}
                        className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4"
                      />
                      <span>Usuario Activo (autorizado para iniciar sesión)</span>
                    </label>
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600">
                <span className="font-bold text-slate-800">{formRole}:</span>{' '}
                {ROLE_DESCRIPTIONS[formRole]}
              </div>

              <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 text-white text-xs font-semibold inline-flex items-center gap-2 shadow-sm transition cursor-pointer"
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Guardando...</span>
                    </>
                  ) : (
                    <span>
                      {viewMode === 'create' ? 'Crear Usuario Autorizado' : 'Guardar Cambios'}
                    </span>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
