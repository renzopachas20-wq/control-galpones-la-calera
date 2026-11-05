import type { OfficialRole, UserProfile } from './authService';

export type AppModuleId =
  | 'dashboard'
  | 'gantt'
  | 'avance_diario'
  | 'asistencia'
  | 'proyectos'
  | 'catalogo'
  | 'actividades'
  | 'materiales'
  | 'personal'
  | 'informes'
  | 'movimientos';

export type PermissionAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'import'
  | 'export';

export interface ModulePermissionSet {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  import: boolean;
  export: boolean;
}

export const MODULE_LABELS: Record<AppModuleId, string> = {
  dashboard: 'Dashboard',
  gantt: 'Cronograma Gantt',
  avance_diario: 'Avance Diario',
  asistencia: 'Control de Asistencia',
  proyectos: 'Sectores y Galpones',
  catalogo: 'Catálogo Maestro y Plantillas',
  actividades: 'Gestión de Actividades',
  materiales: 'Control de Materiales',
  personal: 'Planilla de Personal',
  informes: 'Informes Globales',
  movimientos: 'Historial de Movimientos'
};

export const ACTION_LABELS: Record<PermissionAction, string> = {
  view: 'Consultar',
  create: 'Crear',
  edit: 'Editar',
  delete: 'Eliminar',
  import: 'Importar',
  export: 'Exportar'
};

const ALL_TRUE: ModulePermissionSet = {
  view: true,
  create: true,
  edit: true,
  delete: true,
  import: true,
  export: true
};

const READ_EXPORT: ModulePermissionSet = {
  view: true,
  create: false,
  edit: false,
  delete: false,
  import: false,
  export: true
};

const READ_ONLY: ModulePermissionSet = {
  view: true,
  create: false,
  edit: false,
  delete: false,
  import: false,
  export: false
};

const NONE: ModulePermissionSet = {
  view: false,
  create: false,
  edit: false,
  delete: false,
  import: false,
  export: false
};

/**
 * Matriz Oficial de Roles y Permisos por Módulo (11 módulos x 6 acciones).
 * Cada acción (view, create, edit, delete, import, export) se controla de manera independiente.
 */
export const ROLE_PERMISSION_MATRIX: Record<OfficialRole, Record<AppModuleId, ModulePermissionSet>> = {
  'Administrador': {
    dashboard: { ...ALL_TRUE },
    gantt: { ...ALL_TRUE },
    avance_diario: { ...ALL_TRUE },
    asistencia: { ...ALL_TRUE },
    proyectos: { ...ALL_TRUE },
    catalogo: { ...ALL_TRUE },
    actividades: { ...ALL_TRUE },
    materiales: { ...ALL_TRUE },
    personal: { ...ALL_TRUE },
    informes: { ...ALL_TRUE },
    movimientos: {
      view: true,
      create: true,
      edit: false, // Historial de auditoría inmutable
      delete: false, // Historial de auditoría inmutable
      import: false,
      export: true
    }
  },
  'Jefe de proyecto': {
    dashboard: { ...READ_EXPORT },
    gantt: {
      view: true,
      create: true,
      edit: true,
      delete: true,
      import: true,
      export: true
    },
    avance_diario: {
      view: true,
      create: true,
      edit: true,
      delete: true,
      import: true,
      export: true
    },
    asistencia: {
      view: true,
      create: true,
      edit: true,
      delete: true,
      import: true,
      export: true
    },
    proyectos: {
      view: true,
      create: true,
      edit: true,
      delete: false, // Eliminación de sectores/galpones reservada a Administrador
      import: true,
      export: true
    },
    catalogo: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      import: true,
      export: true
    },
    actividades: {
      view: true,
      create: true,
      edit: true,
      delete: true,
      import: true,
      export: true
    },
    materiales: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      import: true,
      export: true
    },
    personal: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      import: true,
      export: true
    },
    informes: { ...READ_EXPORT },
    movimientos: { ...READ_EXPORT }
  },
  'Supervisor': {
    dashboard: { ...READ_EXPORT },
    gantt: {
      view: true,
      create: false,
      edit: true,
      delete: false,
      import: false,
      export: true
    },
    avance_diario: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      import: true,
      export: true
    },
    asistencia: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      import: true,
      export: true
    },
    proyectos: { ...READ_EXPORT },
    catalogo: { ...READ_EXPORT },
    actividades: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      import: false,
      export: true
    },
    materiales: {
      view: true,
      create: false,
      edit: true, // Consumo asociado a avances
      delete: false,
      import: false,
      export: true
    },
    personal: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      import: true,
      export: true
    },
    informes: { ...READ_EXPORT },
    movimientos: { ...READ_ONLY }
  },
  'Auxiliar': {
    dashboard: { ...READ_ONLY },
    gantt: { ...READ_ONLY },
    avance_diario: {
      view: true,
      create: true,
      edit: false,
      delete: false,
      import: false,
      export: true
    },
    asistencia: {
      view: true,
      create: true,
      edit: true,
      delete: false,
      import: false,
      export: true
    },
    proyectos: { ...READ_ONLY },
    catalogo: { ...READ_ONLY },
    actividades: { ...READ_ONLY },
    materiales: { ...READ_ONLY },
    personal: {
      view: true,
      create: false,
      edit: false,
      delete: false,
      import: false,
      export: true
    },
    informes: { ...READ_ONLY },
    movimientos: { ...NONE }
  },
  'Almacén': {
    dashboard: { ...READ_ONLY },
    gantt: { ...READ_ONLY },
    avance_diario: { ...READ_ONLY },
    asistencia: { ...NONE },
    proyectos: { ...READ_ONLY },
    catalogo: { ...READ_ONLY },
    actividades: { ...READ_ONLY },
    materiales: {
      view: true,
      create: true,
      edit: true,
      delete: true,
      import: true,
      export: true
    },
    personal: { ...NONE },
    informes: { ...READ_EXPORT },
    movimientos: { ...READ_ONLY }
  },
  'Solo lectura': {
    dashboard: { ...READ_EXPORT },
    gantt: { ...READ_EXPORT },
    avance_diario: { ...READ_EXPORT },
    asistencia: { ...READ_EXPORT },
    proyectos: { ...READ_EXPORT },
    catalogo: { ...READ_EXPORT },
    actividades: { ...READ_EXPORT },
    materiales: { ...READ_EXPORT },
    personal: { ...READ_EXPORT },
    informes: { ...READ_EXPORT },
    movimientos: { ...READ_ONLY }
  }
};

