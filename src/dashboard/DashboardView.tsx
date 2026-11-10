import React, { useMemo } from 'react';
import {
  computeDashboardKpiSummary,
  type AreaProgressMetric,
  type AttendanceSummaryMetric,
  type DashboardFilterCriteria,
  type EvaluatedActivityItem,
  type SistemaLocationFilter,
  type SistemaProgressMetric
} from './dashboardSelectors';
import { EmptyGalponStateWidget } from './widgets/EmptyGalponStateWidget';
import { ExecutiveKpiCardsWidget } from './widgets/ExecutiveKpiCardsWidget';
import { AreaWeightedProgressWidget } from './widgets/AreaWeightedProgressWidget';
import { SystemWeightedProgressWidget } from './widgets/SystemWeightedProgressWidget';
import { ScheduleAlertsWidget } from './widgets/ScheduleAlertsWidget';

/**
 * Identificadores de los bloques/reportes independientes del Dashboard.
 * Para agregar un nuevo reporte en el futuro:
 * 1. Crear su componente independiente en `src/dashboard/widgets/`.
 * 2. Registrar su identificador en `DashboardWidgetId` y en `DASHBOARD_WIDGET_REGISTRY`.
 */
export type DashboardWidgetId =
  | 'executive_kpis'
  | 'area_weighted_progress'
  | 'system_weighted_progress'
  | 'schedule_alerts';

export interface DashboardWidgetDefinition {
  id: DashboardWidgetId;
  title: string;
  enabled: boolean;
  render: (ctx: DashboardRenderContext) => React.ReactNode;
}

export interface DashboardRenderContext {
  currentSector: any | null;
  currentGalpon: any;
  galponWeightedProgress: number;
  evaluatedActivities: EvaluatedActivityItem[];
  areaProgressMetrics: AreaProgressMetric[];
  sistemaProgressMetrics: SistemaProgressMetric[];
  currentDayAttendance: AttendanceSummaryMetric;
  attendanceDate: string;
  dashSistemaLocFilter: SistemaLocationFilter;
  setDashSistemaLocFilter: (loc: SistemaLocationFilter) => void;
  dashPendingAreaFilter: string;
  setDashPendingAreaFilter: (area: string) => void;
  canCreateAdvance: boolean;
  onNavigateTab: (tab: string) => void;
  onOpenNewAdvanceModal: (prefill?: {
    areaName?: string;
    locationType?: string;
    sistemaName?: string;
    structureName?: string;
    activityId?: string;
  }) => void;
  activeFilters?: DashboardFilterCriteria;
}

/**
 * Registro declarativo de reportes modulares del Dashboard.
 * Permite agregar, reordenar, modificar o retirar reportes individuales sin reconstruir
 * ni afectar los demás componentes ni los módulos operativos.
 */
export const DASHBOARD_WIDGET_REGISTRY: readonly DashboardWidgetDefinition[] = [
  {
    id: 'executive_kpis',
    title: 'Indicadores Ejecutivos (KPIs)',
    enabled: true,
    render: (ctx) => {
      const kpiSummary = computeDashboardKpiSummary({
        evaluatedActivities: ctx.evaluatedActivities,
        galponWeightedProgress: ctx.galponWeightedProgress,
        currentDayAttendance: ctx.currentDayAttendance,
        attendanceDate: ctx.attendanceDate,
        technology: ctx.currentGalpon?.technology
      });
      return <ExecutiveKpiCardsWidget kpiSummary={kpiSummary} />;
    }
  },
  {
    id: 'area_weighted_progress',
    title: 'Avance Ponderado por Área',
    enabled: true,
    render: (ctx) => (
      <AreaWeightedProgressWidget
        galponCode={ctx.currentGalpon.code}
        areaProgressMetrics={ctx.areaProgressMetrics}
        onManageActivities={() => ctx.onNavigateTab('actividades')}
      />
    )
  },
  {
    id: 'system_weighted_progress',
    title: 'Avance Ponderado por Sistema General',
    enabled: true,
    render: (ctx) => (
      <SystemWeightedProgressWidget
        sistemaProgressMetrics={ctx.sistemaProgressMetrics}
        locationFilter={ctx.dashSistemaLocFilter}
        onChangeLocationFilter={ctx.setDashSistemaLocFilter}
      />
    )
  },
  {
    id: 'schedule_alerts',
    title: 'Alertas de Cronograma y Pendientes por Área',
    enabled: true,
    render: (ctx) => (
      <ScheduleAlertsWidget
        evaluatedActivities={ctx.evaluatedActivities}
        pendingAreaFilter={ctx.dashPendingAreaFilter}
        onChangePendingAreaFilter={ctx.setDashPendingAreaFilter}
        canCreateAdvance={ctx.canCreateAdvance}
        onQuickRegisterAdvance={(prefill) => ctx.onOpenNewAdvanceModal(prefill)}
      />
    )
  }
];

export interface DashboardViewProps extends DashboardRenderContext {
  enabledWidgetIds?: readonly DashboardWidgetId[];
}

/**
 * Contenedor Principal del Dashboard Modular.
 * Separa estrictamente la sincronización de Firestore, los cálculos operativos y la presentación visual.
 */
export const DashboardView: React.FC<DashboardViewProps> = (props) => {
  const { currentGalpon, onNavigateTab, enabledWidgetIds } = props;

  const activeWidgets = useMemo(() => {
    return DASHBOARD_WIDGET_REGISTRY.filter((widget) => {
      if (!widget.enabled) return false;
      if (enabledWidgetIds && !enabledWidgetIds.includes(widget.id)) return false;
      return true;
    });
  }, [enabledWidgetIds]);

  if (!currentGalpon) {
    return (
      <div className="space-y-6">
        <EmptyGalponStateWidget
          onGoToCatalog={() => onNavigateTab('catalogo')}
          onGoToProjects={() => onNavigateTab('proyectos')}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {activeWidgets.map((widget) => (
        <React.Fragment key={widget.id}>{widget.render(props)}</React.Fragment>
      ))}
    </div>
  );
};
