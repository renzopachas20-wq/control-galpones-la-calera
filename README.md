# Control Galpones La Calera

Aplicación operativa para proyectos, sectores y galpones. El cliente React y Vite usa Firebase Authentication para identificar al usuario. Express, Firebase Admin SDK y el cliente de Cloud Firestore ejecutan la autorización, el alcance y las escrituras. La API web se sirve desde el mismo origen.

## Desarrollo y validación

Usar Node.js 24. Mantener las dependencias de `bun.lock` e instalarlas con `bun install --frozen-lockfile` si aún no están disponibles. Los comandos del proyecto también funcionan con npm usando las dependencias ya instaladas.

```sh
npm test
npm run lint
npm run lint:rules
npm run build:isolated
```

`build:isolated` compila en una carpeta temporal y comprueba que el archivo de metadatos versionado se conservó. `build` genera `dist/` y actualiza `src/generated/versionMetadata.json`. Usarlo en un checkout preparado para empaquetar. `dist/` contiene el cliente compilado, el manifiesto, los iconos y `sw.js`. Para probar la PWA usar Express sirviendo ese build por HTTPS o loopback. El servidor Vite de desarrollo no registra el worker.

### Pruebas con datos sintéticos

1. Iniciar Firebase Auth Emulator y Firestore Emulator en loopback con proyecto `demo-calera-phase11`. Las pruebas de integración usan la base nombrada sintética `calera-audit` y cargan allí las reglas del repositorio.
2. Definir `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099` y `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, ajustando los puertos a la ejecución local. Ejecutar `npm run test:security:emulator`. Se necesitan ambos emuladores para obtener la cobertura completa.
   Con los mismos emuladores, ejecutar `npm run test:browser` para reproducir la aceptación en Chromium. Usar `CALERA_CHROME` para indicar el ejecutable de Chrome, Edge o Chromium si difiere de la ruta predeterminada. El script usa un perfil de navegador temporal y una base sintética distinta por ejecución.
3. Para abrir el cliente con emuladores en desarrollo, definir también `CALERA_DEMO_PROJECT=demo-calera-phase11`, `VITE_CALERA_DEMO_PROJECT=demo-calera-phase11` y `VITE_CALERA_AUTH_EMULATOR=http://127.0.0.1:9099`. Ejecutar `npm run dev`. Sembrar usuarios sintéticos en Auth y sus perfiles por UID en la base nombrada indicada por la configuración. La suite automatizada siembra sus propios datos.
4. Para verificar el modo sin red en navegador, iniciar sesión con una cuenta sintética, abrir Asistencia, registrar un cambio sin conexión, volver a cargar el documento y reconectar. La aplicación recupera el shell sin red, exige verificar el usuario antes de abrir datos operativos y reenvía la cola del autor al reconectar.

Los adaptadores rechazan hosts de emulador que no sean loopback, proyectos sintéticos que no tengan el prefijo `demo-` y emuladores bajo el servidor de producción o Cloud Run. Antes de preparar un paquete para entrega, compilar sin las variables `VITE_CALERA_*`.

## Permisos y datos

La matriz en [permissions.ts](src/firebase/permissions.ts) contiene seis roles, once módulos y seis acciones. `canDo` controla navegación y acciones. Las rutas de datos vuelven a autorizar cada solicitud con el perfil actual y comprueban la revocación. Las reglas de Firestore cierran el acceso directo desde el cliente. Los roles habilitados en cada módulo acceden a los registros del módulo en todos los proyectos, sectores y galpones. Los avances conservan el UID de su autor para auditoría. Las asignaciones de Personal ubican físicamente a los trabajadores. El campo Responsable del galpón es texto libre.

`Solo lectura` puede autenticarse y solo ve la pantalla de acceso restringido. Auxiliar entra en Avance Diario si no hay una ruta autorizada en la URL y puede consultar Movimientos. Los permisos de Gantt se aplican a sus acciones de cronograma. Administración de usuarios se autoriza por separado.

La API devuelve lotes de colecciones autorizadas mediante `/api/data/snapshot`. La vista sincroniza periódicamente y el cliente agrupa lecturas para compartir la consulta de autorización. Las colecciones grandes aún requieren medir lecturas, tamaño de respuestas y contención con datos representativos. Consultar [security_spec.md](security_spec.md) para las rutas, el diario y la reconciliación.

## Offline, concurrencia y auditoría

Las cachés del navegador se separan por UID y rol. La cola conserva al autor, UUID, contexto disponible, revisión y datos de la operación. Las colas históricas con UID y rol verificables siguen disponibles para su autor. Los intentos sin identidad verificable quedan en cuarentena. Después de una recarga, hace falta una conexión para volver a verificar la sesión antes de mostrar datos operativos. Una sesión abierta y verificada puede registrar cambios offline durante hasta 8 horas desde la última verificación satisfactoria. `VITE_OFFLINE_AUTH_MINUTES` permite fijar un intervalo de 15 a 1440 minutos al compilar. Al vencer, la vista operativa se cierra y la cola queda en el dispositivo. La administración de usuarios requiere autorización en línea. Una revocación remota solo puede conocerse al recuperar comunicación con Firebase y la API. Los navegadores con Web Locks serializan las actualizaciones locales de la cola entre pestañas.

