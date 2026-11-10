import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  ALL_CONSTRUCTIVE_AREAS,
  computeScheduleAlerts,
  type EvaluatedActivityItem
} from '../dashboardSelectors';

export interface ScheduleAlertsWidgetProps {
  evaluatedActivities: EvaluatedActivityItem[];
  pendingAreaFilter: string;
  onChangePendingAreaFilter: (area: string) => void;
  canCreateAdvance: boolean;
  onQuickRegisterAdvance: (prefill: {
    areaName: string;
    locationType: string;
    sistemaName: string;
    structureName: string;
    activityId: string;
  }) => void;
}

/**
 * Reporte Modular 4: Alertas de Cronograma y Pendientes por Área.
 * Componente independiente que muestra actividades sin iniciar en fecha o pendientes de completar.
 */
export const ScheduleAlertsWidget: React.FC<ScheduleAlertsWidgetProps> = ({
  evaluatedActivities,
  pendingAreaFilter,
  onChangePendingAreaFilter,
  canCreateAdvance,
  onQuickRegisterAdvance
}) => {
  const pendingActivities = useMemo(
    () => computeScheduleAlerts(evaluatedActivities, pendingAreaFilter),
    [evaluatedActivities, pendingAreaFilter]
  );

  return (
    <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-100 gap-2 mb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-rose-600" />
          <div>
            <h3 className="text-sm font-extrabold text-slate-900">
              Alertas de Cronograma y Pendientes por Área
            </h3>
            <p className="text-xs text-slate-500">
              Actividades cuya fecha de inicio ya llegó y continúan en 0%, o
              pendientes por completar
            </p>
          </div>
        </div>
        <select
          value={pendingAreaFilter}
          onChange={(e) => onChangePendingAreaFilter(e.target.value)}
          className="px-3 py-1.5 rounded-xl border border-slate-300 text-xs font-bold bg-slate-50"
        >
          <option value="Todas">Todas las Áreas</option>
          {ALL_CONSTRUCTIVE_AREAS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {pendingActivities.map((act) => (
          <div
            key={act.id}
            className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs ${
              act.shouldHaveStarted
                ? 'bg-rose-50/70 border-rose-200'
                : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-800 text-[10px]">
                  {act.code}
                </span>
                <span className="font-bold text-slate-900">{act.name}</span>
                {act.shouldHaveStarted && (
                  <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-bold">
                    Debió iniciar: {act.startDate}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {act.areaName} • {act.structureName} • Meta: {act.targetUnits}{' '}
                {act.unit} (Pendiente: {act.pendingQty} {act.unit})
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono font-black text-[#0f6b38]">
                {act.progressPercent}%
              </span>
              {canCreateAdvance && (
                <button
                  onClick={() =>
                    onQuickRegisterAdvance({
                      areaName: act.areaName,
                      locationType: act.locationType || 'Todos',
                      sistemaName: act.sistemaName || '',
                      structureName: act.structureName || '',
                      activityId: act.id
                    })
                  }
                  className="px-2.5 py-1 rounded-lg bg-[#0f6b38] text-white font-bold text-[11px]"
                >
                  + Avance
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
