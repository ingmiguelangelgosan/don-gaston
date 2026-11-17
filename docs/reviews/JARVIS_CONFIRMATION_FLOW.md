# Fase 2C — confirmación y recuperación local

Fecha: 2026-11-17. Alcance exclusivamente sintético. El controlador de conversación
es una fixture de Don Gastón; utiliza los componentes reales Registry, Gateway
durable, servicio de ejecución y transporte HTTPS del harness de Fase 2A.
No es una integración del bot ni un mecanismo financiero operativo de Jarvis.

## Arquitectura y frontera

El controlador `tests/interop/confirmation-flow.mjs` recibe comandos estructurados
con contexto de actor externo y produce respuestas de plantilla. No interpreta
lenguaje natural. Conserva la solicitud exacta, moneda COP, importe textual,
categoría, fecha civil, sujeto y claves originales. La confirmación se vincula a
esa solicitud; no admite cambios de contenido dentro del comando de confirmación.

Su estado vive en un cuarto SQLite sintético, `flow.sqlite`, separado de
`finance.sqlite`, `adapter.sqlite` y `jarvis.sqlite`. La reserva del flujo precede
al envío HTTPS. No se modifica el esquema de ninguna de las tres bases originales
ni se invoca SQL directo sobre ellas. Los efectos aprobados siguen pasando por
los servicios existentes. No existe una transacción distribuida entre los cuatro
archivos ni respaldo/restauración conjunto.

La identidad del actor se entrega desde la configuración controlada de prueba,
fuera del payload financiero. Registry y Don Gastón mantienen sus comprobaciones
independientes de permisos. La huella de confirmación no es una credencial ni
sustituye autenticación. No se guardan tokens TLS/Bearer en el estado del flujo.

## Estados y transiciones

| Estado | Significado y transiciones |
|---|---|
| awaiting_confirmation | Solicitud preparada sin efecto financiero; confirmar conduce a executing; cancelar conduce a cancelled |
| cancelled | Cancelación previa al envío; terminal, no ejecuta record |
| executing | Confirmación reservada antes de enviar; duplicados no vuelven a escribir; puede terminar completed, failed o uncertain |
| completed | Resultado de gasto confirmado; repetir confirmación solo consulta el estado local |
| uncertain | No se autoriza nueva escritura; únicamente lookup para obtener evidencia, sin desbloquear el Gateway |
| failed | Rechazo definitivo comprobado; no se convierte automáticamente en otra intención |

No se permite cancelar después de que pudo comenzar la ejecución: no equivale a
anular un gasto ni a devolver dinero. Tampoco se permite volver de uncertain,
failed o cancelled a awaiting_confirmation/executing. El cambio de importe o
categoría requiere otra preparación explícita, y nunca se utiliza como recuperación
automática de una escritura incierta.

Un gasto encontrado mientras Jarvis permanece incierto se comunica explícitamente
como evidencia financiera recuperada y conciliación pendiente. `found:false` no
demuestra que el gasto nunca ocurrió. RESULT_EXPIRED/completed acredita el estado
durable de Jarvis pero no proporciona el output; se recupera por lookup usando la
intención original. Las lecturas tienen sus propios identificadores; nunca se
genera otra clave de escritura para salir de incertidumbre.

El controlador no lee directamente el journal Jarvis: conserva el outcome recibido.
Una recuperación concurrente puede adelantarse a la respuesta completed e impedir
su actualización por revisión optimista; el flujo permanece uncertain de forma
conservadora aunque Jarvis ya haya completado. Por eso la plantilla dice «El flujo
sigue incierto y pendiente de conciliación con Jarvis», sin afirmar que acaba de
leer su phase. Las pruebas inspeccionan el journal para verificar su preservación.

El deadline forma parte de la solicitud confirmada y no se renueva silenciosamente.
Si vence esperando confirmación, el Gateway rechaza el envío; no se interpreta como
permiso para modificar la solicitud confirmada. Cada base del flujo queda ligada
a un actor de pruebas (instancia/sujeto); reabrir con otro actor se rechaza. Crear
requiere archivo nuevo, reabrir requiere existente y versión/binding válidos.
El hash no es MAC: no protege frente a alguien con escritura arbitraria en SQLite.
No hay gestión de acceso/retención operativa ni historial append-only de cada
transición del controlador; esos límites son propios de esta fixture sintética.

## Ejecución reproducible y evidencia

Desde Don Gastón, en una PowerShell temporal:

