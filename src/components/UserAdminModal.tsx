import React, { useState, useEffect, useMemo } from 'react';
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
  Mail,
  Edit3,
  Copy,
  Check,
  RefreshCw,
  Building2,
  Layers,
  CreditCard,
  FolderKanban,
  Table2
} from 'lucide-react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase/config';
import {
  OFFICIAL_ROLES,
  adminListUsers,
  adminCreateUser,
  adminUpdateUser,
  adminGenerateTempPassword,
  adminSendPasswordReset,
  type OfficialRole,
  type AuthMethod,
  type UserProfile
} from '../firebase/authService';
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

interface SectorOption {
  id: string;
  name: string;
  sheds: { id: string; name: string; projectCode?: string }[];
}

const ROLE_DESCRIPTIONS: Record<OfficialRole, string> = {
  'Administrador':
    'Acceso total al sistema, gestión de usuarios, roles, catálogo maestro, sectores, galpones, materiales, personal y auditoría.',
  'Jefe de proyecto':
    'Supervisión integral de proyecto, edición de cronograma, sectores, catálogo, avances, asistencia, informes y materiales.',
  'Supervisor':
    'Gestión operativa de campo en sectores y galpones asignados: registro y edición de avances diarios, actividades, personal y asistencia.',
  'Auxiliar':
    'Apoyo operativo en campo: registro de avances diarios y control de asistencia en los sectores/galpones asignados.',
  'Almacén':
    'Control especializado de inventario de materiales: ingresos, salidas, stock mínimo, kardex y alertas por galpón.',
  'Solo lectura':
    'Consulta y exportación de dashboards, cronogramas, avances e informes sin permisos de creación, edición ni eliminación.'
};

const AUTH_METHOD_LABELS: Record<AuthMethod, string> = {
  password: 'Correo y contraseña',
  google: 'Google (Pre-autorizado)',
  both: 'Ambos (Contraseña + Google)'
};

function generateRandomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `Calera#${suffix}9`;
}

