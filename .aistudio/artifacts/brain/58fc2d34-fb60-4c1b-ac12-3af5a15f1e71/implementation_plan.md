# Auditoría y Plan de Corrección: Módulo de Materiales (Etapa 1)

Este documento integra el diagnóstico de auditoría técnica y las **6 condiciones obligatorias** para corregir el **Módulo de Materiales** y limpiar los valores predeterminados fijos, garantizando trazabilidad por identificadores únicos, protección de registros antiguos en `localStorage` y cero alteraciones al diseño o a módulos ajenos.

---

## Condiciones Obligatorias Incorporadas

> [!IMPORTANT]
> Estas 6 directrices rigen de forma estricta la implementación de esta etapa:

1. **Identificación Inequívoca por IDs**:
   - Cada material guardará explícitamente: `id`, `sectorId`, `galponId`, `areaId`, `areaName`, `locationType`, `sistemaId`, `sistemaName`, `structureId` y `structureName` (utilizando los identificadores únicos `id` del sector, galpón, área, sistema y estructura cuando estén disponibles en el galpón).
   - Ninguna asociación ni descuento de stock se realizará únicamente por nombre de estructura o por código de material (`code`).
2. **Protección de Registros Antiguos**:
   - Se conservarán intactos todos los materiales existentes en `localStorage` (y se eliminará cualquier rutina de borrado de datos).
   - Si un material existente no posee `galponId`, se mostrará claramente en la interfaz como **"Sin galpón asignado"**, sin asignarle automáticamente ningún galpón ni borrarlo.
3. **Vista y Filtros de Materiales**:
   - La tabla de Materiales mostrará de forma explícita: **Galpón** (o *"Sin galpón asignado"*), **Proveedor**, **Código**, **Material**, **Área**, **Sistema** y **Estructura Vinculada**, además de Total Presupuestado, Consumido, Saldo y Acciones.
   - Al guardar o editar un material, se verificará el estado de los filtros (`filterMaterialGalpon`, `filterMaterialTech`, `filterMaterialArea` y `searchMaterialText`) y se restablecerán automáticamente si ocultasen el material recién guardado, garantizando que **siempre quede visible de inmediato**.
4. **Formularios Vacíos sin Perder Opciones del Usuario**:
   - Se eliminarán las preselecciones automáticas y valores predeterminados fijos en código (`'Big Herdsman'`, `'Sistema de Jaulas'`, `'Estructura Principal'`, `'Sistema General'`, `'Und'`, etc.).
   - Se conservarán todas las opciones creadas por el usuario en los desplegables y se mantendrá intacto el autocompletado legítimo desde el **Catálogo Maestro**.
5. **Consumo de Materiales Trazable por Identificador Único (`materialId`)**:
   - Tanto en `manualMaterialInputs` como en `materialsUsedToday` y en el descuento de `usedQty` dentro de `handleSaveAdvance`, cada consumo se indexará y descontará mediante el **identificador único del material (`mat.id` / `materialId`)**, nunca solo por `mat.code`.
   - Cada registro en `materialsUsedToday` almacenará `{ materialId, code, name, qty, unit }`, dejando lista la trazabilidad exacta para que al editar avances diarios se pueda revertir el consumo previo y recalcularlo sin duplicaciones.
6. **Protección del Proyecto y Alcance Acotado**:
   - No se eliminarán datos de `localStorage` ni se ejecutarán rutinas de limpieza.
   - No se cambiará el diseño general ni se reconstruirá la aplicación.
   - Se modificará únicamente lo correspondiente al módulo de materiales y la limpieza de valores predeterminados compartidos en `src/App.tsx`.

---

## 1. Modelo de Datos y Asociación Jerárquica de Materiales

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     ESTRUCTURA DEL REGISTRO DE MATERIAL                      │
│  {                                                                           │
│    id: "mat_...",                                                            │
│    sectorId: "sec_..." | "",          // Sector del galpón seleccionado      │
│    galponId: "gal_..." | "",          // "" => "Sin galpón asignado"         │
│    technology: "...",                 // Proveedor exacto elegido por usuario│
│    areaId: "area_..." | "",           // ID único del área en el galpón      │
│    areaName: "...",                   // Nombre del área                     │
│    locationType: "Interno"|"Externo"|"", // Ubicación del sistema si aplica  │
│    sistemaId: "sis_..." | "",         // ID único del sistema en el galpón   │
│    sistemaName: "..." | null,         // Nombre del sistema (si aplica)      │
│    structureId: "str_..." | "",       // ID único de la estructura           │
│    structureName: "...",              // Nombre de la estructura             │
│    code: "...",                                                              │
│    name: "...",                                                              │
│    totalQty: number,                                                         │
│    usedQty: number,                                                          │
│    unit: "..."                                                               │
│  }                                                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Relación con `currentGalpon`, `evaluatedActivities` y `linkedMaterials`
- En `evaluatedActivities`, los materiales vinculados (`linkedMaterials`) de cada actividad del galpón activo se resolverán verificando:
  1. **Coincidencia de Galpón**: `m.galponId === currentGalpon.id`. (Los materiales antiguos `"Sin galpón asignado"` no se mezclarán silenciosamente con otros galpones hasta que el usuario decida asignarlos en Editar Material).
  2. **Coincidencia de Estructura / Sistema / Área por ID único (con respaldo jerárquico exacto)**:
     - Si el material posee `structureId` (y `sistemaId` / `areaId`), se valida `m.structureId === str.id` (y `m.sistemaId === sis.id`, `m.areaId === area.id`).
     - Si la estructura fue creada antes de tener `structureId` directo, se valida la ruta jerárquica completa dentro del mismo `galponId`: `m.areaName === area.name`, `(m.sistemaName || '') === (sis.name || '')` y `m.structureName.toLowerCase() === str.name.toLowerCase()`.
