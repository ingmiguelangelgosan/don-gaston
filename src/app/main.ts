import { loadConfig } from './config.ts';
try {
  loadConfig(process.env);
  console.log(
    'Don Gastón: Fase 0 local, configuración válida, datos sintéticos.',
  );
} catch {
  console.error(
    'Configuración inválida. Revise .env.example; Fase 0 solo admite modo local sintético.',
  );
  process.exitCode = 1;
}
