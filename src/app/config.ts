export interface LocalConfig {
  readonly mode: 'local';
  readonly dataMode: 'synthetic';
  readonly currency: 'COP';
}
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): LocalConfig {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    NODE_ENV: ['development', 'test'],
    APP_MODE: ['local'],
    DATA_MODE: ['synthetic'],
    CURRENCY_DEFAULT: ['COP'],
    AI_ENABLED: ['false'],
    JARVIS_INTEGRATION_ENABLED: ['false'],
  };
  for (const [key, values] of Object.entries(allowed)) {
    const value = env[key];
    if (value !== undefined && !values.includes(value)) {
      throw new Error(`Configuración local inválida: ${key}`);
    }
  }
  for (const key of [
    'DATABASE_URL',
    'JARVIS_SERVICE_TOKEN',
    'STORAGE_PRIVATE_BUCKET',
  ]) {
    if (env[key] !== undefined)
      throw new Error(`Variable fuera de alcance: ${key}`);
  }
  return Object.freeze({
    mode: 'local',
    dataMode: 'synthetic',
    currency: 'COP',
  });
}