export const UserAdminModal: React.FC<UserAdminModalProps> = ({
  currentUserProfile,
  onClose
}) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  // Vistas del modal: lista, crear, editar, matriz de permisos
  const [viewMode, setViewMode] = useState<'list' | 'create' | 'edit' | 'matrix'>('list');
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [matrixSelectedRole, setMatrixSelectedRole] = useState<OfficialRole>('Administrador');

  // Formulario de Usuario (Crear / Editar)
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formDni, setFormDni] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formAuthMethod, setFormAuthMethod] = useState<AuthMethod>('password');
  const [formPassword, setFormPassword] = useState(generateRandomPassword());
  const [formRole, setFormRole] = useState<OfficialRole>('Supervisor');
  const [formActive, setFormActive] = useState(true);
  const [formAssignedProject, setFormAssignedProject] = useState('TODOS');
  const [formSectorIds, setFormSectorIds] = useState<string[]>([]);
  const [formGalponIds, setFormGalponIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [copiedPass, setCopiedPass] = useState(false);

  // Modal de Contraseña Temporal Generada
  const [generatedTempCreds, setGeneratedTempCreds] = useState<{
    displayName: string;
    email: string;
    tempPassword: string;
  } | null>(null);

  // Sectores y Galpones disponibles (desde Firestore o respaldo local)
  const [availableSectors, setAvailableSectors] = useState<SectorOption[]>([]);

  useEffect(() => {
    const loadSectors = async () => {
      try {
        const snap = await getDocs(collection(db, 'sectors'));
        if (!snap.empty) {
          const parsed: SectorOption[] = [];
          snap.forEach((docSnap) => {
            const s = docSnap.data() as any;
            const rawGalpones = Array.isArray(s.galpones)
              ? s.galpones
              : Array.isArray(s.sheds)
              ? s.sheds
              : [];
            parsed.push({
              id: String(s.id || docSnap.id),
              name: String(s.name || s.code || s.id),
              sheds: rawGalpones.map((g: any) => ({
                id: String(g.id),
                name: String(g.name || g.code || `Galpón ${g.id}`),
                projectCode: g.projectCode || s.code ? String(g.projectCode || s.code) : undefined
              }))
            });
          });
          setAvailableSectors(parsed);
          return;
        }
      } catch {
        // Fallback a localStorage si aún no hay documentos en /sectors
      }

      try {
        const raw =
          localStorage.getItem('calera_sectors_clean') ||
          localStorage.getItem('agro_sectors_v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            setAvailableSectors(
              parsed.map((s: any) => {
                const rawGalpones = Array.isArray(s.galpones)
                  ? s.galpones
                  : Array.isArray(s.sheds)
                  ? s.sheds
                  : [];
                return {
                  id: String(s.id),
                  name: String(s.name || s.code || s.id),
                  sheds: rawGalpones.map((g: any) => ({
                    id: String(g.id),
                    name: String(g.name || g.code || `Galpón ${g.id}`),
                    projectCode: g.projectCode || s.code ? String(g.projectCode || s.code) : undefined
                  }))
                };
              })
            );
          }
        }
      } catch {
        setAvailableSectors([]);
      }
    };

    loadSectors();
  }, []);

  const availableProjects = useMemo(() => {
    const codes = new Set<string>();
    availableSectors.forEach((s) => {
      s.sheds.forEach((g) => {
        if (g.projectCode && g.projectCode.trim()) {
          codes.add(g.projectCode.trim());
        }
      });
    });
    return Array.from(codes);
  }, [availableSectors]);

  const fetchUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await adminListUsers();
      setUsers(list);
    } catch (err: any) {
      setError(err?.message || 'Error al cargar la lista de usuarios.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

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
    setFormAssignedProject('TODOS');
    setFormSectorIds([]);
    setFormGalponIds([]);
    setViewMode('create');
  };

  const openEditForm = (u: UserProfile) => {
    setError(null);
    setSuccessBanner(null);
    setEditingUser(u);
    setFormDisplayName(u.displayName);
    setFormDni(u.dni || '');
    setFormEmail(u.email);
    setFormAuthMethod(u.authMethod || 'password');
    setFormRole(u.role);
    setFormActive(u.active);
    setFormAssignedProject(u.assignedProject || 'TODOS');
    setFormSectorIds(u.assignedSectorIds || []);
    setFormGalponIds(u.assignedGalponIds || []);
    setViewMode('edit');
  };

  const toggleSector = (sectorId: string) => {
    setFormSectorIds((prev) =>
      prev.includes(sectorId) ? prev.filter((id) => id !== sectorId) : [...prev, sectorId]
    );
  };

  const toggleGalpon = (galponId: string) => {
    setFormGalponIds((prev) =>
      prev.includes(galponId) ? prev.filter((id) => id !== galponId) : [...prev, galponId]
    );
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
        assignedProject: formRole === 'Administrador' ? 'TODOS' : formAssignedProject,
        assignedSectorIds: formRole === 'Administrador' ? [] : formSectorIds,
        assignedGalponIds: formRole === 'Administrador' ? [] : formGalponIds
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

    try {
      const { user: updated, authEmailSyncNote } = await adminUpdateUser(editingUser.uid, {
        displayName: formDisplayName.trim(),
        dni: formDni.trim(),
        email: formEmail.trim().toLowerCase(),
        authMethod: formAuthMethod,
        role: formRole,
        active: formActive,
        assignedProject: formRole === 'Administrador' ? 'TODOS' : formAssignedProject,
        assignedSectorIds: formRole === 'Administrador' ? [] : formSectorIds,
        assignedGalponIds: formRole === 'Administrador' ? [] : formGalponIds
      });

      setUsers((prev) => prev.map((u) => (u.uid === updated.uid ? updated : u)));
      const emailMsg =
        editingUser.email !== updated.email
          ? ` Correo actualizado a ${updated.email} (${authEmailSyncNote || 'UID preservado'}).`
          : '';
      setSuccessBanner(
        `Perfil de ${updated.displayName} actualizado correctamente (UID: ${updated.uid}).${emailMsg}`
      );
      setEditingUser(null);
      setViewMode('list');
    } catch (err: any) {
      setError(err?.message || 'Error al actualizar el usuario.');
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
      const { user: updated } = await adminUpdateUser(u.uid, { active: !u.active });
      setUsers((prev) => prev.map((item) => (item.uid === updated.uid ? updated : item)));
      setSuccessBanner(
        `Usuario ${updated.displayName} ${updated.active ? 'activado' : 'desactivado'} inmediatamente.`
      );
    } catch (err: any) {
      setError(err?.message || 'Error al cambiar el estado del usuario.');
    }
  };

  const handleGenerateTempPassword = async (u: UserProfile) => {
    setError(null);
    setSuccessBanner(null);
    try {
      const result = await adminGenerateTempPassword(u.uid);
      if (result.mode === 'direct_update' && result.tempPassword) {
        setGeneratedTempCreds({
          displayName: u.displayName,
          email: u.email,
          tempPassword: result.tempPassword
        });
        setSuccessBanner(
          `Contraseña temporal generada y asignada para ${u.displayName}. Cópiela y entréguela al usuario.`
        );
      } else {
        setSuccessBanner(result.message);
      }
    } catch (err: any) {
      setError(err?.message || 'Error al generar contraseña temporal.');
    }
  };

  const handleSendResetEmail = async (u: UserProfile) => {
    setError(null);
    setSuccessBanner(null);
    try {
      const msg = await adminSendPasswordReset(u.uid);
      setSuccessBanner(msg);
    } catch (err: any) {
      setError(err?.message || 'Error al enviar correo de restablecimiento.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
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
          </div>
        )}

        {successBanner && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-2.5 text-xs text-emerald-800">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>{successBanner}</span>
          </div>
        )}

        {/* Recuadro de Contraseña Temporal Generada */}
        {generatedTempCreds && (
          <div className="mx-6 mt-4 p-4 rounded-xl bg-indigo-50 border border-indigo-200 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div>
              <div className="font-bold text-indigo-950">
                Contraseña temporal asignada para {generatedTempCreds.displayName} ({generatedTempCreds.email})
              </div>
              <div className="text-indigo-700 mt-0.5">
                Por seguridad Zero Trust, esta clave no se almacena en Firestore. Cópiela ahora:
              </div>
            </div>
            <div className="flex items-center gap-2">
              <code className="px-3 py-1.5 rounded-lg bg-white border border-indigo-300 font-mono text-sm font-bold text-indigo-900">
                {generatedTempCreds.tempPassword}
              </code>
              <button
                type="button"
                onClick={() => handleCopyPassword(generatedTempCreds.tempPassword)}
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
                      <th className="py-3 px-4 font-semibold">Alcance Asignado</th>
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
                        <td className="py-3 px-4 text-slate-600">
                          {u.role === 'Administrador' ? (
                            <span className="text-emerald-700 font-semibold">
                              Global (Todos los proyectos, sectores y galpones)
                            </span>
                          ) : (
                            <div className="space-y-0.5">
                              <div className="font-medium text-slate-800">
                                Proyecto: {u.assignedProject || 'TODOS'}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {u.assignedSectorIds?.length || 0} sector(es) •{' '}
                                {u.assignedGalponIds?.length || 0} galpón(es)
                              </div>
                            </div>
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
                            {u.authMethod !== 'google' && (
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
                            <button
                              type="button"
                              onClick={() => handleSendResetEmail(u)}
                              className="px-2.5 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 font-medium inline-flex items-center gap-1 transition cursor-pointer"
                              title="Enviar correo de restablecimiento de contraseña"
                            >
                              <Mail className="w-3.5 h-3.5" />
                              <span>Reset Email</span>
                            </button>
                            {u.uid !== currentUserProfile.uid && (
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
                    onChange={(e) => setFormAuthMethod(e.target.value as AuthMethod)}
                    className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="password">Correo y contraseña</option>
                    <option value="google">Solo Google (Pre-autorizar cuenta Google)</option>
                    <option value="both">Ambos (Correo/contraseña + Google)</option>
                  </select>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Si selecciona Google o Ambos, el trabajador podrá ingresar con el botón "Continuar con Google" usando este correo.
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
                        minLength={6}
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
                    Proyecto Asignado
                  </label>
                  <div className="relative">
                    <FolderKanban className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      disabled={formRole === 'Administrador'}
                      value={formRole === 'Administrador' ? 'TODOS' : formAssignedProject}
                      onChange={(e) => setFormAssignedProject(e.target.value)}
                      placeholder="TODOS o código de proyecto"
                      list="project-codes-list"
                      className="w-full pl-9 pr-3.5 py-2 border border-slate-300 rounded-xl text-sm disabled:bg-slate-100 focus:outline-none focus:border-indigo-500"
                    />
                    <datalist id="project-codes-list">
                      <option value="TODOS" />
                      {availableProjects.map((code) => (
                        <option key={code} value={code} />
                      ))}
                    </datalist>
                  </div>
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

              {/* Asignación de Sectores y Galpones */}
              {formRole !== 'Administrador' && (
                <div className="space-y-4 pt-2 border-t border-slate-200">
                  <div>
                    <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-1">
                      <Layers className="w-4 h-4 text-indigo-600" />
                      <span>Alcance Operativo: Sectores y Galpones Asignados</span>
                    </h4>
                    <p className="text-[11px] text-slate-500 mb-3">
                      Seleccione los sectores y galpones a los que este usuario tendrá acceso. Si no selecciona ninguno y el proyecto es "TODOS", el usuario tendrá visibilidad general según su rol.
                    </p>

                    {availableSectors.length === 0 ? (
                      <div className="text-xs text-slate-400 italic">
                        No hay sectores configurados actualmente.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {availableSectors.map((sector) => {
                          const sectorSelected = formSectorIds.includes(sector.id);
                          return (
                            <div
                              key={sector.id}
                              className={`p-3 rounded-xl border transition ${
                                sectorSelected
                                  ? 'bg-indigo-50/50 border-indigo-300'
                                  : 'bg-slate-50 border-slate-200'
                              }`}
                            >
                              <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={sectorSelected}
                                  onChange={() => toggleSector(sector.id)}
                                  className="rounded border-slate-300 text-indigo-600 w-4 h-4"
                                />
                                <span>{sector.name}</span>
                              </label>

                              {sector.sheds.length > 0 && (
                                <div className="mt-2 pl-6 flex flex-wrap gap-1.5">
                                  {sector.sheds.map((g) => {
                                    const galponSelected = formGalponIds.includes(g.id);
                                    return (
                                      <button
                                        key={g.id}
                                        type="button"
                                        onClick={() => toggleGalpon(g.id)}
                                        className={`px-2 py-0.5 rounded text-[11px] font-medium border transition cursor-pointer ${
                                          galponSelected
                                            ? 'bg-indigo-600 text-white border-indigo-600'
                                            : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                                        }`}
                                      >
                                        <Building2 className="w-2.5 h-2.5 inline mr-1" />
                                        {g.name}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

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
