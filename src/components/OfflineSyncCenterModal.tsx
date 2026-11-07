import React, { useState } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  X,
  UploadCloud
} from 'lucide-react';
import {
  type ConnectionIndicatorState,
  type PendingSyncOperation,
  type SyncConflictRecord,
  type ManualSyncSummary,
  getOrCreateDeviceId,
  canUserAuthorizePercentageCorrection,
  partitionQueueByUserIdentity,
  countUniquePendingSyncOperations,
  APP_BUILD_VERSION
} from '../firebase/offlineSyncEngine';

interface OfflineSyncBarProps {
  connectionIndicatorState: ConnectionIndicatorState;
  isNetworkOnline: boolean;
  activePendingCount: number;
  unresolvedConflictCount: number;
  pendingOperations?: PendingSyncOperation[];
  syncConflicts?: SyncConflictRecord[];
  lastSyncedAt?: string | null;
  isManualSyncing: boolean;
  onTriggerManualSync: () => Promise<ManualSyncSummary>;
  onOpenSyncModal: () => void;
}

export const OfflineSyncStatusBar: React.FC<OfflineSyncBarProps> = ({
  connectionIndicatorState,
  isNetworkOnline,
  activePendingCount,
  unresolvedConflictCount,
  pendingOperations,
  syncConflicts,
  isManualSyncing,
  onTriggerManualSync,
  onOpenSyncModal
}) => {
  // Contabilizar operaciones reales pendientes deduplicadas por operationId desde la cola persistente
  const computedPendingCount =
    pendingOperations !== undefined
      ? countUniquePendingSyncOperations(pendingOperations, syncConflicts || [])
      : activePendingCount;

  const getIndicatorConfig = () => {
    if (!isNetworkOnline || connectionIndicatorState === 'offline') {
      return {
        label: 'Sin conexión',
        badgeClass: 'bg-amber-400/95 text-slate-950 border-amber-300',
        dotClass: 'bg-slate-950'
      };
    }
    if (connectionIndicatorState === 'syncing' || isManualSyncing) {
      return {
        label: 'Sincronizando',
        badgeClass: 'bg-sky-500/90 text-white border-sky-300',
        dotClass: 'bg-white'
      };
    }
    if (unresolvedConflictCount > 0) {
      return {
        label: 'Conflicto',
        badgeClass: 'bg-rose-600 text-white border-rose-400',
        dotClass: 'bg-white'
      };
    }
    if (connectionIndicatorState === 'error') {
      return {
        label: 'Error',
        badgeClass: 'bg-rose-600 text-white border-rose-400',
        dotClass: 'bg-white'
      };
    }
    if (computedPendingCount > 0 || connectionIndicatorState === 'pending') {
      return {
        label: 'Pendientes',
        badgeClass: 'bg-amber-400/95 text-slate-950 border-amber-300',
        dotClass: 'bg-slate-950'
      };
    }
    return {
      label: 'Conectado',
      badgeClass: 'bg-emerald-900/70 text-emerald-100 border-emerald-600/50',
      dotClass: 'bg-emerald-400'
    };
  };

  const cfg = getIndicatorConfig();

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {/* Único indicador discreto de conectividad (abre el Centro de Sincronización para ver detalles) */}
      <button
        type="button"
        onClick={onOpenSyncModal}
        data-testid="connection-status-indicator"
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition cursor-pointer whitespace-nowrap shrink-0 ${cfg.badgeClass}`}
        title="Abrir Centro de Sincronización"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dotClass}`} />
        <span>{cfg.label}</span>
      </button>

      {/* Botón SINCRONIZAR DATOS con contador de operaciones pendientes [N] a la derecha */}
      <button
        type="button"
        disabled={isManualSyncing}
        onClick={async () => {
          await onTriggerManualSync();
          onOpenSyncModal();
        }}
        data-testid="btn-sincronizar-datos"
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-tight transition border cursor-pointer whitespace-nowrap shrink-0 ${
          computedPendingCount > 0 || unresolvedConflictCount > 0
            ? 'bg-amber-400 hover:bg-amber-300 text-slate-950 border-amber-300 shadow-xs'
            : 'bg-white hover:bg-emerald-50 text-[#0f6b38] border-white/90 shadow-xs'
        } disabled:opacity-60`}
        title="Sincronizar operaciones pendientes con Firestore"
      >
        <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isManualSyncing ? 'animate-spin' : ''}`} />
        <span>SINCRONIZAR DATOS</span>
        {computedPendingCount > 0 && (
          <span
            data-testid="sync-pending-counter"
            className="font-mono font-extrabold text-[11px] tabular-nums"
          >
            [{computedPendingCount}]
          </span>
        )}
      </button>
    </div>
  );
};