- En el **Modal de Avance Diario (`modalNewAdvance`) y `handleSaveAdvance`**:
  - Los inputs manuales de consumo se guardarán en `formAdvance.manualMaterialInputs[mat.id]` usando el ID único del material.
  - Al guardar el avance, `materialsUsedToday` registrará `{ materialId: mat.id, code: mat.code, name: mat.name, qty: qtyUsed, unit: mat.unit }`.
  - El descuento en `setMaterials` actualizará únicamente el material cuyo `m.id === found.materialId`.

---

## 2. Detalle de Funciones a Modificar en `src/App.tsx`

| Función / Bloque | Cambio Específico |
| :--- | :--- |
| **Inicialización de `localStorage`** | Eliminar el bloque de limpieza inicial de claves antiguas para garantizar que jamás se ejecuten rutinas de borrado sobre `localStorage`. |
| **Estado `formMaterial` y `openNewMaterialModal`** | Iniciar todos los campos en vacío (`""`): `sectorId: ''`, `galponId: ''`, `technology: ''`, `areaId: ''`, `areaName: ''`, `locationType: ''`, `sistemaId: ''`, `sistemaName: ''`, `customSistemaName: ''`, `structureId: ''`, `structureName: ''`, `customStructureName: ''`, `code: ''`, `name: ''`, `totalQty: ''`, `usedQty: 0`, `unit: ''`. |
| **`openEditMaterialModal`** | Cargar los campos exactos del material (`mat.sectorId \|\| ''`, `mat.galponId \|\| ''`, `mat.technology \|\| ''`, `mat.areaId \|\| ''`, `mat.areaName \|\| ''`, `mat.locationType \|\| ''`, `mat.sistemaId \|\| ''`, `mat.sistemaName \|\| ''`, `mat.structureId \|\| ''`, `mat.structureName \|\| ''`, `mat.unit \|\| ''`), sin asignar valores por defecto si un registro antiguo no tiene `galponId`. |
| **`handleSaveMaterial`** | Resolver los IDs únicos (`sectorId`, `galponId`, `areaId`, `sistemaId`, `structureId`) a partir del galpón, área, sistema y estructura seleccionados; guardar el proveedor exacto (`formMaterial.technology`) sin fallback `'Big Herdsman'`; y sincronizar los filtros de la tabla (`filterMaterialGalpon`, `filterMaterialTech`, `filterMaterialArea`, `searchMaterialText`) para que el material recién guardado aparezca de inmediato en la lista. |
| **Modal `modalNewMaterial` (JSX)** | Incluir selectores explícitos sin preselección para: **1. Galpón**, **2. Proveedor**, **3. Área**, **4. Sistema** (cuando el área pertenece a `AREAS_WITH_SISTEMAS`), **5. Estructura**, **6. Código y Unidad**, **7. Nombre y Cantidad Total**, alimentados por los registros creados por el usuario. |
| **Tabla y Filtros de Materiales (`currentTab === 'materiales'`)** | Añadir filtro por **Galpón** (`Todos los Galpones`, `"Sin galpón asignado"` o cada galpón registrado), mostrar columnas de **Galpón, Proveedor, Código, Material, Área, Sistema y Estructura**, y ampliar el buscador para filtrar por código, nombre, sistema, estructura y galpón. |
| **Limpieza de valores predeterminados compartidos** | Iniciar vacíos los valores fijos por defecto en los estados de formularios al abrir modales nuevos, manteniendo al 100% las listas creadas por el usuario y el autocompletado desde el Catálogo Maestro. |

---

## 3. Plan de Pruebas y Verificación Posterior a la Implementación

Una vez aplicado el código en `src/App.tsx`, se ejecutarán y reportarán las siguientes pruebas:
1. **Compilación y Linter (`compile_applet` y `lint_applet`)**: Verificación de cero errores de TypeScript o sintaxis.
2. **Prueba de Formulario Vacío**: Comprobar que al abrir **+ Asignar / Agregar Material**, ningún campo tenga valores preseleccionados (`Big Herdsman`, `Sistema de Jaulas`, `Und`, etc.).
3. **Prueba de Creación y Proveedor Exacto**: Crear materiales con distintos proveedores y verificar que se guarden exactamente con el proveedor elegido y aparezcan de inmediato en la tabla incluso si había filtros activos.
4. **Prueba de Asociación Inequívoca (Galpón → Área → Sistema → Estructura)**: Verificar que el material guarde sus IDs únicos (`sectorId`, `galponId`, `areaId`, `sistemaId`, `structureId`) y que en `evaluatedActivities` (`linkedMaterials`) solo se vincule a la actividad de ese galpón, área, sistema y estructura exactos.
5. **Prueba de Registros Antiguos ("Sin galpón asignado") y Edición**: Verificar que un material sin `galponId` se muestre como `"Sin galpón asignado"`, no se le asigne un galpón automáticamente y pueda editarse correctamente.
6. **Prueba de Persistencia**: Comprobar que tras recargar la página todos los materiales y asociaciones permanezcan intactos en `localStorage`.
