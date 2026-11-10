type MaterialData = Record<string, any>;
const codeKey = (code: unknown) => String(code || '').trim().toUpperCase();
const add = (index: Map<string, number>, key: string, quantity: number) =>
  index.set(key, (index.get(key) ?? 0) + quantity);

export function indexMaterialConsumption(advances: MaterialData[]) {
  const byId = new Map<string, number>();
  const byCode = new Map<string, number>();
  const byBarnCode = new Map<string, number>();
  for (const advance of advances) {
    if (!advance || advance.conflictStatus === 'conflict' || !Array.isArray(advance.materialsUsedToday)) continue;
    for (const usage of advance.materialsUsedToday) {
      const quantity = Number(usage?.qty);
      if (!Number.isFinite(quantity) || quantity < 0) continue;
      if (usage.materialId) {
        add(byId, usage.materialId, quantity);
      } else {
        const code = codeKey(usage.code);
        add(byCode, code, quantity);
        add(byBarnCode, JSON.stringify([advance.galponId, code]), quantity);
      }
    }
  }
  return (material: MaterialData) => {
    const initial = Number(material.initialUsedQty || 0);
    const code = codeKey(material.code);
    const legacy = material.galponId
      ? byBarnCode.get(JSON.stringify([material.galponId, code]))
      : byCode.get(code);
    return Math.max(0, Math.round(((Number.isFinite(initial) ? initial : 0) +
      (byId.get(material.id) ?? 0) + (legacy ?? 0)) * 100) / 100);
  };
}

export function computeMaterialUsedQty(material: MaterialData, advances: MaterialData[]): number {
  return indexMaterialConsumption(advances)(material);
}