interface OfflineSyncCenterModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectionIndicatorState: ConnectionIndicatorState;
  isNetworkOnline: boolean;
  pendingOperations: PendingSyncOperation[];
  syncConflicts: SyncConflictRecord[];
  lastSyncSummary: ManualSyncSummary | null;
  isManualSyncing: boolean;
  userRole?: string;
  activeUserId?: string;
  onTriggerManualSync: () => Promise<ManualSyncSummary>;
  onResolveConflict: (params: {
    conflictId: string;
    resolutionType: 'keep_remote' | 'apply_local' | 'custom_value';
    customValue?: number;
    resolutionNote: string;
  }) => Promise<void>;
}

const STATUS_LABELS: Record<
  PendingSyncOperation['status'],
  { text: string; badge: string }
> = {
  saved_locally: {
    text: 'Guardado localmente',
    badge: 'bg-slate-100 text-slate-800 border-slate-300'
  },
  pending_sync: {
    text: 'Pendiente de sincronización',
    badge: 'bg-amber-100 text-amber-900 border-amber-300'
  },
  syncing: {
    text: 'Sincronizando información',
    badge: 'bg-sky-100 text-sky-900 border-sky-300'
  },
  synced: {
    text: 'Sincronizado correctamente',
    badge: 'bg-emerald-100 text-[#0f6b38] border-emerald-300'
  },
  sync_error: {
    text: 'Error de sincronización',
    badge: 'bg-rose-100 text-rose-800 border-rose-300'
  },
  conflict: {
    text: 'En conflicto multiusuario',
    badge: 'bg-rose-100 text-rose-900 border-rose-400'
  }
};

