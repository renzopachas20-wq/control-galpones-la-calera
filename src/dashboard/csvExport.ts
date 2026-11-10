export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = String(value).replace(/[\r\n]+/g, ' ');
  const formula = typeof value === 'string' && (/^[\t\r\n]/.test(value) || /^[\s\uFEFF]*[=+\-@＝＋－＠]/u.test(value));
  return '"' + (formula ? "'" : '') + text.replace(/"/g, '""') + '"';
}
