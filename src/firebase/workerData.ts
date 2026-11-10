const textLimits = { workerCode: 120, dni: 64, name: 200, workArea: 160, role: 160, sectorId: 240, galponId: 240 } as const;

export function normalizeWorkerCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function invalidWorkerField(worker: Record<string, unknown>, importing = false): string | undefined {
  for (const [field, limit] of Object.entries(textLimits)) {
    const value = worker[field];
    const required = field === 'name' || (importing && ['workerCode', 'workArea', 'role'].includes(field));
    if (value === undefined && !required) continue;
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) ||
        (field === 'workerCode' ? normalizeWorkerCode(value).length : value.trim().length) > limit ||
        (required && !value.trim())) return field;
  }
  if (worker.active !== undefined && typeof worker.active !== 'boolean') return 'active';
}

export function workerForDisplay<T extends Record<string, unknown>>(worker: T): T {
  const fields = Object.fromEntries(Object.keys(textLimits).map(field => [field,
    typeof worker[field] === 'string' ? worker[field] : ''
  ]));
  return { ...worker, ...fields, active: typeof worker.active === 'boolean' ? worker.active : true };
}

export function workerAtLocation(worker: Record<string, unknown>, sectorId: string, galponId: string) {
  return worker.active !== false && (worker.galponId ? worker.galponId === galponId && (!worker.sectorId || worker.sectorId === sectorId)
    : worker.sectorId === sectorId);
}
