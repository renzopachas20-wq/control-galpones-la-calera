import React from 'react';
import type { AreaProgressMetric } from '../dashboardSelectors';

export interface AreaWeightedProgressWidgetProps {
  galponCode: string;
  areaProgressMetrics: AreaProgressMetric[];
  onManageActivities: () => void;
}

/**
 * Reporte Modular 2: Avance Ponderado por las 6 Áreas Constructivas.
 * Componente independiente que recibe métricas calculadas por los selectores del Dashboard.
 */
export const AreaWeightedProgressWidget: React.FC<AreaWeightedProgressWidgetProps> = ({
  galponCode,
  areaProgressMetrics,
  onManageActivities
}) => {
  return (
    <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-xs">
      <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
        <div>
          <h3 className="text-sm sm:text-base font-extrabold text-slate-900">
            Avance Ponderado por Área ({galponCode})
          </h3>
          <p className="text-xs text-slate-500">
            Obra Civil, Edificio, Sistema de Jaulas, Sistema Eléctrico,
            Gasfitería y Soldadura
          </p>
        </div>
        <button
          onClick={onManageActivities}
          className="text-xs font-bold text-[#0f6b38] hover:underline"
        >
          Gestionar Actividades →
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {areaProgressMetrics.map((area, idx) => (
          <div
            key={idx}
            className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/70"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-extrabold text-slate-800">
                {area.name}
              </span>
              <span className="text-xs font-mono font-black text-[#0f6b38]">
                {area.percent}%
              </span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden mb-1.5">
              <div
                className="bg-[#0f6b38] h-full rounded-full transition-all duration-500"
                style={{ width: `${area.percent}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-slate-500">
              <span>Actividades: {area.total}</span>
              <span>Completadas: {area.completed}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
