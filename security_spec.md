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
