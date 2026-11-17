# Fase 2E — integración conversacional sintética

Fecha: 2026-11-17. **Implementado y verificado localmente con el handler/polling,
Registry, AgentExecutionService, Gateway durable y HTTPS reales de Jarvis.**
TelegramApi es simulada; no se conectó el bot operativo, Telegram real, IA o bancos.
Fase 1 permanece abierta y el uso financiero real sigue sin autorización.

## Alcance aprobado y revalidación

Se aplicó la autorización explícita para modificar ambos repositorios únicamente
en la ruta experimental separada, según
[el diseño aprobado](JARVIS_CONVERSATIONAL_INTEGRATION_DESIGN.md).
Jarvis conservaba HEAD `c015c4e02908676fa8f87fc7bf524580169bb578`, con las interfaces
inspeccionadas compatibles y sin cambios en sus fuentes antes de este incremento.
Don Gastón partía de HEAD `97bd4e0c50fdb0a5e1ab5bc22ec649a49dd37d76` y cambios
locales de 2C/2D que se conservaron. Archivos ajenos no versionados de Jarvis no se
leyeron ni modificaron. No se inspeccionó configuración ni información operativa.

La autorización actual prevalece sobre las restricciones anteriores de solo
lectura de Jarvis, exclusivamente para estos archivos y pruebas. Las escrituras
en el repositorio vecino se aplicaron desde copias preparadas en Don Gastón, con
acceso autorizado; los repositorios siguen siendo independientes. Jarvis no importa
código privado de Don Gastón. Los imports entre repositorios existen solo en tests.

## Resultado del recorrido completo

1. TelegramApi de pruebas entrega un update sintético al handler real: «Jarvis,
   gasté $45.000 en gasolina el 2026-11-17».
2. Handler valida privado/allowlist/remitente y reserva la acción en su journal.
   La ruta optativa resuelve el sujeto por configuración y Gasolina por mapa
   sintético autorizado; prepara un pending durable sin llamar a record.
3. La plantilla muestra `45000 COP`, Gasolina, fecha y referencia opaca `G-…`.
   Un «sí» aislado no ejecuta; se exige `sí G-<12 caracteres hexadecimales>`.
4. Se revalida el binding y permiso. El CAS guarda consentimiento, procedencia
   HMAC y envelope definitivo con deadline de 20 segundos antes del envío.
5. Registry/servicio/Gateway/HTTPS reales invocan record 1.0 en Don Gastón.
   SQLite registra exactamente un gasto de `minor:"4500000"`, COP, categoría y
   fecha correctas. La plantilla confirma el resultado.
6. Otro update con la misma referencia no crea otra intención ni escritura.
   Con respuesta financiera perdida, lookup recupera el hecho original y la
   comparación completa del journal demuestra que `uncertain` permanece intacto.

El recorrido también se ejecutó a través de **runTelegramPolling real**, con
getMe/getUpdates/sendMessage simulados y offset durable, en turnos separados de
preparación y confirmación. No es otro simulador de Gateway ni de core.

## Implementación y decisiones

### Estado y consentimiento

`SqliteConfirmationStore` añade una cuarta base de pruebas, independiente de las
tres existentes. Creación exclusiva, reapertura obligatoria, binding de instalación,
schema v1, quick_check, transacciones locales y capacidad máxima de 10.000 registros
preparados. No hay cambios en las migraciones financieras ni en el journal existente.

Cada pending conserva ámbito de instancia/sujeto/conversación HMAC, draft exacto,
referencia aleatoria, revisión, huella, creado/caduca, request/correlation/intent IDs
estables, consentimiento y procedencia, envelope final, outcome y evidencia mínima.
El audit append-only registra prepared/superseded/confirmed/cancelled/resultados/
recuperación con versión y fecha. Triggers impiden borrar registros o reescribir
auditoría por las operaciones normales. No guarda credenciales, IDs Telegram en
claro ni conversaciones completas. El hash no autentica el archivo frente a un
atacante con control de escritura local.

La preparación/revisión corre en BEGIN IMMEDIATE; un índice único impide múltiples
pending activos por ámbito. Cambiar un draft awaiting cancela la referencia anterior
con motivo superseded y crea otra revisión que exige consentimiento. Estados
executing/uncertain bloquean su sustitución. Un CAS cuya versión ya cambió no envía.
Cancelar después de que pudo comenzar la ejecución se rechaza, sin borrar el gasto
ni representar una devolución. Confirmaciones repetidas conservan la misma intención.

### Gramática, permisos y plazos

Gramática acotada: `/gasto 45000 COP gasolina 2026-11-17`, la frase demostrada,
`sí <ref>`, `cancelar <ref>`, `consultar <ref>` y `pendientes`. Datos incompletos o
ambiguos generan aclaración; se reenvía una expresión completa corregida. No hay
acumulación libre de fragmentos de conversación, IA ni inferencia de fecha actual.

