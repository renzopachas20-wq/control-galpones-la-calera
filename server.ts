import express from 'express';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { registerFirebaseAuthRoutes } from './server/firebaseAdmin.ts';
import { apiCors } from './server/cors.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuración de Firebase y Constantes Oficiales
// ============================================================================

const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const localProject = process.env.CALERA_DEMO_PROJECT;
if (localProject && (!/^demo-[a-z0-9-]+$/.test(localProject) || !process.env.FIRESTORE_EMULATOR_HOST ||
    !process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.K_SERVICE)) {
  throw new Error('El proyecto demo requiere ambos emuladores locales.');
}
const PROJECT_ID: string = localProject ?? firebaseConfig.projectId;
const DATABASE_ID: string = firebaseConfig.firestoreDatabaseId;

async function startServer() {
  const app = express();

  const cloudRun = Boolean(process.env.K_SERVICE);
  app.use('/api', apiCors(process.env.CALERA_ALLOWED_ORIGINS, cloudRun, !cloudRun && process.env.NODE_ENV !== 'production'));

  app.use(express.json({ limit: '5mb' }));

  registerFirebaseAuthRoutes(app, PROJECT_ID, DATABASE_ID);

  // --------------------------------------------------------------------------
  // Sistema Automático de Metadatos de Versión y Despliegue (/api/version)
  // --------------------------------------------------------------------------
  function resolveRuntimeVersionMetadata(req: express.Request) {
    let baseMeta: Record<string, any> = {};
    const distMetaPath = path.resolve(__dirname, 'dist/version-metadata.json');
    const genMetaPath = path.resolve(__dirname, 'src/generated/versionMetadata.json');

    if (fs.existsSync(distMetaPath)) {
      try {
        baseMeta = JSON.parse(fs.readFileSync(distMetaPath, 'utf-8'));
      } catch {
        // ignore
      }
    } else if (fs.existsSync(genMetaPath)) {
      try {
        baseMeta = JSON.parse(fs.readFileSync(genMetaPath, 'utf-8'));
      } catch {
        // ignore
      }
    }

    let pkgVersion = baseMeta.version || '3.0.0';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
      if (pkg.version) pkgVersion = String(pkg.version);
    } catch {
      // ignore
    }

    let liveCommit = baseMeta.commitHash || 'unknown';
    try {
      const gitOut = execSync('git rev-parse --short HEAD', {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .toString()
        .trim();
      if (gitOut) liveCommit = gitOut;
    } catch {
      // en contenedor de producción sin carpeta .git usa el commit empaquetado en dist/version-metadata.json
    }

    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || req.hostname || '').toLowerCase();
    const isDevHost =
      hostHeader.includes('ais-dev-') ||
      hostHeader.includes('localhost') ||
      hostHeader.includes('127.0.0.1');
    const isPublicProdHost =
      hostHeader.includes('ais-pre-') ||
      hostHeader.includes('ais-mob-') ||
      (!isDevHost && (process.env.NODE_ENV === 'production' || Boolean(process.env.K_SERVICE)));

    const distIndexExists = fs.existsSync(path.resolve(__dirname, 'dist/index.html'));
    const bundleVerified = Boolean(baseMeta.bundleCompleted && distIndexExists);

    const timeZone = 'America/Lima';
    const refIso = baseMeta.buildTimestampIso || new Date().toISOString();
    const refDate = new Date(refIso);

    const formattedDate =
      baseMeta.formattedDate ||
      new Intl.DateTimeFormat('es-PE', {
        timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }).format(refDate);

    const formattedTime =
      baseMeta.formattedTime ||
      new Intl.DateTimeFormat('es-PE', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }).format(refDate);

    const environmentLabel = isPublicProdHost ? 'PRODUCCIÓN' : 'DESARROLLO';
    const statusLabel = isPublicProdHost
      ? bundleVerified
        ? 'Publicado correctamente.'
        : 'Compilación pendiente de verificación.'
      : 'Entorno de desarrollo activo (AI Studio Preview).';

    return {
      version: pkgVersion,
      commitHash: liveCommit,
      buildTimestampIso: refIso,
      formattedDate,
      formattedTime,
      timeZone: 'America/Lima (UTC-5)',
      environment: environmentLabel,
      status: statusLabel,
      isProduction: isPublicProdHost,
      bundleVerified
    };
  }

  app.get('/api/version', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json(resolveRuntimeVersionMetadata(req));
  });

  // --------------------------------------------------------------------------
  // Healthcheck de Producción (Cloud Run / Verificación de Estado)
  // --------------------------------------------------------------------------
  app.get('/api/health', (req, res) => {
    const versionMeta = resolveRuntimeVersionMetadata(req);
    res.json({
      status: 'ok',
      service: 'control-galpones-la-calera',
      version: versionMeta.version,
      commitHash: versionMeta.commitHash,
      environmentLabel: versionMeta.environment,
      projectId: PROJECT_ID,
      firestoreDatabaseId: DATABASE_ID,
      authDomain: firebaseConfig.authDomain,
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });
  });

  // --------------------------------------------------------------------------
  // Vite Middleware (Desarrollo) o Archivos Estáticos (Producción)
  // --------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath, { setHeaders: (res, file) => {
      if (path.basename(file) === 'sw.js') res.setHeader('Cache-Control', 'no-cache');
    } }));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Control Galpones La Calera ejecutándose en http://0.0.0.0:${PORT}`);
  });
}

startServer();