/**
 * Verifica si un usuario tiene permiso para ejecutar una acción específica en un módulo.
 * Si el perfil es nulo o inactivo, deniega siempre.
 */
export function hasModulePermission(
  profile: Pick<UserProfile, 'role' | 'active'> | null | undefined,
  moduleId: AppModuleId,
  action: PermissionAction
): boolean {
  if (!profile || !profile.active) return false;
  const roleMatrix = ROLE_PERMISSION_MATRIX[profile.role];
  if (!roleMatrix) return false;
  const modulePerms = roleMatrix[moduleId];
  if (!modulePerms) return false;
  return Boolean(modulePerms[action]);
}

/**
 * Determina si el usuario tiene alcance global (sin restricción de sector/galpón/proyecto).
 * El Administrador siempre tiene alcance global.
 * Otros roles tienen alcance global únicamente si no tienen asignaciones específicas restrictivas.
 */
export function hasGlobalScope(
  profile: Pick<UserProfile, 'role' | 'assignedProject' | 'assignedSectorIds' | 'assignedGalponIds'> | null | undefined
): boolean {
  if (!profile) return false;
  if (profile.role === 'Administrador') return true;
  const hasProjectFilter = Boolean(profile.assignedProject && profile.assignedProject.trim() !== '' && profile.assignedProject !== 'TODOS');
  const hasSectorFilter = Array.isArray(profile.assignedSectorIds) && profile.assignedSectorIds.length > 0;
  const hasGalponFilter = Array.isArray(profile.assignedGalponIds) && profile.assignedGalponIds.length > 0;
  return !hasProjectFilter && !hasSectorFilter && !hasGalponFilter;
}

/**
 * Verifica si un usuario puede acceder a un Sector específico según su alcance asignado.
 */