El consentimiento vence a los 5 minutos de preparar o revisar; al confirmar se
comprueba vigencia. No se implementó scheduler de caducidad. El deadline técnico se
construye al confirmar, no durante la espera humana. Para probar minutos de espera
sin dormir, el harness inyecta un reloj de consentimiento y usa tiempo real para el
deadline que valida el Gateway; en la composición normal ambos usan el mismo reloj.
No se renuevan automáticamente escrituras inciertas.

El resolver de sujeto se consulta en cada mensaje y permite revocación entre
preparación y confirmación. El servicio reautoriza contra Registry antes de ejecutar
o revelar estado/evidencia. Don Gastón conserva sus comprobaciones independientes
de token/actor delegado/sujeto/acciones. La referencia no es credencial; el actor
humano sigue en la auditoría local de Jarvis, sin modificar el wire.

Los schemas financieros son validadores locales explícitos en Jarvis, sin nuevas
capacidades. Se contrastaron con el contrato Don Gastón para importes y fechas
límite. La respuesta debe coincidir con importe, categoría y fecha confirmados antes
de mostrar éxito: una respuesta bien formada con importe distinto queda incierta.

### Recuperación y entrega

Se mantienen separados estado conversacional, outcome del Gateway, evidencia
financiera y entrega del mensaje. `found:false` no prueba ausencia definitiva.
`RESULT_EXPIRED/completed` se produjo reconstruyendo el Gateway real después del
commit; lookup recuperó output sin una segunda escritura. Incertidumbre previa al
envío se inyectó como fallo del despacho; lookup siguió siendo una llamada real.

Las plantillas recuperadas no resetean el journal ni afirman una conciliación que
no ocurrió. Si se perdió el prompt, `pendientes` muestra la misma referencia;
si se perdió la respuesta final, consultar o confirmar de nuevo presenta el mismo
hecho. El journal de Telegram registra delivery-uncertain separado del gasto.

## Archivos modificados, por repositorio

### Sir Jarvis — nueve archivos de este incremento

Modificados:

- `src/channels/telegram/handler.ts`: ruta separada tras validación de identidad;
  reserva durable obligatoria y entrega por el mecanismo existente.
- `src/channels/telegram/runtime.ts`: hook opcional `expenseConversation`.

Nuevos:

- `src/channels/telegram/expense-conversation.ts`: gramática, binding y plantillas.
- `src/app/expense-confirmation.ts`: orquestación/CAS/recuperación.
- `src/app/confirmation-store.ts`: puerto y modelos de consentimiento.
- `src/infrastructure/sqlite-confirmation-store.ts`: estado/auditoría SQLite separados.
- `src/agents/finance-expense-profile.ts`: validación del perfil record/lookup existente.
- `tests/expense-conversation.test.ts`: persistencia, CAS, rollback y aislamiento.
- `docs/EXPERIMENTAL_EXPENSE_CONVERSATION.md`: composición experimental y límites.

Sin cambios en `telegram-main.ts`, `telegram-agents.ts`, `agent-read.ts`,
`agent-commands.ts`, loader, Gateway durable o política de red. `/agent` conserva
lectura. No se amplió el catálogo del loader operativo: la composición de tests
registra los schemas financieros directamente. Omitir el hook mantiene la nueva
ruta deshabilitada; esto se probó explícitamente.

### Don Gastón — seis archivos de este incremento

- Modificado `tests/interop/jarvis-real-harness.mjs`: puertos para composición de
  tests, selección optativa del perfil real Jarvis y reconstrucción del Gateway.
- Nuevo `tests/interop/jarvis-conversation-harness.mjs`: composición del handler/
  polling reales, API Telegram simulada, cuatro bases y fallos controlados.
- Nuevo `tests/interop/jarvis-conversation.test.mjs`: 26 casos de aceptación.
- Nuevo este informe; actualizados README y roadmap.

Los archivos 2C/2D preexistentes en el árbol de trabajo no son entregas nuevas de
2E. No se modificaron dominio, servicios financieros, contrato wire ni migraciones.

## Pruebas y verificaciones realmente ejecutadas

Runtime portátil autorizado: Node **24.22.3**, npm **11.19.1**, en
`D:\Documentos\don-gaston\.cache\runtimes\node-v24.22.3-win-x64`.
PATH temporal por proceso; no instalación global. Artefactos de pruebas sintéticas
en `.cache/jarvis-real-interop/` de Don Gastón y `.tools/expense-confirmation-tests/`
de Jarvis. Listeners y conexiones se cierran; no borrado automático de estas fixtures.

| Ejecución | Resultado real |
|---|---|
| Primera suite conversacional | 23/23; `.cache/conversation-e2e-first.log` |
| `npm.cmd run test:interop` final, Don Gastón | **60/60**, 0 omitidas: 26 nuevas + 34 existentes; `.cache/don-gaston-conversation-e2e.log` |
| Regresión dirigida Jarvis, comando inferior | **123/123**, 0 omitidas; `.cache/jarvis-conversation-regression.log` en Don Gastón |
| Formato, lint, typecheck, build Don Gastón | Salida 0; `.cache/don-gaston-phase2e-*.log` |
| Lint, typecheck, build Jarvis | Salida 0; `.cache/jarvis-phase2e-{lint,typecheck,build}.log` en Don Gastón |
| Formato de los nueve archivos tocados en Jarvis | Salida 0 |
| `npm.cmd run format:check` global Jarvis | **Salida 1**: 20 archivos preexistentes bajo `.agents/skills/security-audit/`; ajenos al incremento y sin modificaciones |
| `git diff --check` en ambos | Salida 0; avisos normales LF/CRLF, sin errores de whitespace |

