# Revisión del primer incremento y preparación de persistencia

Fecha: 2026-11-08. Alcance: revisar lo implementado y preparar una propuesta concreta
para ADR-001. No se adopta base de datos ni se amplía el dominio financiero.

## Conclusión

No se encontraron defectos reproducibles que bloqueen el incremento local de gastos.
La implementación coincide con su informe: dinero COP exacto, categorías explícitas,
gastos simples, reintentos/conflictos, consulta por intención, totales y política local
de autorización. Esta revisión no certifica uso real ni completa toda la Fase 1.

La recomendación preparada es SQLite aislado para el siguiente incremento sintético,
sujeta a aprobación. La comparación y sus fuentes oficiales están en
[ADR-001](../adr/001-persistence.md). PostgreSQL sigue siendo alternativa si cambian
los requisitos de concurrencia/operación; Supabase añade decisiones externas pendientes.

## Hallazgos y condiciones

| Observación | Evidencia / consecuencia |
|---|---|
| El rango actual supera enteros SQL de 64 bits | Comprobación sintética adicional de `9223372036854775808n` y total mensual sobre signed64, salida 0. No limitar ese rango silenciosamente al persistir |
| Los totales pueden exceder el rango de cada fila | Deben mantenerse exactos aunque todos los importes individuales quepan en signed64; proponer texto y suma `bigint` para SQLite |
| El resultado actual conserva objetos inmutables `Money` | El adaptador futuro debe validar y rehidratar desde texto; JSON plano no conserva métodos ni invariantes |
| Huella y resultado se guardan junto al hecho solo en memoria | Una DB exige transacción y unicidad real; conservar normalización `category:v1`/`expense:v1`, ID y actor original |
| El puerto es síncrono | Un driver asíncrono requiere cambios explícitos de contrato/casos de uso y esperar el commit |
| La autorización usa política y contexto inyectados | Sirve para probar permisos, pero no autentica la procedencia del contexto en operación real |
| El informe consulta los gastos del ámbito en memoria | Correcto para el alcance pequeño; índices/consultas por mes y categoría se evaluarán con persistencia y mediciones, sin sumar texto mediante coerción SQL |

Los puntos anteriores son límites o requisitos de evolución, no vulnerabilidades
reproducidas en el uso sintético actual. No se modificaron reglas de negocio para
resolverlos. Rango monetario, seguridad operativa y decisiones de almacenamiento
no se consideran aprobados por esta revisión.

## Evidencia ejecutada en esta revisión

- Coordinador: `npm.cmd run check`, salida 0: formato, lint, tipos, **26/26 pruebas**
  y compilación. Se ejecutó nuevamente sobre el estado actual, no se reutilizó solo
  la evidencia del informe anterior.
- Coordinador: `npm.cmd run example:expense`, salida 0: `sameFactOnRetry: true`,
  consulta de intención y total `4500000` centavos COP.
- `finance_domain`: revisión independiente de dominio/aplicación/adaptador/tests y
  comprobación efímera con fixtures, salida 0: importe y total mayores que signed64,
  serialización exacta y replay sin doble conteo. Sin editar archivos.

No se probaron motores, drivers, transacciones de DB, concurrencia entre procesos,
restauraciones o RPO/RTO. Se consultó documentación pública oficial, sin enviar
datos financieros ni conectar servicios. No se ejecutaron despliegues, instalaciones,
migraciones, cambios de infraestructura, commits o PR.

## Cambios y siguiente paso

Coordinador, propiedad exclusiva: actualización de `docs/adr/001-persistence.md` y
creación de este informe. Los cambios de implementación existentes en el workspace
se conservaron; no hay modificaciones adicionales a código, tests o dependencias.
`finance_domain` entregó observaciones sin propiedad de escritura. No fue necesario
repetir una revisión de seguridad completa ni crear otra suite para este cambio documental.

La propuesta queda lista para aprobar o ajustar. Después de aprobar ADR-001, validar
driver/versión y construir un incremento vertical de persistencia del mismo flujo
con las pruebas enumeradas en el ADR. No introducir presupuestos, deudas, salarios,
integraciones o datos reales como parte de ese paso.
