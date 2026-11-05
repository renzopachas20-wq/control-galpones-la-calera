# Especificación de Seguridad (Phase 0: Payload-First Security TDD) – Fase 4.2

## 1. Invariantes de Datos (`users/{userId}`)

1. **Bloqueo Global por Defecto (Zero-Trust)**: Toda colección fuera de `/users/{userId}` permanece bloqueada (`allow read, write: if false;`) durante la Fase 4.2.
2. **Prohibición de Registro Público y Auto-Asignación de Rol**: Ningún usuario puede crear su propio documento en `/users/{userId}` (salvo el bootstrap inicial del Administrador raíz verificado `renzopachas20@gmail.com` con `email_verified == true`). Únicamente un `Administrador` activo (`role == 'Administrador' && active == true`) puede crear perfiles de usuario.
3. **Seis Roles Oficiales Estrictos**: El campo `role` solo admite exactamente uno de los 6 valores:
   - `'Administrador'`
   - `'Jefe de proyecto'`
   - `'Supervisor'`
   - `'Auxiliar'`
   - `'Almacén'`
   - `'Solo lectura'`
4. **Inmutabilidad y Protección contra Elevación de Privilegios**:
   - Un usuario no administrador jamás puede modificar `role`, `active`, `assignedSectorIds`, `assignedGalponIds`, `email`, `uid`, `createdAt` ni `createdBy`.
   - Un usuario autenticado y activo (`existing().active == true`) únicamente puede actualizar su marca `lastLoginAt` (`updatedAt`, `updatedBy`).
5. **Bloqueo Inmediato de Usuarios Desactivados (`active == false`)**:
   - Si `active == false`, el usuario no puede actualizar ni siquiera su propio `lastLoginAt` ni listar o modificar ningún recurso.
6. **Prohibición de Almacenar Contraseñas en Firestore**:
   - El esquema `isValidUserProfile()` aplica `data.keys().hasAll(...)` y `data.keys().hasOnly(...)` sobre los 12 campos permitidos, rechazando cualquier campo `password`, `tempPassword` o campos fantasma (*Shadow Fields*).
7. **Aislamiento de PII**:
   - `allow get` en `/users/{userId}` está restringido exclusivamente al propio titular (`request.auth.uid == userId`) o a un `Administrador` activo (`isActiveAdmin()`). Ningún otro usuario puede leer perfiles ajenos.

---

## 2. "Dirty Dozen" Payloads (12 vectores de ataque que deben devolver `PERMISSION_DENIED`)

1. **Auto-registro público (`create` por usuario no autorizado)**: Usuario autenticado `uid_intruso` intenta crear `/users/uid_intruso` con `role: 'Auxiliar'`. → `PERMISSION_DENIED`.
2. **Auto-elevación de rol (`update` de `role`)**: Usuario `Supervisor` activo intenta cambiar su propio `role` a `'Administrador'`. → `PERMISSION_DENIED`.
3. **Auto-reactivación de cuenta desactivada (`update` de `active`)**: Usuario con `active: false` intenta enviar `active: true`. → `PERMISSION_DENIED`.
4. **Inyección de rol inexistente (`role: 'SuperAdmin'`)**: Administrador intenta crear usuario con `role: 'SuperAdmin'` fuera de los 6 roles oficiales. → `PERMISSION_DENIED`.
5. **Almacenamiento de contraseña en Firestore (*Shadow Field* `password`)**: Administrador intenta crear `/users/uid_1` incluyendo un campo `password: '123456'`. → `PERMISSION_DENIED` por `hasOnly()`.
6. **Spoofing de correo de administrador sin verificación (`email_verified: false`)**: Token con `email: 'renzopachas20@gmail.com'` pero `email_verified: false` intenta hacer bootstrap de `/users/{uid}`. → `PERMISSION_DENIED`.
7. **Lectura de perfil ajeno (PII Leak)**: Usuario `uid_auxiliar` intenta hacer `get` sobre `/users/uid_jefe`. → `PERMISSION_DENIED`.
8. **Listado masivo de usuarios por no-administrador (`list`)**: Usuario `Jefe de proyecto` intenta ejecutar `list` sobre `/users`. → `PERMISSION_DENIED`.
9. **Envenenamiento de ID (`ID Poisoning`)**: Intento de crear documento con ID de 500 caracteres o caracteres especiales inválidos. → `PERMISSION_DENIED` por `isValidId()`.
10. **Envenenamiento de valor (`Value Poisoning`)**: Intento de enviar `displayName` de 10,000 caracteres o `assignedSectorIds` con 1,000 elementos. → `PERMISSION_DENIED` por límites `.size()`.
11. **Modificación de campos inmortales (`uid`, `createdAt`, `createdBy`)**: Administrador intenta modificar `createdAt` o `createdBy` en un `update`. → `PERMISSION_DENIED`.
12. **Eliminación física de perfil (`delete`)**: Cualquier usuario (incluso Administrador) intenta ejecutar `delete` sobre `/users/{userId}` en lugar de desactivar (`active: false`). → `PERMISSION_DENIED`.