```powershell
$env:PATH = (Resolve-Path .cache/runtimes/node-v24.22.3-win-x64).Path + ';' + $env:PATH
$env:JARVIS_INTEROP_REPO = 'D:/Documentos/sir-jarvis'
node --test tests/interop/confirmation-flow.test.mjs
npm.cmd run test:interop
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

Node **24.22.3** y npm **11.19.1**, portátil previamente autorizado; sin nuevas
dependencias ni cambios de PATH global. Ruta de Node:
`D:\Documentos\don-gaston\.cache\runtimes\node-v24.22.3-win-x64\node.exe`.

| Verificación ejecutada ahora | Resultado |
|---|---|
| Suite dirigida de confirmación | **14/14**, sin omitidas; `.cache/confirmation-tests.log` |
| Suite de interoperabilidad completa | **34/34**, sin omitidas; `.cache/confirmation-interop.log` |
| Prettier write de los dos archivos nuevos | Salida 0 |
| Formato, lint, typecheck y build | Salida 0; `.cache/confirmation-{format-check,lint,typecheck,build}.log` |

Los 14 casos comprueban preparación sin efectos, request inmutable, confirmación
válida y duplicada concurrente, cancelación terminal, actor ajeno, cambios de datos,
reapertura pendiente/completed/cancelled/uncertain, pérdida de respuesta postcommit,
lookup con resultado y sin él, conservación del journal, conexiones concurrentes
en executing, RESULT_EXPIRED real después de reconstruir el Gateway, permisos en
Registry y adaptador, deadline vencido, TLS y apertura exclusiva/binding del flujo.

Para reproducir la ventana anterior al envío se inyecta una interrupción en el
despacho, no un Gateway falso. Para la ventana executing concurrente se pausa el
despacho y se abre una segunda conexión al estado del flujo; tras liberarlo la
escritura utiliza el Gateway real. RESULT_EXPIRED se obtiene ejecutando y
reconstruyendo el Gateway real antes de recuperar la misma intención. No se
afirma prueba de corte eléctrico, reinicio de SO ni de todos los procesos.

Las 20 pruebas existentes se ejecutaron nuevamente para comprobar composición
del flujo con la frontera real. Las 354 financieras son evidencia histórica;
no se repitieron porque no cambió código compartido, contratos ni migraciones.
Los archivos `.mjs` pasan ESLint/Prettier y ejecución; no forman parte del
typecheck TypeScript ni del build de aplicación. Los listeners de prueba se
cierran y las cuatro bases sintéticas quedan bajo `.cache/` sin borrado automático.

## Archivos y coordinación

- Nuevos: `tests/interop/confirmation-flow.mjs`,
  `tests/interop/confirmation-flow.test.mjs` y este informe.
- Actualizados: README y roadmap para reflejar Fase 2B/2C sin alterar contratos.
- `finance_domain` produjo el controlador en su archivo exclusivo. Alcanzó límite
  de uso tras entregarlo; el coordinador revisó y completó el tratamiento de errores.
- La delegación inicial de pruebas no dejó archivo al retomar. El coordinador
  implementó y ejecutó las 14 pruebas, sin atribuirlas al especialista.
- `security_reviewer` completó revisión final solo lectura, sin bloqueantes
  confirmados para el alcance sintético. Identificó el estado conservador ante
  recuperación concurrente; se ajustó la plantilla para no atribuir un phase
  actual no leído a Jarvis. No ejecutó pruebas ni inspeccionó el repositorio vecino.

El coordinador inspeccionó las interfaces necesarias de Jarvis en lectura;
el diff frente a HEAD de esas rutas y manifiestos siguió vacío. Sin commits/PR,
despliegue ni cambios en módulos financieros.

## Diferencias con el runtime conversacional de Jarvis

Se reinspeccionaron en lectura `src/app/agent-execution.ts`,
`src/app/agent-read.ts` y la recuperación del Gateway durable, checkout
`c015c4e02908676fa8f87fc7bf524580169bb578`. El servicio real verifica el actor
externo y autoriza la ejecución; el flujo de lectura existente no constituye
confirmación financiera operativa. Este incremento no modifica ni habilita
comandos del bot. La composición de canales, confirmaciones, autenticación humana
y revocación operativa continúa siendo responsabilidad de Jarvis.

No fue necesario cambiar su repositorio ni los contratos record/lookup 1.0.
Solo se simula la conversación; ejecución, HTTPS verificado e idempotencia
financiera utilizan las implementaciones existentes.

## Conciliación futura — procedimiento propuesto, no implementado

1. Conservar la intención original y detener nuevas escrituras que pretendan
   sustituirla por incertidumbre.
2. Consultar evidencia autorizada por lookup y registrar por separado el estado
   del Gateway y el hecho financiero encontrado; ausencia no acredita no ejecución.
3. Revisar por un operador autorizado la coherencia de los cuatro archivos y las
   ejecuciones concurrentes, preservando historia y control de acceso.
4. Definir y aprobar en Jarvis una transición o registro de conciliación auditable,
   con permisos e idempotencia propios, antes de implementar cualquier desbloqueo.
   No editar SQL ni resetear estados del Gateway como procedimiento normal.
5. Probar recuperación y respaldo conjunto antes de cualquier autorización de
   datos reales. No se promete entrega exactamente una vez.

Fase 1 permanece abierta. No hay FIN-01 productivo, Telegram, bancos, IA,
listeners permanentes, despliegue ni datos financieros reales.
