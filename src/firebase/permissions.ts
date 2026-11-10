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

const codes = {
  Administrador:       ['VCEDIX', 'VCEDIX', 'VCEDIX', 'VCEDIX', 'VCEDIX', 'VCEDIX', 'VCEDIX', 'VCEDIX', 'VCEDIX', 'VCEDIX', 'VCIX'],
  'Jefe de proyecto':  ['VX',     'VCDEX',  'VCDEX',  'VCDEX',  'VCDEX',  'V',      'V',      'V',      'V',      'VCDEX',  'V'],
  Supervisor:          ['V',      'VCED',   'VCED',   'VCEX',   'VCDEX',  'V',      'V',      'V',      'VCDEX',  'VCDEX',  'V'],
  Auxiliar:            ['',       '',      'VCED',   'VCDEX',  'VCE',    '',       'V',      'V',      'VC',     'VCDEX',  'V'],
  'Almacén':           ['V',      'V',     'V',      'VCDEX',  'V',      'V',      'V',      'VCEDIX', 'VCDEX',  'VCDEX',  'V'],
  'Solo lectura':      ['',       '',      '',       '',       '',       '',       '',       '',       '',       '',       '']
} as const satisfies Record<OfficialRole, readonly string[]>;

export const APP_MODULES = Object.keys(MODULE_LABELS) as AppModuleId[];
const actions = { view: 'V', create: 'C', edit: 'E', delete: 'D', import: 'I', export: 'X' } as const;

export const ROLE_PERMISSION_MATRIX = Object.fromEntries(Object.entries(codes).map(([role, row]) =>
  [role, Object.fromEntries(APP_MODULES.map((module, index) => [
    module, Object.fromEntries(Object.entries(actions).map(([action, flag]) => [action, row[index].includes(flag)]))
  ]))]
)) as unknown as Record<OfficialRole, Record<AppModuleId, ModulePermissionSet>>;

type PermissionProfile = Pick<UserProfile, 'role' | 'active'> &
  Partial<Pick<UserProfile, 'uid'>> & { provisioning?: unknown; pendingLink?: boolean; linkedUid?: string };

/**
 * Verifica si un usuario tiene permiso para ejecutar una acción específica en un módulo.
 * Si el perfil es nulo o inactivo, deniega siempre.
 */
export function canDo(
  profile: PermissionProfile | null | undefined,
  moduleId: AppModuleId,
  action: PermissionAction
): boolean {
  if (!profile || profile.active !== true || profile.uid?.startsWith('preauth_') ||
      profile.provisioning || profile.pendingLink || profile.linkedUid ||
      !Object.prototype.hasOwnProperty.call(ROLE_PERMISSION_MATRIX, profile.role)) return false;
  const roleMatrix = ROLE_PERMISSION_MATRIX[profile.role];
  if (!roleMatrix) return false;
  const modulePerms = roleMatrix[moduleId];
  if (!modulePerms) return false;
  return Boolean(modulePerms[action]);
}

export const hasModulePermission = canDo;

export function resolveModule(profile: PermissionProfile | null | undefined, requested: string): AppModuleId | null {
  const module = APP_MODULES.find(candidate => candidate === requested);
  return module && canDo(profile, module, 'view') ? module
    : APP_MODULES.find(candidate => canDo(profile, candidate, 'view')) ?? null;
}