export function canAccessSector(
  profile: Pick<UserProfile, 'role' | 'active' | 'assignedProject' | 'assignedSectorIds' | 'assignedGalponIds'> | null | undefined,
  sector: {
    id: string;
    code?: string;
    name?: string;
    galpones?: Array<{ id: string; code?: string; projectCode?: string }>;
    sheds?: Array<{ id: string; code?: string; projectCode?: string }>;
  }
): boolean {
  if (!profile || !profile.active) return false;
  if (profile.role === 'Administrador') return true;

  const hasProjectFilter = Boolean(profile.assignedProject && profile.assignedProject.trim() !== '' && profile.assignedProject !== 'TODOS');
  const hasSectorFilter = Array.isArray(profile.assignedSectorIds) && profile.assignedSectorIds.length > 0;
  const hasGalponFilter = Array.isArray(profile.assignedGalponIds) && profile.assignedGalponIds.length > 0;

  if (!hasProjectFilter && !hasSectorFilter && !hasGalponFilter) {
    return true;
  }

  if (hasSectorFilter && profile.assignedSectorIds.includes(sector.id)) {
    return true;
  }

  const galponesList = Array.isArray(sector.galpones)
    ? sector.galpones
    : Array.isArray(sector.sheds)
    ? sector.sheds
    : [];

  if (hasGalponFilter && galponesList.length > 0) {
    if (galponesList.some((g) => profile.assignedGalponIds.includes(g.id))) {
      return true;
    }
  }

  if (hasProjectFilter) {
    const targetProj = profile.assignedProject!.trim().toLowerCase();
    if (
      (sector.code || '').trim().toLowerCase() === targetProj ||
      (sector.name || '').trim().toLowerCase().includes(targetProj) ||
      galponesList.some(
        (g) =>
          (g.projectCode || '').trim().toLowerCase() === targetProj ||
          (g.code || '').trim().toLowerCase() === targetProj
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Verifica si un usuario puede acceder a un Galpón específico dentro de un sector.
 */
export function canAccessGalpon(
  profile: Pick<UserProfile, 'role' | 'active' | 'assignedProject' | 'assignedSectorIds' | 'assignedGalponIds'> | null | undefined,
  galpon: { id: string; code?: string; projectCode?: string },
  sectorId?: string,
  sectorCode?: string
): boolean {
  if (!profile || !profile.active) return false;
  if (profile.role === 'Administrador') return true;

  const hasProjectFilter = Boolean(profile.assignedProject && profile.assignedProject.trim() !== '' && profile.assignedProject !== 'TODOS');
  const hasSectorFilter = Array.isArray(profile.assignedSectorIds) && profile.assignedSectorIds.length > 0;
  const hasGalponFilter = Array.isArray(profile.assignedGalponIds) && profile.assignedGalponIds.length > 0;

  if (!hasProjectFilter && !hasSectorFilter && !hasGalponFilter) {
    return true;
  }

  if (hasGalponFilter) {
    return profile.assignedGalponIds.includes(galpon.id);
  }

  if (hasSectorFilter && sectorId) {
    if (!profile.assignedSectorIds.includes(sectorId)) {
      return false;
    }
  }

  if (hasProjectFilter) {
    const targetProj = profile.assignedProject!.trim().toLowerCase();
    const matchesSectorCode = sectorCode && sectorCode.trim().toLowerCase() === targetProj;
    const matchesGalponCode =
      (galpon.projectCode && galpon.projectCode.trim().toLowerCase() === targetProj) ||
      (galpon.code && galpon.code.trim().toLowerCase() === targetProj);
    if (!matchesSectorCode && galpon.projectCode && !matchesGalponCode) {
      return false;
    }
  }

  return true;
}

/**
 * Filtra la estructura de Sectores y sus Galpones internos según el alcance del usuario autenticado.
 */
export function filterSectorsByScope<
  TSector extends {
    id: string;
    code?: string;
    name?: string;
    galpones?: Array<{ id: string; code?: string; projectCode?: string }>;
    sheds?: Array<{ id: string; code?: string; projectCode?: string }>;
  }
>(
  sectors: TSector[],
  profile: Pick<UserProfile, 'role' | 'active' | 'assignedProject' | 'assignedSectorIds' | 'assignedGalponIds'> | null | undefined
): TSector[] {
  if (!profile || !profile.active) return [];
  if (hasGlobalScope(profile)) return sectors;

  const filtered: TSector[] = [];
  for (const sector of sectors) {
    if (!canAccessSector(profile, sector)) continue;

    if (Array.isArray(sector.galpones)) {
      const allowedGalpones = sector.galpones.filter((g) =>
        canAccessGalpon(profile, g, sector.id, sector.code)
      );
      if (allowedGalpones.length > 0 || (profile.assignedSectorIds || []).includes(sector.id)) {
        filtered.push({
          ...sector,
          galpones: allowedGalpones
        });
      }
    } else if (Array.isArray(sector.sheds)) {
      const allowedSheds = sector.sheds.filter((g) =>
        canAccessGalpon(profile, g, sector.id, sector.code)
      );
      if (allowedSheds.length > 0 || (profile.assignedSectorIds || []).includes(sector.id)) {
        filtered.push({
          ...sector,
          sheds: allowedSheds
        });
      }
    } else {
      filtered.push(sector);
    }
  }
  return filtered;
}

