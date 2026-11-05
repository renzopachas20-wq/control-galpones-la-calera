# Control de Galpones - La Calera

Proyecto web React + TypeScript preparado a partir del archivo TSX exportado desde Gemini Canvas.

## Requisitos

- Node.js LTS instalado en Windows 11.
- npm (incluido con Node.js).

## Ejecutar en desarrollo

1. Extrae la carpeta del proyecto.
2. Abre una terminal dentro de esta carpeta.
3. Ejecuta:

   ```bash
   npm install
   npm run dev
   ```

4. Abre la dirección local que indique Vite, normalmente `http://localhost:5173`.

## Generar compilación web

```bash
npm run build
```

La salida se crea en `dist/`.

## Estado conocido de esta versión

- Se conserva el componente TSX original como `src/App.tsx`.
- Los estilos se procesan con Tailwind CSS.
- Los iconos se proporcionan con `lucide-react`.
- La persistencia actual del código es `localStorage` del navegador.
- Firebase todavía no está configurado.
- La carga masiva actual acepta filas pegadas como CSV/texto delimitado; no procesa directamente archivos `.xlsx`.

Esta estructura de ejecución no implica que la aplicación ya haya sido probada en el PC del usuario. Primero se debe instalar dependencias y comprobar `npm run dev` y `npm run build` localmente.
