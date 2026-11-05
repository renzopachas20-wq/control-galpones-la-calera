import React from 'react';
import type {
  SistemaLocationFilter,
  SistemaProgressMetric
} from '../dashboardSelectors';

export interface SystemWeightedProgressWidgetProps {
  sistemaProgressMetrics: SistemaProgressMetric[];
  locationFilter: SistemaLocationFilter;
  onChangeLocationFilter: (loc: SistemaLocationFilter) => void;
}

/**
 * Reporte Modular 3: Avance Ponderado por Sistema General (Todos / Interno / Externo).
 * Componente independiente para visualización y filtrado por ubicación.
 */
export const SystemWeightedProgressWidget: React.FC<SystemWeightedProgressWidgetProps> = ({
  sistemaProgressMetrics,
  locationFilter,
  onChangeLocationFilter
}) => {
  return (
    <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-100 gap-2 mb-4">
        <div>
          <h3 className="text-sm sm:text-base font-extrabold text-slate-900">
            Avance Ponderado por Sistema General
          </h3>
          <p className="text-xs text-slate-500">
            Filtra el avance de los sistemas entre actividades Internas y
            Externas del galpón
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {(['Todos', 'Interno', 'Externo'] as const).map((loc) => (
            <button
              key={loc}
              onClick={() => onChangeLocationFilter(loc)}
              className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                locationFilter === loc
                  ? 'bg-[#0f6b38] text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {loc}
            </button>
          ))}
        </div>
      </div>

      {sistemaProgressMetrics.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-4">
          Aún no hay sistemas registrados en este galpón.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sistemaProgressMetrics.map((sis, idx) => (
            <div
              key={idx}
              className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/70"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs font-extrabold text-slate-900 truncate">
                  {sis.sistemaName}
                </span>
                <span className="text-xs font-mono font-black text-[#0f6b38]">
                  {sis.percent}%
                </span>
              </div>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-[#0f6b38] font-bold">
                  {sis.areaName}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-semibold">
                  {sis.locations.join(' / ')}
                </span>
              </div>
              <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden mb-1.5">
                <div
                  className="bg-[#0f6b38] h-full rounded-full"
                  style={{ width: `${sis.percent}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-slate-500">
                <span>
                  Tareas ({locationFilter}): {sis.total}
                </span>
                <span>Listas: {sis.completed}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
