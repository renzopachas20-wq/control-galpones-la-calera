import React from 'react';
import { TrendingUp, UserCheck, CheckCircle2, Clock } from 'lucide-react';
import type { DashboardKpiSummary } from '../dashboardSelectors';

export interface ExecutiveKpiCardsWidgetProps {
  kpiSummary: DashboardKpiSummary;
}

/**
 * Reporte Modular 1: Tarjetas de Indicadores Ejecutivos (KPIs) del Galpón.
 * Componente independiente desacoplado de las consultas a Firestore.
 */
export const ExecutiveKpiCardsWidget: React.FC<ExecutiveKpiCardsWidgetProps> = ({
  kpiSummary
}) => {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase mb-1">
          <span>Avance Ponderado</span>
          <TrendingUp className="w-4 h-4 text-[#0f6b38]" />
        </div>
        <span className="text-3xl font-black text-[#0f6b38] font-mono">
          {kpiSummary.weightedProgress}%
        </span>
        <p className="text-[11px] text-slate-400 mt-1">
          Plantilla: {kpiSummary.technology}
        </p>
      </div>

      <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase mb-1">
          <span>Asistencia Hoy</span>
          <UserCheck className="w-4 h-4 text-[#0f6b38]" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-black text-slate-900 font-mono">
            {kpiSummary.attendanceRate}%
          </span>
          <span className="text-xs text-slate-500">
            ({kpiSummary.attendancePresent}/{kpiSummary.attendanceTotal})
          </span>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">
          Fecha: {kpiSummary.attendanceDate}
        </p>
      </div>

      <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase mb-1">
          <span>Actividades</span>
          <CheckCircle2 className="w-4 h-4 text-[#0f6b38]" />
        </div>
        <span className="text-3xl font-black text-slate-900 font-mono">
          {kpiSummary.completedActivitiesCount}/{kpiSummary.totalActivitiesCount}
        </span>
        <p className="text-[11px] text-rose-600 font-bold mt-1">
          {kpiSummary.overdueStartActivitiesCount} sin iniciar en fecha
        </p>
      </div>

      <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-500 uppercase mb-1">
          <span>Horas Hombre (HH)</span>
          <Clock className="w-4 h-4 text-[#0f6b38]" />
        </div>
        <span className="text-3xl font-black text-slate-900 font-mono">
          {kpiSummary.accumulatedHH}
        </span>
        <p className="text-[11px] text-slate-400 mt-1">
          Planificadas: {kpiSummary.plannedHH} HH
        </p>
      </div>
    </div>
  );
};
