# Especificación de Seguridad (Zero Trust & Matriz de 6 Roles) – Fases 4.2 a 4.7

## 1. Invariantes de Datos y Modelo de Acceso

1. **Bloqueo Global por Defecto (Zero-Trust)**:
   - Toda ruta no declarada explícitamente en `firestore.rules` está bloqueada (`allow read, write: if false;`).
   - Todas las operaciones en las 9 colecciones operativas (`/users`, `/providers`, `/masterCatalog`, `/sectors`, `/materials`, `/advances`, `/workers`, `/attendance`, `/movements`) exigen un usuario autenticado cuyo perfil `/users/$(request.auth.uid)` exista y tenga `active == true`.
2. **Prohibición de Registro Público y Auto-Asignación de Rol**:
   - Ni el inicio de sesión con correo/contraseña ni el botón **"Continuar con Google"** permiten el registro libre de usuarios desconocidos.
   - Si un usuario se autentica con Google pero no posee un perfil activo pre-autorizado por el Administrador en `/users`, el backend (`POST /api/auth/verify-session`) y el cliente rechazan el acceso (`403 PROFILE_NOT_FOUND`) y cierran la sesión de inmediato.
3. **Seis Roles Oficiales Estrictos**:
   - `'Administrador'`
   - `'Jefe de proyecto'`
   - `'Supervisor'`
   - `'Auxiliar'`
   - `'Almacén'`
   - `'Solo lectura'`
4. **Preservación de UID al Cambiar Correo Electrónico**:
   - Cuando el Administrador actualiza el correo electrónico de un usuario (`PATCH /api/admin/users/:uid`), el `uid` del documento `/users/{uid}` se conserva intacto, preservando todas las relaciones históricas con avances diarios, asistencia, materiales, personal y bitácora de auditoría.
5. **Prohibición de Almacenar Contraseñas en Firestore**:
   - `isValidUserProfile()` valida estrictamente las llaves permitidas con `hasAll()` y `hasOnly()`, impidiendo almacenar `password`, `tempPassword` o cualquier credencial en Firestore.
6. **Inmutabilidad del Historial de Movimientos (`/movements/{movementId}`)**:
   - Todo registro creado en `/movements/{movementId}` exige que `request.resource.data.userId == request.auth.uid` y que el tipo sea `'REGISTRO'`, `'MODIFICACIÓN'` o `'ELIMINACIÓN'`.
   - `allow update, delete: if false;` garantiza que ningún usuario pueda alterar ni borrar la trazabilidad histórica.
7. **Separación de `allow get` y `allow list` en `/users` y uso de `:runQuery` en Firestore Enterprise Edition**:
   - **Causa diagnosticada**:
     1. En `server.ts`, `listAllProfilesFromFirestore` invocaba `GET /v1/projects/.../databases/.../documents/users?pageSize=300` (método REST `documents.list`), el cual en Firestore Enterprise Edition (`ai-studio-controlgalponesl-58fc2d34-fb60-4c1b-ac12-3af5a15f1e71`) incluye enumeración de documentos huérfanos/inexistentes y es rechazado con `403 PERMISSION_DENIED` para tokens de usuario, mientras que el endpoint oficial de consulta `POST /v1/projects/.../databases/.../documents:runQuery` (`structuredQuery`) evalúa correctamente las reglas de colección.
     2. En `firestore.rules`, `match /users/{userId}` combinaba `allow read: if isOwner(userId) || isAdmin();` sin separar `allow get` de `allow list: if isAdmin();`.
   - **Cambio aplicado**:
     - En `firestore.rules`, `/users/{userId}` separa `allow get: if isOwner(userId) || isAdmin();` y `allow list: if isAdmin();` (incluyendo `isPrimaryAdmin() || hasRole(['Administrador'])`). Los usuarios no administradores tienen estrictamente prohibido hacer `list` sobre `/users` o `get` sobre perfiles de otros usuarios.
     - En `server.ts`, `listAllProfilesFromFirestore` utiliza `POST ${FIRESTORE_BASE_URL}:runQuery` con `structuredQuery: { from: [{ collectionId: 'users' }], limit: 300 }`.
     - Todas las colecciones operativas (`/providers`, `/masterCatalog`, `/sectors`, `/materials`, `/advances`, `/workers`, `/attendance`, `/movements`) mantienen su restricción `isActiveUser()` y validación estricta por rol.