Cada reenvío vuelve a comprobar la autorización. El servidor registra el recibo y el movimiento junto con la escritura operativa. Si la respuesta se pierde, el recibo permite confirmar el mismo UUID. Los registros editables usan revisión y se detectan eliminaciones previas. Asistencia combina cambios por trabajador y rechaza una modificación si la marca previa de ese trabajador cambió. El Centro de Sincronización conserva el intento y muestra el conflicto. Para corregirlo, revisar el registro vigente, retirar el intento rechazado y registrar el valor acordado. Los intentos antiguos sin valor previo pueden sincronizar registros nuevos o ya iguales. Cuando hay una edición simultánea de una misma actividad, el Centro de Sincronización conserva el conflicto. Los cambios concurrentes en la estructura del sector requieren revisar el registro y la operación pendiente.

El consumo de materiales toma los registros confirmados de los galpones principal y secundario. El cambio de avance y el consumo se confirman dentro de la misma escritura operativa. Los informes excluyen avances pendientes o en conflicto del progreso oficial. En porcentaje se usa el último registro confirmado por fecha. Los partes se registran por identificador de actividad. Los partes históricos que solo tienen un código repetido se conservan en la base y quedan fuera del cálculo automático hasta que su vínculo sea verificable.

## Importación y exportación

- Catálogo, Materiales y Personal ofrecen plantillas XLSX. Revisar las filas aceptadas, rechazadas y duplicadas antes de confirmar. El límite es 2 MB y 1000 filas de datos por lote. Catálogo y Materiales procesan las escrituras grandes en tramos. El lector de hojas de cálculo está fijado a SheetJS CE 0.20.3. [Distribución oficial](https://docs.sheetjs.com/docs/getting-started/installation/bun/).
- Catálogo permite duplicar una plantilla con sus actividades y exportar el catálogo de la plantilla en XLSX. La importación admite `Duración (días)`. Las planillas anteriores que omiten la columna conservan el valor predeterminado de cinco días.
- La importación de Personal conserva un único lote en el Centro de Sincronización, incluso sin conexión. El servidor valida los campos y los códigos de toda la planilla antes de confirmar las altas y sus movimientos. Las altas individuales conservan sus permisos habituales.
- «Retirar del plan» excluye la actividad del Gantt del galpón tras confirmarse en el servidor. Si el sector cambió, el Centro de Sincronización permite revisar y reenviar el retiro conservando su UUID. Gestión de Actividades, Avance, Dashboard e Informes conservan la actividad y su historial.
- La baja de un sector o galpón requiere una operación separada. Si hay registros operativos vinculados, el servidor rechaza la baja y conserva la ubicación y sus datos. La bitácora conserva la referencia de las ubicaciones retiradas.
- Gantt exporta XLSX con los filtros vigentes y el permiso de exportación del módulo. Informes exporta el avance y un CSV separado con asistencia, personal e inventario por galpón.
- Movimientos permite al Administrador importar hasta 100 entradas y 2 MB por archivo CSV o XLSX. Columnas requeridas `Fecha y Hora`, `Módulo`, `Tipo de Movimiento` y `Detalle del Movimiento`. `ID` y `Usuario` son opcionales. Usar las etiquetas de los módulos y los tipos `REGISTRO`, `MODIFICACIÓN` o `ELIMINACIÓN`. Se aceptan fecha y hora ISO o fecha local de Lima con segundos. Si falta el ID, se deriva uno estable del contenido. El usuario de origen es información histórica y el servidor registra por separado al administrador autenticado que hizo la importación. El mismo ID con datos distintos devuelve conflicto.

## Firebase administrado y Cloud Run

La configuración versionada identifica el proyecto `phonic-tree-clcf1` y la base nombrada `ai-studio-controlgalponesl-58fc2d34-fb60-4c1b-ac12-3af5a15f1e71`. Para preparar una validación futura, con autorización separada:

1. Confirmar el proyecto y base en la consola, los proveedores de Auth, dominios autorizados y la correspondencia de UID, perfil y proveedor del administrador principal. Validar primero con cuentas y datos sintéticos en un entorno administrado aislado que el responsable ya tenga autorizado.
2. Asociar una identidad de servicio dedicada a Cloud Run. Validar ADC con esa identidad y los permisos de Firestore e Identity Platform indicados en [security_spec.md](security_spec.md). Verificar el acceso a la base nombrada y las transacciones, índices automáticos, cuotas, lecturas y contención. No colocar archivos de credenciales en la imagen ni Git.
3. Construir con Node.js 24 y sin variables de emulador. Servir con `NODE_ENV=production` y el `PORT` que entrega Cloud Run. Configurar `CALERA_ALLOWED_ORIGINS` como lista de orígenes exactos separados por comas cuando el cliente se sirva en otro origen. Probar la aplicación junto con las reglas de denegación directa, incluyendo clientes de una versión anterior y actualizaciones del worker.
4. Verificar en servicios administrados la revocación real de ID y refresh tokens, el correo de recuperación autónoma, la actualización conjunta de credenciales y marca, las respuestas ambiguas y las operaciones de emergencia. Confirmar el comportamiento de los índices de la base nombrada con el conjunto real de consultas antes de publicar.

## Rendimiento y dimensionamiento

Estimación sobre un escenario sintético de 12 sectores, 240 trabajadores y 10 sesiones conectadas. Son operaciones del código por intento, antes de la facturación de Firestore y sin contar reintentos por contención.

| Flujo | Estimación |
| --- | --- |
| Actualizar un trabajador en un día | La transacción verifica los trabajadores editados. La confirmación registra asistencia, recibo y movimiento. |
| Snapshot que incluye Personal y Asistencia | El cliente agrupa las consultas por colección para evitar pedir Personal dos veces en el mismo snapshot. |
| Diez sesiones con intervalo de 15 segundos | Hasta 40 snapshots por minuto en régimen estable, más las consultas del perfil y las recargas por acción. |
| Recalcular stock | Una pasada por los consumos y una consulta en memoria por material afectado. La transacción todavía lee las colecciones de avances y materiales completas para conservar el cálculo de registros heredados. |

Las tablas paginan o filtran en el cliente donde corresponde. El snapshot operativo sigue entregando las colecciones necesarias para conservar el trabajo offline, incluidos los datos para informes. Medir tamaño de respuesta, tamaño del documento de sector, límites de transacciones y coste de lectura con volúmenes representativos antes de habilitar el servicio administrado.

## PWA y preparación Android

En Chrome o Edge, abrir el build por HTTPS y usar la opción de instalar del navegador. `sw.js` conserva solo recursos de la aplicación. Cada build cambia la versión del caché y retira shells anteriores al activarse. Los datos operativos y la cola se almacenan por separado del caché del worker.

Para empaquetar posteriormente, instalar las herramientas de Android indicadas por Capacitor y agregar `@capacitor/core@8`, `@capacitor/android@8` y `@capacitor/cli@8` en una rama autorizada. Compilar con `VITE_API_BASE_URL=https://<host-autorizado>`, ejecutar `npx cap add android` una vez, luego `npx cap sync android` y `npx cap open android`. La configuración existente apunta a `dist`, utiliza HTTPS y deshabilita contenido mixto. Validar en Android físico la navegación, persistencia, red, teclado y autenticación. Para Google, comprobar el flujo OAuth nativo y la correspondencia con los dominios, certificados y proveedores antes de liberar una APK. [Entorno Android de Capacitor](https://capacitorjs.com/docs/getting-started/environment-setup).

### Aceptación manual en Android físico

1. Con un entorno de prueba autorizado y perfiles sintéticos, instalar la PWA desde el menú del navegador y abrirla desde el icono del sistema. Repetir en móvil y tablet, con orientación vertical y horizontal.
2. Iniciar sesión con correo y contraseña. Probar Google por separado, incluida la cancelación y el retorno a la aplicación. Probar la recuperación de contraseña en una cuenta de prueba.
3. Abrir Avance Diario y Asistencia, desconectar el dispositivo y registrar operaciones. Verificar que el teclado no tape el envío y que las operaciones se vean pendientes. Cerrar la aplicación y abrirla sin red. El shell debe cargar y pedir conexión para verificar la sesión.
4. Reconectar con el mismo UID y comprobar en la API que cada operación se aplicó una vez. Repetir cerrando sesión y usando primero otro UID. Confirmar que ese segundo usuario no ve ni envía las operaciones del primero.
5. Publicar una compilación de prueba solo en el entorno autorizado para verificar actualización del shell y recuperación de la cola. Repetir en la WebView de Capacitor y comprobar OAuth, permisos, persistencia y reconexión antes de generar una APK.

## Integración posterior

Tras la revisión, usar `git status --short` y `git diff --check`. Agregar únicamente los archivos aprobados, revisar `git diff --cached`, hacer el commit en `fixes/audit-phase-1` y publicar esa rama con `git push origin fixes/audit-phase-1` cuando se autorice. Abrir un pull request hacia `main` para la revisión de integración.

En Google AI Studio, usar **Build → Add files (+) → Import from GitHub** y elegir el repositorio y la rama o revisión aprobada si el selector está disponible. En una app ya vinculada, usar la opción de traer cambios en **Settings → GitHub**. Si solo ofrece la rama predeterminada, esperar la integración aprobada en GitHub y luego recuperar esa revisión. Comparar el commit con el de GitHub antes de probar. Mantener las credenciales fuera del código y usar emuladores o un entorno autorizado para cualquier prueba de backend. [Integración de GitHub en Google AI Studio](https://ai.google.dev/gemini-api/docs/aistudio-build-mode?authuser=467).
