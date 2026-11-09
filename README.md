# Don Gastón — agente financiero independiente

**Estado: Fase 0 local implementada y verificada el 2026-11-08.** Solo bootstrap y ejemplos sintéticos. Fase 1 pendiente. No existe DB, API ni conexión con Sir Jarvis. El workspace recibido era un kit documental y no está inicializado como repositorio Git; no se crearon commits ni PR.

Don Gastón será propietario de las reglas financieras; Sir Jarvis conserva canales, identidad conversacional, orquestación y confirmaciones. Las reglas de producto siguen siendo requisitos, no funcionalidades construidas. La referencia histórica se conserva sin cambios.

## Ejecutar localmente

Entorno probado: Windows/PowerShell, Node **24.19.0**, npm **11.17.0**. Se admite Node 24 desde 24.19.0; no se actualizó el runtime del equipo. Node 24 es una [línea LTS](https://github.com/nodejs/Release), no se afirma que el patch instalado sea el último disponible.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd start
```

En otras shells puede usarse `npm` en lugar de `npm.cmd`. La instalación descarga herramientas de desarrollo desde npm; arranque y pruebas no usan servicios externos. `.npmrc` desactiva scripts de instalación y usa caché local ignorada. No hay dependencias de ejecución, hooks de instalación propios ni servicios.

`.env` es opcional: los valores por defecto son locales y sintéticos. Para personalizar la configuración permitida se puede copiar `.env.example` a `.env`; no introducir secretos. El proceso valida configuración, imprime un mensaje estático y termina, sin escuchar puertos. `npm start` requiere el build generado por `npm run check` o `npm run build`.

Configuración admitida: `NODE_ENV=development|test`, `APP_MODE=local`, `DATA_MODE=synthetic`, `CURRENCY_DEFAULT=COP`, `AI_ENABLED=false`, `JARVIS_INTEGRATION_ENABLED=false`. Variables ausentes usan defaults; valores vacíos o distintos fallan. Las variables de DB, bucket y token Jarvis heredadas del kit se rechazan incluso vacías. Otras variables del sistema se ignoran, no se registran ni habilitan capacidades.

## Estructura implementada y responsables

| Ruta | Contenido / propietario |
|---|---|
| `src/app/config.ts`, `src/app/main.ts` | Validación y composición local / coordinador |
| `tests/*.test.ts`, `tests/fixtures/` | Configuración, proceso y ejemplo financiero sintético / coordinador |
| `package.json`, `package-lock.json`, `tsconfig*.json` | Scripts, versiones exactas y TypeScript estricto / coordinador |
| `eslint.config.js`, `.prettierrc.json`, `.npmrc`, `.env.example`, `.gitignore` | Herramientas y configuración segura / coordinador |
| `.github/workflows/local-checks.yml` | CI preparado, sin despliegue / coordinador |
| `docs/adr/` | Persistencia y contrato pendientes / coordinador |
| `docs/reviews/FINANCE_DOMAIN_REVIEW.md` | Invariantes y trazabilidad / finance_domain |
| `docs/reviews/TEST_MATRIX.md` | Matriz sintética y casos futuros / test_engineer |
| `docs/reviews/SECURITY_REVIEW.md` | Informe del revisor de solo lectura, documentado por coordinador |

Los tres especialistas se ejecutaron en paralelo, sin propiedad compartida de archivos. El rol de seguridad declara sandbox de solo lectura; su aplicación efectiva por el runtime no fue verificada. No se modificó la configuración de agentes.

No se crearon carpetas vacías para capas futuras. Dominio, aplicación, infraestructura e interfaces se incorporarán cuando tengan comportamiento aprobado.

## Evidencia ejecutada

Scripts revisados antes de ejecución. Todos los comandos siguientes terminaron con código 0:

| Comando | Resultado |
|---|---|
| `npm.cmd install --ignore-scripts` | 98 paquetes de desarrollo instalados; lockfile generado |
| `npm.cmd run format` | Formato aplicado solo a código/configuración del bootstrap |
| `npm.cmd ci --ignore-scripts` | Reinstalación reproducible desde lockfile: 98 paquetes |
| `npm.cmd run check` | Formato, lint sin warnings, typecheck, 4 tests aprobados y build |
| `npm.cmd start` | Arranque del JavaScript compilado, mensaje local sintético, salida 0 |

`check` se ejecutó tanto tras instalar como tras reinstalar desde lockfile. CI remoto y ejecución en Linux **no verificados**. No se ejecutó auditoría de vulnerabilidades de dependencias; la revisión del lockfile no sustituye esa auditoría.

Test individual reproducible:

```powershell
node --test tests/domain-example.test.ts
```

Los cuatro tests cubren defaults/configuración explícita, rechazo de valores inválidos sin exponerlos, proceso real con salida exitosa/fallida y un ejemplo de suscripción compartida. Este último usa `bigint` por encima del límite exacto de `number`, unidades menores de COP (centavos) y división exacta: caja total = consumo propio + cuenta por cobrar, vinculados al mismo identificador sintético. No demuestra deduplicación transaccional ni implementa un ledger. No hay redondeo en este ejemplo; la política de residuos y redondeo del dominio sigue pendiente.

Versiones consultadas en npm antes de fijarlas: TypeScript 6.0.3, ESLint 10.14.0, typescript-eslint 8.72.1, Prettier 3.9.10 y @types/node 24.19.2. TypeScript 7.0.2 estaba publicado, pero fuera del rango soportado por typescript-eslint (<6.1.0); se eligió la versión compatible. La primera consulta falló por permisos de la caché global y se resolvió usando `.cache/npm`, sin elevar permisos.

## Pendientes y siguiente fase

- [ADR-001](docs/adr/001-persistence.md): comparar almacenamiento aislado, transacciones y recuperación antes de elegir DB/migraciones.
- [ADR-002](docs/adr/002-jarvis-contract.md): cotejo contractual y aprobación futura; el borrador no garantiza compatibilidad.
- Decidir redondeo/residuos, proyección presupuestaria y calendario antes de los módulos correspondientes. Precisiones de la referencia histórica están documentadas en el informe de dominio, sin resolverlas por suposición.
- Fase 1 requiere un incremento separado y autorizado: dominio puro y libro simulado, con pruebas propias. No se inicia automáticamente.
- Idempotencia durable, autorización, recibos privados, respaldo/restauración, datos reales y despliegue siguen pendientes. Los tests de Fase 0 no certifican esos controles.
- CI usa tags de acciones y la línea Node 24: posible deriva de versiones; no fue ejecutado remotamente. `.gitignore` no es un control de acceso ni garantiza ausencia de secretos.

## Fuentes de verdad

[Reglas](docs/PRODUCT_RULES.md) · [Referencia histórica](docs/REFERENCIA_FUNCIONAL_JARVIS_2026-11-01.md) · [Arquitectura](docs/ARCHITECTURE.md) · [Seguridad](docs/SECURITY.md) · [Roadmap](docs/ROADMAP.md) · [Workflow](docs/CODEX_WORKFLOW.md).

Licencia pendiente. No es un producto oficial relacionado con Los Simpson ni usa marcas gráficas ajenas.
