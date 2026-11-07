import React, { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, Info } from 'lucide-react';
import buildMeta from '../generated/versionMetadata.json';
import { getApiUrl } from '../firebase/apiConfig';

export interface AppVersionMetadata {
  version: string;
  commitHash: string;
  buildTimestampIso: string;
  formattedDate: string;
  formattedTime: string;
  timeZone: string;
  environment: 'PRODUCCIÓN' | 'DESARROLLO';
  status: string;
  installStateLabel: 'Actualizado' | 'Verificando...';
  isProduction: boolean;
  bundleVerified: boolean;
}

const STORAGE_KEY = 'calera_verified_version_metadata_v3';

/**
 * Determina de manera determinista el entorno (DESARROLLO vs PRODUCCIÓN) y los metadatos
 * combinando la información generada en compilación con la respuesta verificada de /api/version.
 */
export function resolveVersionMetadata(
  serverPayload?: Partial<AppVersionMetadata> | null,
  currentHostname?: string
): AppVersionMetadata {
  const host = (
    currentHostname ??
    (typeof window !== 'undefined' ? window.location.hostname : 'localhost')
  ).toLowerCase();

  const isDevHost =
    host.includes('ais-dev-') ||
    host === 'localhost' ||
    host === '127.0.0.1';

  const isProdHost =
    host.includes('ais-pre-') ||
    host.includes('ais-mob-') ||
    (!isDevHost && Boolean(serverPayload?.isProduction));

  const environment: 'PRODUCCIÓN' | 'DESARROLLO' = isProdHost ? 'PRODUCCIÓN' : 'DESARROLLO';

  const version = serverPayload?.version || buildMeta.version || '3.0.0';
  const commitHash = serverPayload?.commitHash || buildMeta.commitHash || 'b3ac7e4';
  const buildTimestampIso =
    serverPayload?.buildTimestampIso || buildMeta.buildTimestampIso || new Date().toISOString();
  const formattedDate = serverPayload?.formattedDate || buildMeta.formattedDate || '05/11/2026';
  const formattedTime = serverPayload?.formattedTime || buildMeta.formattedTime || '11:05 p. m.';
  const timeZone = serverPayload?.timeZone || buildMeta.timeZone || 'America/Lima (UTC-5)';
  const bundleVerified =
    serverPayload?.bundleVerified !== undefined
      ? Boolean(serverPayload.bundleVerified)
      : Boolean(buildMeta.bundleCompleted);

  const status = isProdHost
    ? bundleVerified
      ? 'Publicado correctamente.'
      : 'Compilación pendiente de verificación.'
    : 'Publicado en vista previa (Desarrollo).';

  const installStateLabel: 'Actualizado' | 'Verificando...' = bundleVerified
    ? 'Actualizado'
    : 'Verificando...';

  return {
    version,
    commitHash,
    buildTimestampIso,
    formattedDate,
    formattedTime,
    timeZone,
    environment,
    status,
    installStateLabel,
    isProduction: isProdHost,
    bundleVerified
  };
}

export function useAppVersionMetadata() {
  const [meta, setMeta] = useState<AppVersionMetadata>(() => {
    try {
      const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (cached) {
        const parsed = JSON.parse(cached);
        return resolveVersionMetadata(parsed);
      }
    } catch {
      // ignore storage errors in private mode
    }
    return resolveVersionMetadata(null);
  });

  const [checking, setChecking] = useState(false);

  const refreshVersion = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(getApiUrl(`/api/version?t=${Date.now()}`), {
        method: 'GET',
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        const resolved = resolveVersionMetadata(data);
        setMeta(resolved);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
        } catch {
          // ignore storage quota/privacy restrictions
        }
      }
    } catch {
      // Si está offline, conserva la versión verificada en caché local o en el bundle compilado
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refreshVersion();
    const handleOnline = () => refreshVersion();
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [refreshVersion]);

  return { meta, checking, refreshVersion };
}

/**
 * Pie minimalista de la Barra Lateral:
 * Muestra permanentemente únicamente:
 *   Versión 3.0.0
 *   Estado: Actualizado
 * Conserva los metadatos técnicos internamente para consulta bajo demanda mediante el icono de información.
 */
export const SidebarVersionFooter: React.FC<{
  syncStatusLabel?: string;
}> = () => {
  const { meta } = useAppVersionMetadata();
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  return (
    <div
      data-testid="sidebar-version-footer"
      className="px-4 py-3 bg-slate-50 border-t border-slate-200 text-xs select-text"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <div
            data-testid="sidebar-version-number"
            className="font-bold text-slate-800 text-xs tracking-tight"
          >
            Versión {meta.version}
          </div>
          <div
            data-testid="sidebar-version-status"
            className="text-[11px] font-medium text-emerald-700 flex items-center gap-1"
          >
            <CheckCircle2 className="w-3 h-3 text-[#0f6b38] shrink-0" />
            <span>Estado: {meta.installStateLabel}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowDiagnostics((prev) => !prev)}
          data-testid="btn-version-diagnostic-info"
          title="Consultar diagnóstico técnico de versión"
          aria-label="Diagnóstico de versión"
          aria-expanded={showDiagnostics}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition cursor-pointer"
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </div>

      {showDiagnostics && (
        <div
          data-testid="version-diagnostics-popover"
          className="mt-2.5 pt-2 border-t border-slate-200/80 text-[10px] text-slate-500 space-y-1 font-mono"
        >
          <div className="flex justify-between">
            <span>Commit:</span>
            <span className="text-slate-700 font-semibold">{meta.commitHash}</span>
          </div>
          <div className="flex justify-between">
            <span>Compilación:</span>
            <span className="text-slate-700">
              {meta.formattedDate} {meta.formattedTime}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Zona:</span>
            <span className="text-slate-700">{meta.timeZone}</span>
          </div>
          <div className="flex justify-between">
            <span>Entorno:</span>
            <span className="text-slate-700 font-semibold">{meta.environment}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export const CompactVersionBanner: React.FC<{
  onOpenSidebar?: () => void;
  variant?: 'dark' | 'light';
}> = () => {
  return null;
};
