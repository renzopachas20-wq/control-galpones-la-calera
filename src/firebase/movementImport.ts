import { MODULE_LABELS } from './permissions';

export type HistoricalMovement = {
  sourceId: string;
  timestamp: string;
  module: string;
  type: 'REGISTRO' | 'MODIFICACIÓN' | 'ELIMINACIÓN';
  detail: string;
  originalActor?: string;
};

export function parseMovementTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const raw = String(value ?? '').trim();
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[, ]+(\d{1,2}):(\d{2}):(\d{2})$/.exec(raw);
  const normalized = local
    ? `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}T${local[4].padStart(2, '0')}:${local[5]}:${local[6]}-05:00`
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(' ', 'T') + '-05:00' : raw;
  const calendarDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    ? normalized.slice(0, 10) : null;
  if (!calendarDate || !Number.isFinite(Date.parse(normalized)) ||
      !new Date(calendarDate + 'T00:00:00Z').toISOString().startsWith(calendarDate + 'T')) return null;
  return new Date(normalized).toISOString();
}

export async function parseMovementTable(rows: unknown[][]): Promise<HistoricalMovement[]> {
  const [head = [], ...lines] = rows;
  const columns = head.map(value => String(value ?? '').trim().toLowerCase());
  const locate = (...names: string[]) => columns.findIndex(column => names.includes(column));
  const date = locate('fecha y hora', 'timestamp'), module = locate('módulo', 'module');
  const type = locate('tipo de movimiento', 'type'), detail = locate('detalle del movimiento', 'detail');
  const author = locate('usuario', 'originalactor'), id = locate('id', 'sourceid');
  if ([date, module, type, detail].some(index => index < 0)) throw new Error('Faltan encabezados de fecha, módulo, tipo o detalle.');
  const populated = lines.filter(row => row.some(value => String(value ?? '').trim()));
  if (populated.length < 1 || populated.length > 100) throw new Error('Importe entre 1 y 100 movimientos por archivo.');
  const entries = await Promise.all(populated.map(async (row, index) => {
    const time = parseMovementTimestamp(row[date]);
    const action = String(row[type] ?? '').trim().toUpperCase() as HistoricalMovement['type'];
    const group = String(row[module] ?? '').trim();
    const description = String(row[detail] ?? '').trim();
    const originalActor = String(row[author] ?? '').trim();
    if (!time || !['REGISTRO', 'MODIFICACIÓN', 'ELIMINACIÓN'].includes(action) ||
        !Object.values(MODULE_LABELS).includes(group) || group === MODULE_LABELS.movimientos ||
        !description || description.length > 5000 || originalActor.length > 160) {
      throw new Error('Revise la fecha, módulo, tipo y detalle de la fila ' + (index + 2) + '.');
    }
    const provided = String(row[id] ?? '').trim();
    if (provided && (!/^[A-Za-z0-9_-]{1,160}$/.test(provided))) throw new Error('ID inválido en la fila ' + (index + 2) + '.');
    const encoded = new TextEncoder().encode(JSON.stringify([time, action, group, description, originalActor]));
    const hash = provided ? '' : [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { sourceId: provided || hash, timestamp: time, type: action, module: group, detail: description,
      ...(originalActor ? { originalActor } : {}) };
  }));
  if (new Set(entries.map(entry => entry.sourceId)).size !== entries.length) throw new Error('El archivo contiene movimientos duplicados.');
  return entries;
}

export async function readMovementFile(file: Pick<File, 'name' | 'text' | 'arrayBuffer'>) {
  const XLSX = await import('xlsx');
  const workbook = /\.csv$/i.test(file.name)
    ? XLSX.read(await file.text(), { type: 'string', raw: true, sheetRows: 102 })
    : XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, sheetRows: 102 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet?.['!ref']) throw new Error('La primera hoja está vacía.');
  const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
  if (range.e.r - range.s.r > 100 || range.e.c - range.s.c >= 64) throw new Error('Importe hasta 100 movimientos y 64 columnas.');
  return parseMovementTable(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }));
}
