import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function computeBuildMetadata(isProductionBundleComplete: boolean) {
  let version = '3.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
    if (pkg.version) version = String(pkg.version);
  } catch {
    // fallback to 3.0.0
  }

  let commitHash = 'unknown';
  let commitDateIso = new Date().toISOString();
  try {
    commitHash = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    commitDateIso = execSync('git log -1 --format=%cI', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // fallback if git is unavailable
  }

  const now = new Date();
  const timeZone = 'America/Lima';

  const formattedDate = new Intl.DateTimeFormat('es-PE', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(now);

  const formattedTime = new Intl.DateTimeFormat('es-PE', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(now);

  return {
    version,
    commitHash,
    commitDateIso,
    buildTimestampIso: now.toISOString(),
    formattedDate,
    formattedTime,
    timeZone: 'America/Lima (UTC-5)',
    bundleCompleted: isProductionBundleComplete
  };
}

function versionMetadataPlugin(): Plugin {
  return {
    name: 'calera-version-metadata',
    buildStart() {
      const meta = computeBuildMetadata(false);
      const genDir = path.resolve(__dirname, 'src/generated');
      if (!fs.existsSync(genDir)) {
        fs.mkdirSync(genDir, { recursive: true });
      }
      fs.writeFileSync(
        path.resolve(genDir, 'versionMetadata.json'),
        JSON.stringify(meta, null, 2),
        'utf-8'
      );
    },
    closeBundle() {
      // Se ejecuta únicamente cuando la compilación de Vite finalizó con éxito total
      const meta = computeBuildMetadata(true);
      const genDir = path.resolve(__dirname, 'src/generated');
      if (!fs.existsSync(genDir)) {
        fs.mkdirSync(genDir, { recursive: true });
      }
      fs.writeFileSync(
        path.resolve(genDir, 'versionMetadata.json'),
        JSON.stringify(meta, null, 2),
        'utf-8'
      );

      const distDir = path.resolve(__dirname, 'dist');
      if (fs.existsSync(distDir)) {
        fs.writeFileSync(
          path.resolve(distDir, 'version-metadata.json'),
          JSON.stringify(meta, null, 2),
          'utf-8'
        );
      }
    }
  };
}

export default defineConfig({
  plugins: [versionMetadataPlugin(), react()],
});
