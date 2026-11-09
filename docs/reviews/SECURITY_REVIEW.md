# Revisión de seguridad — Fase 0

Fecha: 2026-11-08. Revisor: subagente `security_reviewer`; documentación del
informe: coordinador. Dos inspecciones estáticas: kit inicial y bootstrap final.
El revisor no ejecutó scripts npm, tests, escrituras ni accesos a secretos,
infraestructura o repositorios vecinos.

## Resultado y evidencia

No se identificaron bloqueantes para el bootstrap local sintético. Esto no es
una certificación de producción. Fuentes: arquitectura, seguridad, protocolo
borrador, trazabilidad, configuración del rol, src/app, tests, configuración de
herramientas, lockfile, ejemplo de entorno y CI.

- Configuración admite modo local/sintético y COP; banderas IA/Jarvis desactivadas.
  Rechaza variables de DB, token Jarvis y almacenamiento. Variables ajenas del
  entorno no activan funcionalidades; no son un mecanismo de aislamiento del SO.
- Mensajes del arranque estáticos; errores no imprimen valores ni entorno.
- Código inspeccionado sin endpoints, llamadas de red, persistencia financiera
  o integración externa. Fixtures sintéticas con bigint, caja y consumo separados.
- Se corrigió el riesgo bajo del kit inicial: `.env.example` ya no sugiere
  conexiones DB/token que no existen; contiene solo configuración aceptada.
- `.gitignore` protege entornos, claves, bases, recibos, backups, logs y artefactos;
  no sustituye controles de acceso ni revisión de archivos antes de versionar.
- `.npmrc` desactiva scripts de instalación, fija versiones y exige motor compatible.
- Lockfile: 99 entradas; 0 URLs resolved fuera de registry.npmjs.org;
  0 paquetes con hasInstallScript; 0 entradas resueltas sin integridad.
  Esta inspección no es una auditoría del código ni de vulnerabilidades de paquetes.
- CI: `contents: read`, checkout sin persistencia de credenciales y
  `npm ci --ignore-scripts`; sin despliegue.

## Puertas futuras

| Estado | Riesgo / control faltante | Criterio de cierre |
|---|---|---|
| Ausencia confirmada, bloqueante para operación futura | Autenticación y autorización | Vínculo actor/sujeto/instancia fuera del payload; permisos por acción; tests negativos y revocación |
| Ausencia confirmada, bloqueante para mutaciones futuras | Idempotencia durable | Intención estable, huella, unicidad transaccional, duplicados concurrentes, conflicto y recuperación tras respuesta perdida |
| Pendiente antes de datos reales | Recibos, backup y privacidad IA | Acceso privado por sujeto, consentimiento de borrado, restauración demostrada, aprobación de proveedor y costo |
| No verificado | Aislamiento de red y sandbox efectivo | Verificar enforcement cuando el alcance lo requiera; no presentar configuración como certificación |

## Riesgos residuales de Fase 0

- Bajo: acciones CI `@v4` y Node `'24'` pueden variar. Considerar SHA y runtime
  concreto antes de usar CI como evidencia estable.
- No verificados: CI remoto/Linux, vulnerabilidades publicadas en dependencias,
  enforcement del sandbox del revisor. La configuración del rol declara
  `sandbox_mode = "read-only"`; todas sus operaciones fueron de lectura.
  No se intentó escribir para comprobar permisos.
- La configuración de aplicación no impide por sí misma acceso del proceso
  a red o archivos. No existe evidencia de aislamiento de egreso.
- Ejemplos aritméticos no prueban ledger, autorización ni atomicidad durable.

## Evidencia del coordinador

Después de revisar scripts, el coordinador ejecutó instalación y reinstalación
desde lockfile con scripts desactivados, formato, lint, typecheck, 4 tests, build
y arranque: todos exitosos. Test individual de dominio: 1 aprobado.
Detalle reproducible en README. El revisor no se atribuye esas ejecuciones.
Fase 1 e integración Jarvis permanecen pendientes.
