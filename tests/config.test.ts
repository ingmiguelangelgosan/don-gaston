import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { loadConfig } from '../src/app/config.ts';

test('configuración local por defecto y explícita', () => {
  assert.deepEqual(loadConfig({}), {
    mode: 'local',
    dataMode: 'synthetic',
    currency: 'COP',
  });
  assert.deepEqual(
    loadConfig({
      NODE_ENV: 'test',
      APP_MODE: 'local',
      DATA_MODE: 'synthetic',
      CURRENCY_DEFAULT: 'COP',
      AI_ENABLED: 'false',
      JARVIS_INTEGRATION_ENABLED: 'false',
    }),
    loadConfig({}),
  );
});
test('rechaza configuración operativa o ambigua sin exponer valores', () => {
  for (const key of [
    'NODE_ENV',
    'APP_MODE',
    'DATA_MODE',
    'CURRENCY_DEFAULT',
    'AI_ENABLED',
    'JARVIS_INTEGRATION_ENABLED',
    'DATABASE_URL',
    'JARVIS_SERVICE_TOKEN',
    'STORAGE_PRIVATE_BUCKET',
  ]) {
    for (const value of ['', 'synthetic-sensitive-marker']) {
      assert.throws(
        () => loadConfig({ [key]: value }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(key));
          assert.ok(!error.message.includes('synthetic-sensitive-marker'));
          return true;
        },
      );
    }
  }
});
test('arranque real del proceso y fallo sanitizado', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['src/app/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
  const success = run({ APP_MODE: 'local' });
  assert.ifError(success.error);
  assert.equal(success.status, 0);
  assert.match(success.stdout, /Fase 0 local/);
  const failure = run({ DATA_MODE: 'synthetic-sensitive-marker' });
  assert.ifError(failure.error);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /Configuración inválida/);
  assert.ok(!failure.stderr.includes('synthetic-sensitive-marker'));
});