export const OfflineSyncCenterModal: React.FC<OfflineSyncCenterModalProps> = ({
  isOpen,
  onClose,
  isNetworkOnline,
  pendingOperations,
  syncConflicts,
  lastSyncSummary,
  isManualSyncing,
  userRole,
  activeUserId,
  onTriggerManualSync,
  onResolveConflict
}) => {
  const [customValuesMap, setCustomValuesMap] = useState<Record<string, string>>({});
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  if (!isOpen) return null;

  const canResolveConflicts = canUserAuthorizePercentageCorrection(userRole);
  const unresolvedConflicts = syncConflicts.filter((c) => !c.resolved);
  const resolvedConflicts = syncConflicts.filter((c) => c.resolved);
  const deviceId = getOrCreateDeviceId();
  const { ownPendingOps, foreignPendingOps, foreignAuthors } =
    partitionQueueByUserIdentity(pendingOperations, activeUserId);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl p-6 w-full max-w-3xl border border-slate-200 shadow-2xl my-8 space-y-4">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-black text-slate-900">
                Centro de Sincronización Offline y Control Multiusuario
              </h3>
              <span className="px-2 py-0.5 rounded bg-emerald-50 text-[#0f6b38] border border-emerald-200 font-mono text-[10px] font-bold">
                Versión {APP_BUILD_VERSION}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Dispositivo: <strong className="font-mono">{deviceId}</strong> • Los datos
              registrados sin internet se conservan en cola persistente e idempotente.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Estado actual de conexión y botón de ejecución inmediata */}
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  isNetworkOnline ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
                }`}
              />
              <span className="font-extrabold text-slate-900 text-sm">
                {isNetworkOnline
                  ? 'Conectado a internet (Firestore en línea)'
                  : 'Sin conexión a internet (Almacenamiento local seguro activo)'}
              </span>
            </div>
            <p className="text-slate-600">
              Operaciones propias pendientes:{' '}
              <strong className="font-mono text-slate-900">
                {ownPendingOps.length}
              </strong>{' '}
              {foreignPendingOps.length > 0 && (
                <>
                  • Protegidas de otro usuario:{' '}
                  <strong className="font-mono text-amber-800">
                    {foreignPendingOps.length}
                  </strong>{' '}
                </>
              )}
              • Conflictos multiusuario por revisar:{' '}
              <strong className="font-mono text-rose-700">
                {unresolvedConflicts.length}
              </strong>
            </p>
          </div>

          <button
            type="button"
            disabled={isManualSyncing}
            onClick={() => onTriggerManualSync()}
            className="px-4 py-2.5 rounded-xl bg-[#0f6b38] hover:bg-[#0a4e28] disabled:opacity-50 text-white text-xs font-black flex items-center justify-center gap-2 shadow-sm shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${isManualSyncing ? 'animate-spin' : ''}`} />
            <span>
              {isManualSyncing ? 'SINCRONIZANDO...' : 'EJECUTAR SINCRONIZAR DATOS'}
            </span>
          </button>
        </div>

        {/* C-4: Alerta de Protección de Identidad en Dispositivos Compartidos */}
        {foreignPendingOps.length > 0 && (
          <div className="p-3.5 rounded-xl border-2 border-amber-300 bg-amber-50 text-xs text-amber-950 space-y-1">
            <div className="flex items-center gap-1.5 font-extrabold">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              <span>
                Dispositivo Compartido: {foreignPendingOps.length} operación(es) pendiente(s) de otro usuario ({foreignAuthors.join(', ')})
              </span>
            </div>
            <p className="text-[11px] text-amber-900">
              Para preservar íntegramente la autoría original (<code className="font-mono">userId</code>) y cumplir las reglas de seguridad de Firestore, la sincronización automática de estas operaciones está bloqueada bajo la sesión actual y permanecerán resguardadas en este dispositivo hasta que su autor original vuelva a iniciar sesión.
            </p>
          </div>
        )}

        {/* Resumen del último resultado de sincronización */}
        {lastSyncSummary && (
          <div
            className={`p-3.5 rounded-xl border text-xs space-y-1 ${
              lastSyncSummary.conflictCount > 0 || lastSyncSummary.errorCount > 0
                ? 'bg-amber-50 border-amber-300 text-amber-950'
                : 'bg-emerald-50 border-emerald-200 text-emerald-950'
            }`}
          >
            <div className="flex items-center justify-between font-bold">
              <span className="flex items-center gap-1.5">
                {lastSyncSummary.conflictCount > 0 || lastSyncSummary.errorCount > 0 ? (
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-[#0f6b38]" />
                )}
                <span>Resultado de Sincronización ({lastSyncSummary.executedAt})</span>
              </span>
              <span className="font-mono text-[11px]">
                Sincronizadas: {lastSyncSummary.syncedCount} | Conflictos:{' '}
                {lastSyncSummary.conflictCount} | Pendientes:{' '}
                {lastSyncSummary.remainingPendingCount}
              </span>
            </div>
            <p className="font-medium">{lastSyncSummary.message}</p>
          </div>
        )}

        {/* Conflictos multiusuario pendientes de resolución */}
        {unresolvedConflicts.length > 0 && (
          <div className="space-y-2.5">
            <h4 className="text-xs font-black uppercase tracking-wider text-rose-700 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" />
              <span>
                Conflictos Multiusuario Detectados ({unresolvedConflicts.length})
              </span>
            </h4>
            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
              {unresolvedConflicts.map((conf) => {
                const isSectorActivityConflict = conf.collectionName === 'sectors';
                return (
                  <div
                    key={conf.id}
                    className="p-3.5 rounded-xl border-2 border-rose-200 bg-rose-50/60 space-y-2.5 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="px-2 py-0.5 rounded bg-rose-600 text-white font-mono font-bold text-[10px]">
                          {conf.activityCode}
                        </span>
                        <span className="ml-2 font-extrabold text-slate-900">
                          {conf.activityName || 'Actividad en conflicto'} (
                          {conf.galponCode || conf.galponId})
                        </span>
                      </div>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-300">
                        {isSectorActivityConflict
                          ? 'Conflicto de Edición de Actividad'
                          : STATUS_LABELS.conflict.text}
                      </span>
                    </div>

                    <p className="text-slate-700 font-medium">{conf.reason}</p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div className="p-2 rounded-lg bg-white border border-slate-200">
                        <span className="text-[10px] uppercase font-bold text-slate-400 block">
                          {isSectorActivityConflict
                            ? 'Versión en Servidor (Conservada):'
                            : 'Registro en Servidor (Conservado):'}
                        </span>
                        <span className="font-mono font-black text-sm text-[#0f6b38]">
                          {isSectorActivityConflict
                            ? `Meta: ${conf.remoteValue} ${conf.remotePayload?.unit || ''}`
                            : `${conf.remoteValue}${conf.progressMode === 'percentage' ? '%' : ''}`}
                        </span>
                        {isSectorActivityConflict && conf.remotePayload && (
                          <span className="block text-[11px] text-slate-600">
                            {conf.remotePayload.name} • {conf.remotePayload.startDate} →{' '}
                            {conf.remotePayload.dueDate}
                          </span>
                        )}
                        <span className="block text-[11px] text-slate-600">
                          Usuario: <strong>{conf.remoteUser}</strong>
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-white border border-amber-200">
                        <span className="text-[10px] uppercase font-bold text-amber-700 block">
                          {isSectorActivityConflict
                            ? 'Edición Concurrente en este Dispositivo:'
                            : 'Registro Offline en este Dispositivo:'}
                        </span>
                        <span className="font-mono font-black text-sm text-amber-800">
                          {isSectorActivityConflict
                            ? `Meta: ${conf.localValue} ${conf.localPayload?.unit || ''}`
                            : `${conf.localValue}${conf.progressMode === 'percentage' ? '%' : ''}`}
                        </span>
                        {isSectorActivityConflict && conf.localPayload && (
                          <span className="block text-[11px] text-slate-600">
                            {conf.localPayload.name} • {conf.localPayload.startDate} →{' '}
                            {conf.localPayload.dueDate}
                          </span>
                        )}
                        <span className="block text-[11px] text-slate-600">
                          Usuario: <strong>{conf.localUser}</strong>
                        </span>
                      </div>
                    </div>

                    {canResolveConflicts ? (
                      <div className="pt-2 border-t border-rose-200 space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            type="text"
                            placeholder="Motivo de resolución (se guardará en Historial de Movimientos)..."
                            value={notesMap[conf.id] || ''}
                            onChange={(e) =>
                              setNotesMap({ ...notesMap, [conf.id]: e.target.value })
                            }
                            className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs"
                          />
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              min={0}
                              max={isSectorActivityConflict ? undefined : 100}
                              step="any"
                              placeholder="Valor conciliado (opcional)"
                              value={customValuesMap[conf.id] || ''}
                              onChange={(e) =>
                                setCustomValuesMap({
                                  ...customValuesMap,
                                  [conf.id]: e.target.value
                                })
                              }
                              className="w-40 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white font-mono text-xs"
                            />
                            {customValuesMap[conf.id] && (
                              <button
                                type="button"
                                disabled={resolvingId === conf.id}
                                onClick={async () => {
                                  setResolvingId(conf.id);
                                  await onResolveConflict({
                                    conflictId: conf.id,
                                    resolutionType: 'custom_value',
                                    customValue: Number(customValuesMap[conf.id]),
                                    resolutionNote:
                                      notesMap[conf.id] ||
                                      'Conciliación manual por jefatura/supervisión'
                                  });
                                  setResolvingId(null);
                                }}
                                className="px-2.5 py-1.5 rounded-lg bg-slate-900 text-white font-bold text-[11px]"
                              >
                                Aplicar Conciliado
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={resolvingId === conf.id}
                            onClick={async () => {
                              setResolvingId(conf.id);
                              await onResolveConflict({
                                conflictId: conf.id,
                                resolutionType: 'keep_remote',
                                resolutionNote:
                                  notesMap[conf.id] ||
                                  `Se conserva la versión en servidor (${conf.remoteValue})`
                              });
                              setResolvingId(null);
                            }}
                            className="px-3 py-1.5 rounded-lg bg-[#0f6b38] hover:bg-[#0a4e28] text-white font-bold text-[11px]"
                          >
                            {isSectorActivityConflict
                              ? `Conservar Versión en Servidor (${conf.remoteValue})`
                              : `Conservar Avance en Servidor (${conf.remoteValue}${conf.progressMode === 'percentage' ? '%' : ''})`}
                          </button>
                          <button
                            type="button"
                            disabled={resolvingId === conf.id}
                            onClick={async () => {
                              setResolvingId(conf.id);
                              await onResolveConflict({
                                conflictId: conf.id,
                                resolutionType: 'apply_local',
                                resolutionNote:
                                  notesMap[conf.id] ||
                                  `Corrección autorizada aplicando edición local (${conf.localValue})`
                              });
                              setResolvingId(null);
                            }}
                            className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-[11px]"
                          >
                            {isSectorActivityConflict
                              ? `Autorizar Edición Local (${conf.localValue})`
                              : `Autorizar Registro Offline (${conf.localValue}${conf.progressMode === 'percentage' ? '%' : ''})`}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-[11px] text-rose-800 font-bold">
                        Un Supervisor, Jefe de proyecto o Administrador debe autorizar la
                        resolución de este conflicto.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Cola de operaciones locales pendientes */}
        <div className="space-y-2">
          <h4 className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <UploadCloud className="w-4 h-4 text-[#0f6b38]" />
            <span>
              Cola Local de Operaciones Offline ({pendingOperations.length})
            </span>
          </h4>

          {pendingOperations.length === 0 ? (
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 text-center text-xs text-slate-500">
              No hay operaciones pendientes en la cola local. Todos los cambios han sido
              sincronizados con Firestore.
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-200 text-xs">
              {pendingOperations.map((op) => {
                const st = STATUS_LABELS[op.status] || STATUS_LABELS.pending_sync;
                const isForeignOp =
                  Boolean(activeUserId) &&
                  Boolean(op.userId) &&
                  op.userId !== 'local_user' &&
                  op.userId !== activeUserId;
                return (
                  <div
                    key={op.operationId}
                    className={`p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                      isForeignOp ? 'bg-amber-50/60' : 'bg-white'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-[11px] text-slate-700">
                          [{op.collectionName.toUpperCase()}]
                        </span>
                        <span className="font-bold text-slate-900">
                          Doc: {op.activityCode || op.documentId}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${st.badge}`}
                        >
                          {st.text}
                        </span>
                        {isForeignOp && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-200 text-amber-950 border border-amber-400">
                            Protegida (Otro usuario en este dispositivo)
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Autor original: <strong>{op.userDisplayName}</strong> (
                        <span className="font-mono">{op.userId}</span>) • Creado:{' '}
                        {new Date(op.createdAt).toLocaleString('es-PE')} • OpID:{' '}
                        <span className="font-mono">{op.operationId}</span>
                      </p>
                      {op.errorMessage && (
                        <p className="text-[11px] text-rose-600 font-semibold mt-0.5">
                          Detalle: {op.errorMessage}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-[11px] font-mono text-slate-500 shrink-0">
                      <Clock className="w-3.5 h-3.5" />
                      <span>Reintentos: {op.retryCount || 0}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {resolvedConflicts.length > 0 && (
          <div className="pt-2 border-t border-slate-200">
            <span className="text-[11px] font-bold text-slate-500">
              Conflictos históricos resueltos y auditados en esta sesión:{' '}
              {resolvedConflicts.length}
            </span>
          </div>
        )}

        <div className="pt-2 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold"
          >
            Cerrar Panel
          </button>
        </div>
      </div>
    </div>
  );
};
