import React, { useEffect, useState } from 'react';
import {
  Users,
  UserPlus,
  Shield,
  CheckCircle2,
  XCircle,
  KeyRound,
  Edit3,
  X,
  RefreshCw,
  Copy,
  Check,
  AlertCircle,
  Clock,
  Building2,
} from 'lucide-react';
import {
  OFFICIAL_ROLES,
  type OfficialRole,
  type UserProfile,
  subscribeToAllUsers,
  adminCreateUserOnServer,
  adminUpdateUserOnServer,
  adminSendPasswordResetOnServer,
} from '../firebase/authService';

interface SectorOption {
  id: string;
  name: string;
  galpones?: Array<{ id: string; code: string; name: string }>;
}

interface UserAdminModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentAdmin: UserProfile;
}

function formatDateTime(iso: string): string {
  if (!iso) return 'Sin registro';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-PE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function generateClientPreviewTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let out = 'Calera2026!';
  const randomValues = new Uint32Array(10);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(randomValues);
    out = Array.from(randomValues)
      .map((v) => chars[v % chars.length])
      .join('');
  }
  return out;
}

export const UserAdminModal: React.FC<UserAdminModalProps> = ({
  isOpen,
  onClose,
  currentAdmin,
}) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');
  const [createdTempPasswordInfo, setCreatedTempPasswordInfo] = useState<{
    email: string;
    password: string;
  } | null>(null);
  const [copiedTemp, setCopiedTemp] = useState<boolean>(false);

  // Sectores y galpones disponibles para asignación
  const [availableSectors, setAvailableSectors] = useState<SectorOption[]>([]);

  // Formulario de creación / edición
  const [formMode, setFormMode] = useState<'list' | 'create' | 'edit'>('list');
  const [editingUid, setEditingUid] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [role, setRole] = useState<OfficialRole>('Auxiliar');
  const [active, setActive] = useState<boolean>(true);
  const [assignedSectorIds, setAssignedSectorIds] = useState<string[]>([]);
  const [assignedGalponIds, setAssignedGalponIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [roleFilter, setRoleFilter] = useState<string>('');

  useEffect(() => {
    if (!isOpen) return;
    setLoadingUsers(true);
    setErrorMsg('');

    try {
      const rawSectors = localStorage.getItem('calera_sectors_v1');
      if (rawSectors) {
        const parsed = JSON.parse(rawSectors);
        if (Array.isArray(parsed)) {
          setAvailableSectors(parsed);
        }
      }
    } catch {
      setAvailableSectors([]);
    }

    const unsub = subscribeToAllUsers(
      (list) => {
        setUsers(list);
        setLoadingUsers(false);
      },
      (err) => {
        setErrorMsg(
          err.message || 'No se pudo cargar el padrón de usuarios desde Cloud Firestore.'
        );
        setLoadingUsers(false);
      }
    );

    return () => unsub();
  }, [isOpen]);

  if (!isOpen) return null;

  const resetForm = () => {
    setEditingUid('');
    setEmail('');
    setDisplayName('');
    setPassword('');
    setRole('Auxiliar');
    setActive(true);
    setAssignedSectorIds([]);
    setAssignedGalponIds([]);
    setErrorMsg('');
  };

  const handleOpenCreate = () => {
    resetForm();
    setSuccessMsg('');
    setCreatedTempPasswordInfo(null);
    setFormMode('create');
  };

  const handleOpenEdit = (u: UserProfile) => {
    setEditingUid(u.uid);
    setEmail(u.email);
    setDisplayName(u.displayName);
    setPassword('');
    setRole(u.role);
    setActive(u.active);
    setAssignedSectorIds(u.assignedSectorIds || []);
    setAssignedGalponIds(u.assignedGalponIds || []);
    setErrorMsg('');
    setSuccessMsg('');
    setCreatedTempPasswordInfo(null);
    setFormMode('edit');
  };

  const toggleSectorAssignment = (sectorId: string) => {
    setAssignedSectorIds((prev) =>
      prev.includes(sectorId) ? prev.filter((id) => id !== sectorId) : [...prev, sectorId]
    );
  };

  const toggleGalponAssignment = (galponId: string) => {
    setAssignedGalponIds((prev) =>
      prev.includes(galponId) ? prev.filter((id) => id !== galponId) : [...prev, galponId]
    );
  };

  const handleGenerateTempPassword = () => {
    setPassword(generateClientPreviewTempPassword());
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');
    setSubmitting(true);

    try {
      const result = await adminCreateUserOnServer({
        email: email.trim().toLowerCase(),
        displayName: displayName.trim(),
        password: password.trim(),
        role,
        active,
        assignedSectorIds,
        assignedGalponIds,
      });

      setCreatedTempPasswordInfo({
        email: result.profile.email,
        password: result.temporaryPassword,
      });
      setSuccessMsg(
        `Usuario "${result.profile.displayName}" (${result.profile.role}) creado correctamente en Firebase Auth y Cloud Firestore.`
      );
      setFormMode('list');
      resetForm();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUid) return;
    setErrorMsg('');
    setSuccessMsg('');
    setSubmitting(true);

    try {
      const updated = await adminUpdateUserOnServer(editingUid, {
        displayName: displayName.trim(),
        role,
        active,
        assignedSectorIds,
        assignedGalponIds,
      });
      setSuccessMsg(
        `Perfil de "${updated.displayName}" actualizado correctamente (${updated.role} — ${
          updated.active ? 'Activo' : 'Inactivo'
        }).`
      );
      setFormMode('list');
      resetForm();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleUserActive = async (target: UserProfile) => {
    if (target.uid === currentAdmin.uid) {
      setErrorMsg('Por seguridad, no puedes desactivar tu propia cuenta de Administrador.');
      return;
    }
    setErrorMsg('');
    setSuccessMsg('');
    setSubmitting(true);
    try {
      const updated = await adminUpdateUserOnServer(target.uid, {
        active: !target.active,
      });
      setSuccessMsg(
        `Cuenta de "${updated.displayName}" ${
          updated.active ? 'activada' : 'desactivada'
        } correctamente.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendResetEmail = async (target: UserProfile) => {
    setErrorMsg('');
    setSuccessMsg('');
    setSubmitting(true);
    try {
      const msg = await adminSendPasswordResetOnServer(target.uid);
      setSuccessMsg(msg);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyTempPassword = () => {
    if (!createdTempPasswordInfo) return;
    navigator.clipboard
      .writeText(createdTempPasswordInfo.password)
      .then(() => {
        setCopiedTemp(true);
        setTimeout(() => setCopiedTemp(false), 2500);
      })
      .catch(() => undefined);
  };

  const filteredUsers = users.filter((u) => {
    const matchesRole = !roleFilter || u.role === roleFilter;
    const q = searchFilter.trim().toLowerCase();
    const matchesSearch =
      !q ||
      u.displayName.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      u.uid.toLowerCase().includes(q);
    return matchesRole && matchesSearch;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-3 sm:p-6 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Encabezado corporativo */}
        <div className="bg-[#0f6b38] text-white px-5 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
              <Users className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold tracking-tight">
                Administración de Usuarios y Roles Oficiales
              </h2>
              <p className="text-xs text-emerald-100">
                Gestión centralizada en Firebase Authentication y Cloud Firestore (Exclusivo Administrador)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition"
            title="Cerrar ventana"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mensajes de estado */}
        <div className="px-5 pt-4 space-y-3 shrink-0">
          {errorMsg && (
            <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm">
              <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div className="flex-1">{errorMsg}</div>
              <button
                type="button"
                onClick={() => setErrorMsg('')}
                className="text-red-500 hover:text-red-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {successMsg && (
            <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="flex-1">{successMsg}</div>
              <button
                type="button"
                onClick={() => setSuccessMsg('')}
                className="text-emerald-600 hover:text-emerald-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {createdTempPasswordInfo && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="font-bold text-amber-900">
                  Credenciales iniciales generadas para {createdTempPasswordInfo.email}
                </p>
                <p className="text-xs text-amber-800 mt-0.5">
                  Comparte esta contraseña temporal de manera segura. Por seguridad, nunca se almacena en Firestore:
                </p>
                <code className="inline-block mt-1.5 px-2.5 py-1 rounded bg-white border border-amber-300 font-mono font-bold text-slate-900">
                  {createdTempPasswordInfo.password}
                </code>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyTempPassword}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-800 text-white text-xs font-semibold hover:bg-amber-900 transition"
                >
                  {copiedTemp ? (
                    <>
                      <Check className="w-4 h-4" /> Copiada
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" /> Copiar contraseña
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setCreatedTempPasswordInfo(null)}
                  className="px-2.5 py-2 rounded-lg border border-amber-300 text-xs font-medium text-amber-900 hover:bg-amber-100"
                >
                  Ocultar
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Contenido principal */}
        <div className="p-5 overflow-y-auto flex-1 space-y-5">
          {formMode === 'list' ? (
            <>
              {/* Barra de herramientas */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                <div className="flex flex-col sm:flex-row gap-2.5 flex-1">
                  <input
                    type="text"
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    placeholder="Buscar por nombre, correo o UID..."
                    className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm flex-1 focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38]"
                  />
                  <select
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                    className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700"
                  >
                    <option value="">Todos los roles (6 oficiales)</option>
                    {OFFICIAL_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={handleOpenCreate}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#0f6b38] hover:bg-[#0b522a] text-white text-sm font-bold shadow-xs transition"
                >
                  <UserPlus className="w-4 h-4" />
                  + Nuevo Usuario
                </button>
              </div>

              {/* Tabla de usuarios */}
              <div className="border border-slate-200 rounded-xl overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700 border-b border-slate-200 text-xs uppercase">
                      <th className="py-3 px-3.5 font-bold">Usuario / Correo</th>
                      <th className="py-3 px-3.5 font-bold">Rol Oficial</th>
                      <th className="py-3 px-3.5 font-bold">Estado</th>
                      <th className="py-3 px-3.5 font-bold">Alcance Asignado</th>
                      <th className="py-3 px-3.5 font-bold">Creación y Último Acceso</th>
                      <th className="py-3 px-3.5 font-bold text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loadingUsers ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-500">
                          Cargando padrón de usuarios desde Cloud Firestore...
                        </td>
                      </tr>
                    ) : filteredUsers.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-500">
                          No se encontraron usuarios registrados con los filtros actuales.
                        </td>
                      </tr>
                    ) : (
                      filteredUsers.map((u) => (
                        <tr key={u.uid} className="hover:bg-slate-50/80 transition">
                          <td className="py-3 px-3.5">
                            <div className="font-bold text-slate-900">{u.displayName}</div>
                            <div className="text-xs text-slate-600">{u.email}</div>
                            <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                              UID: {u.uid}
                            </div>
                          </td>
                          <td className="py-3 px-3.5">
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-emerald-50 text-[#0f6b38] border border-emerald-200">
                              <Shield className="w-3.5 h-3.5" />
                              {u.role}
                            </span>
                          </td>
                          <td className="py-3 px-3.5">
                            {u.active ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-emerald-100 text-emerald-800">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Activo
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold bg-red-100 text-red-800">
                                <XCircle className="w-3.5 h-3.5" />
                                Inactivo
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3.5 text-xs text-slate-600">
                            {u.role === 'Administrador' ? (
                              <span className="font-semibold text-slate-700">
                                Acceso Global (Todos los sectores y galpones)
                              </span>
                            ) : (
                              <div className="space-y-0.5">
                                <div>
                                  <span className="font-semibold">Sectores:</span>{' '}
                                  {u.assignedSectorIds.length > 0
                                    ? u.assignedSectorIds.length
                                    : 'Todos / Sin restricción'}
                                </div>
                                <div>
                                  <span className="font-semibold">Galpones:</span>{' '}
                                  {u.assignedGalponIds.length > 0
                                    ? u.assignedGalponIds.length
                                    : 'Todos / Sin restricción'}
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-3.5 text-xs text-slate-600 space-y-1">
                            <div className="flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span>
                                <strong>Creado:</strong> {formatDateTime(u.createdAt)}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500">
                              Por: {u.createdBy || 'Sistema'}
                            </div>
                            <div className="text-xs text-slate-700">
                              <strong>Último acceso:</strong>{' '}
                              {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Nunca'}
                            </div>
                          </td>
                          <td className="py-3 px-3.5 text-right">
                            <div className="inline-flex items-center justify-end gap-1.5 flex-wrap">
                              <button
                                type="button"
                                onClick={() => handleOpenEdit(u)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold transition"
                                title="Editar datos, rol y asignaciones"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                                Editar
                              </button>
                              <button
                                type="button"
                                disabled={submitting}
                                onClick={() => handleSendResetEmail(u)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 text-xs font-semibold transition"
                                title="Enviar correo de recuperación de contraseña"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                                Clave
                              </button>
                              {u.uid !== currentAdmin.uid && (
                                <button
                                  type="button"
                                  disabled={submitting}
                                  onClick={() => handleToggleUserActive(u)}
                                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                                    u.active
                                      ? 'border border-red-200 bg-red-50 hover:bg-red-100 text-red-700'
                                      : 'border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800'
                                  }`}
                                >
                                  {u.active ? 'Desactivar' : 'Activar'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            /* Formulario de Creación o Edición de Usuario */
            <form
              onSubmit={formMode === 'create' ? handleCreateSubmit : handleEditSubmit}
              className="bg-slate-50 p-5 rounded-xl border border-slate-200 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <h3 className="text-base font-bold text-slate-900">
                  {formMode === 'create'
                    ? 'Registrar Nuevo Usuario en el Sistema'
                    : `Editar Usuario: ${displayName || email}`}
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setFormMode('list');
                    resetForm();
                  }}
                  className="text-xs font-semibold text-slate-600 hover:text-slate-900"
                >
                  ← Volver al listado
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Nombre Completo *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={150}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Ej. Ing. Carlos Mendoza"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white text-sm focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Correo Electrónico *
                  </label>
                  <input
                    type="email"
                    required
                    disabled={formMode === 'edit'}
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="usuario@lacalera.pe"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white disabled:bg-slate-100 text-sm focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Rol Oficial (6 Roles) *
                  </label>
                  <select
                    required
                    disabled={editingUid === currentAdmin.uid}
                    value={role}
                    onChange={(e) => setRole(e.target.value as OfficialRole)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38]"
                  >
                    {OFFICIAL_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 uppercase mb-1">
                    Estado de la Cuenta *
                  </label>
                  <select
                    disabled={editingUid === currentAdmin.uid}
                    value={active ? 'active' : 'inactive'}
                    onChange={(e) => setActive(e.target.value === 'active')}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white text-sm font-semibold text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38]"
                  >
                    <option value="active">Activo (Acceso autorizado)</option>
                    <option value="inactive">Inactivo (Acceso bloqueado)</option>
                  </select>
                </div>
              </div>

              {formMode === 'create' && (
                <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <label className="block text-xs font-bold text-slate-700 uppercase">
                      Contraseña Inicial o Temporal (mínimo 6 caracteres) *
                    </label>
                    <button
                      type="button"
                      onClick={handleGenerateTempPassword}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-[#0f6b38] border border-emerald-200 text-xs font-bold transition"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Generar contraseña temporal segura
                    </button>
                  </div>
                  <input
                    type="text"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Escribe una contraseña o pulsa 'Generar contraseña temporal segura'"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-[#0f6b38]"
                  />
                  <p className="text-[11px] text-slate-500">
                    La contraseña se registra únicamente en Firebase Authentication a través del servidor y nunca se guarda en Cloud Firestore.
                  </p>
                </div>
              )}

              {/* Asignación opcional de Sectores y Galpones */}
              <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-[#0f6b38]" />
                  <h4 className="text-xs font-bold text-slate-700 uppercase">
                    Sectores y Galpones Asignados (Preparado para Matriz de Fase 4.3)
                  </h4>
                </div>
                {availableSectors.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Aún no hay sectores creados en el proyecto. Cuando se creen sectores y galpones, podrás asignarlos aquí.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                    {availableSectors.map((sec) => (
                      <div
                        key={sec.id}
                        className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 space-y-1.5"
                      >
                        <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={assignedSectorIds.includes(sec.id)}
                            onChange={() => toggleSectorAssignment(sec.id)}
                            className="rounded border-slate-300 text-[#0f6b38]"
                          />
                          Sector: {sec.name}
                        </label>
                        {Array.isArray(sec.galpones) && sec.galpones.length > 0 && (
                          <div className="pl-6 flex flex-wrap gap-3">
                            {sec.galpones.map((g) => (
                              <label
                                key={g.id}
                                className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={assignedGalponIds.includes(g.id)}
                                  onChange={() => toggleGalponAssignment(g.id)}
                                  className="rounded border-slate-300 text-[#0f6b38]"
                                />
                                {g.code} - {g.name}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setFormMode('list');
                    resetForm();
                  }}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-sm font-semibold"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2.5 rounded-xl bg-[#0f6b38] hover:bg-[#0b522a] disabled:opacity-60 text-white text-sm font-bold shadow-xs transition"
                >
                  {submitting
                    ? 'Procesando en servidor...'
                    : formMode === 'create'
                    ? 'Crear Usuario'
                    : 'Guardar Cambios'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