El primer intento de formato global terminó antes por manejo de stderr de
PowerShell; se completó la ejecución para registrar el código real y se verificó
por separado todo el alcance modificado. No se reformatearon archivos ajenos ni
se cambió la política de Prettier para ocultar el fallo global.

Regresión ejecutada en Jarvis:

```powershell
node --test tests/expense-conversation.test.ts tests/telegram.test.ts tests/telegram-agent-handler.test.ts tests/telegram-agent-config.test.ts tests/telegram-agents.e2e.test.ts tests/durable-telegram.test.ts tests/agent-read.test.ts tests/agent-execution.test.ts tests/agent-registry.test.ts tests/durable-gateway.test.ts
```

Los cuatro casos nuevos de store prueban supersesión/historia inmutable, CAS entre
dos conexiones, rollback de estado si falla auditoría y reapertura/aislamiento.
Los 26 conversacionales cubren flujo completo, faltantes/ambigüedad, sí aislado,
referencia errónea, duplicados/carrera confirmación-cancelación, cambio de revisión,
caducidad, espera humana mayor de 20 s, reinicios, otro usuario/chat/bot/sender_chat,
revocación, respuesta financiera perdida, lookup/RESULT_EXPIRED/uncertain, entrega
perdida de prompt y resultado, TLS, permisos, límites, comandos históricos, hook
deshabilitado y conformidad de input/evidencia financiera.

La regresión Jarvis existente incluye Echo HTTPS y comandos de lectura exitosos;
en el harness financiero `/agent` se prueba específicamente como ruta incapaz de
registrar gastos. No se afirma que el bot se conectara a Telegram real.

No se repitieron las 354 pruebas financieras históricas: no cambió código financiero
compartido. Los tests `.mjs` de Don Gastón se ejecutan y pasan lint/formato pero
no integran el typecheck TypeScript; el código nuevo Jarvis sí pasa su typecheck
estricto y build. No se afirma regresión integral de infraestructura fuera de alcance.

## Reproducción

En una PowerShell temporal, seleccionar primero el portátil:

```powershell
$env:PATH = 'D:/Documentos/don-gaston/.cache/runtimes/node-v24.22.3-win-x64;' + $env:PATH
$env:JARVIS_INTEROP_REPO = 'D:/Documentos/sir-jarvis'
node --version
# Desde Don Gastón:
npm.cmd run test:interop
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
# Desde Jarvis: comando de tests dirigido anterior y estas verificaciones:
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

Requiere ambos checkouts con cambios locales 2E, dependencias existentes y OpenSSL
local para CA/leaf sintéticos. No se descargaron dependencias adicionales. Los
puertos efímeros son exclusivamente loopback, TLS valida CA y hostname. La excepción
de red existe solo en tests, no en la política productiva Jarvis.

## Coordinación, riesgos y siguientes autorizaciones

`finance_domain` produjo puerto/store/servicio en staging exclusivo;
`test_engineer` produjo las 23 pruebas iniciales en su archivo exclusivo;
`security_reviewer` revisó parcialmente las copias locales, identidad, CAS y
plantillas. Los agentes alcanzaron su límite de uso antes del cierre. El coordinador
retomó archivos, completó revisión/integración, añadió tres pruebas, los tests
Jarvis y ejecutó todas las verificaciones reportadas. No se atribuye a los agentes
una revisión final o ejecución que no completaron. La observación concreta sobre
evidencia distinta del borrador quedó corregida y cubierta por prueba.

Limitaciones: no atomicidad/respaldo coordinado entre cuatro bases; sin conciliación
automática; audit no firmado frente a manipulación local privilegiada; retención
del contenido mínimo/crecimiento de audit y gestión operativa de claves pendientes.
Reinicio demostrado por reconstrucción de componentes y conexiones, no corte
eléctrico ni reinicio del bot operativo. Las pruebas concurrentes usan conexiones
y solicitudes concurrentes locales, no certifican un despliegue distribuido.

La gramática usa una categoría ficticia y exige repetir la expresión completa tras
una aclaración; no es lenguaje natural general. `/start` y `/status` mantienen sus
plantillas históricas porque no se activó finanzas en el bot operativo. El formato
global Jarvis conserva el fallo externo al alcance señalado arriba.

Nueva autorización necesaria antes de: instalar el hook en loader/main operativo,
configurar credenciales/CA/bindings reales, cambiar red o infraestructura, conectar
Telegram real, reiniciar/desplegar servicios, habilitar FIN-01 o información real,
añadir categorías/capacidades remotas o conciliación de estados inciertos.

Siguiente incremento recomendado: revisar el diff acotado de ambos repositorios y
definir el procedimiento de recuperación/respaldo conjunto antes de evaluar una
activación de canal. Ninguna activación queda implícita en esta demostración.
