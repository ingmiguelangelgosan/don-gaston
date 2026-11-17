# Fase 2B — validación del runtime Node

Fecha: 2026-11-17. **Interoperabilidad local verificada en un runtime soportado.**
Tras la autorización explícita del usuario se descargó y extrajo Node portátil;
se resolvió el bloqueo inicial descrito en el registro histórico inferior.

## Resultado final tras la autorización

- Runtime: **Node v24.22.3, Windows x64**, npm **11.19.1** incluido.
- Ejecutable: `D:\Documentos\don-gaston\.cache\runtimes\node-v24.22.3-win-x64\node.exe`.
- npm: `D:\Documentos\don-gaston\.cache\runtimes\node-v24.22.3-win-x64\npm.cmd`.
- Satisface Don Gastón `>=24.19.0 <25`, Jarvis `>=24.22.1 <25` y su npm `>=11 <13`.
- Checkout Jarvis: `c015c4e02908676fa8f87fc7bf524580169bb578`; diff frente a HEAD
  vacío en fuentes de agentes, servicio de ejecución, SQLite durable, migración
  y manifiestos inspeccionados. No se escribió en Jarvis.

Se consultó el índice oficial `https://nodejs.org/dist/index.json`, que enumeró
v24.22.3 con fecha de publicación 2026-11-10. Se descargó
`https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip` (37.762.649 bytes).
Su SHA-256 coincidió con la entrada de `SHASUMS256.txt` oficial, obtenido por
HTTPS verificado, antes de extraer:

```text
e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f
```

Índice, ZIP y checksums quedan en `.cache/` ignorado por Git. PowerShell y curl
fallaron inicialmente al conectar mediante Schannel; se utilizó el cliente HTTPS
de Node con validación TLS normal. No se desactivó TLS ni se instalaron certificados.
Se comprobó checksum, no se afirma verificación de firma independiente del listado.

### Ejecuciones nuevas con Node compatible

| Comando | Resultado | Evidencia |
|---|---|---|
| `npm.cmd run test:interop` | **20/20**, cero fallos/omitidas, 2.401 s | `.cache/node-compatible-interop.log` |
| `npm.cmd run format:check` | Salida 0 | `.cache/node-compatible-format-check.log` |
| `npm.cmd run lint` | Salida 0 | `.cache/node-compatible-lint.log` |
| `npm.cmd run typecheck` | Salida 0 | `.cache/node-compatible-typecheck.log` |
| `npm.cmd run build` | Salida 0 | `.cache/node-compatible-build.log` |

Se verificaron los 20 escenarios existentes: 45.000 COP exactos, replay y
concurrencia sin duplicación, lookup, pérdida de respuesta tras commit, estado
uncertain intacto después de consulta y reapertura, RESULT_EXPIRED/completed,
aislamiento, permisos, credenciales, esquemas, límites, deadlines y TLS.
Las tres bases permanecen separadas en nuevos directorios sintéticos del harness.
El reinicio probado reconstruye componentes y conexiones en el mismo proceso;
no es un reinicio del Jarvis operativo. No se repitió la suite financiera porque
no se cambió código, contratos ni migraciones. No se instalaron dependencias npm.

### Reproducción con el runtime portátil

En una PowerShell temporal desde Don Gastón:

```powershell
$env:PATH = (Resolve-Path .cache/runtimes/node-v24.22.3-win-x64).Path + ';' + $env:PATH
$env:JARVIS_INTEROP_REPO = 'D:/Documentos/sir-jarvis'
Get-Command node,npm.cmd
node --version
node -p process.execPath
npm.cmd --version
npm.cmd run test:interop
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

Cada ejecución recibió únicamente un PATH de proceso. Fuera de esos procesos se
comprobó nuevamente Node **24.19.0** en `C:\Program Files\nodejs\node.exe`.
No se modificó PATH persistente, registro, symlinks, servicios ni configuración
operativa. Cerrar el proceso revierte la selección; el portátil queda retenido.

El bloqueo de runtime queda resuelto. Permanecen los límites de Fase 2A:
no hay atomicidad/respaldo conjunto de las tres bases, lookup no concilia el
journal incierto y no se probó la composición operativa completa de Jarvis.
Siguiente paso recomendado: definir por separado el flujo local de confirmación
y recuperación de escrituras inciertas, antes de conectar canales. No habilita
producción, FIN-01 o datos reales; Fase 1 sigue abierta.

## Registro histórico de la inspección previa a la autorización

Estado inicial: **bloqueada la reproducción en runtime compatible**; no se
encontró una instalación que satisfaga ambos manifiestos en las ubicaciones
inspeccionadas. No se instaló, descargó, actualizó ni reemplazó ningún runtime.
No se declara interoperabilidad local verificada en un runtime soportado.

## Entorno comprobado ahora

| Comprobación | Resultado |
|---|---|
| `node --version` | `v24.19.0` |
| `Get-Command node -All` | `C:\Program Files\nodejs\node.exe` |
| `Get-Command npm.cmd -All` | `C:\Program Files\nodejs\npm.cmd` |
| `npm.cmd --version` | `11.17.0` |
| Don Gastón `package.json` engines.node | `>=24.19.0 <25` |
| Jarvis `package.json` engines.node | `>=24.22.1 <25` |
| Jarvis engines.npm | `>=11 <13` |
| Intersección Node | `>=24.22.1 <25`; Node activo no cumple |

Se consultaron ambos manifiestos directamente. `Get-Command nvm,fnm,volta`
no encontró gestores; NVM_HOME, NVM_SYMLINK, VOLTA_HOME y FNM_DIR están vacíos.
La carpeta Node activa no informó enlace/symlink.

Se buscaron `node.exe` y `npm.cmd` mediante `rg --files --hidden --no-ignore`
en rutas existentes de esta lista: Program Files/nodejs y nodejs24, AppData
Roaming/Local nvm y fnm, perfil/.volta, Scoop apps/nodejs y nodejs-lts,
`C:/tools`, `D:/tools`, `.cache` de Don Gastón y AppData/Local/Programs.
Solo apareció la instalación activa (y shims npm internos). No se hizo una
búsqueda indiscriminada de discos, datos personales o directorios operativos de
Jarvis; una instalación portátil en otra ruta sigue siendo posible.

## Verificaciones realmente ejecutadas en esta fase

Ejecutadas desde Don Gastón **con Node 24.19.0**, no con un runtime compatible:

| Comando | Resultado | Evidencia local |
|---|---|---|
| `npm.cmd run format:check` | Salida 0 | `.cache/node-compat-format-check.log` |
| `npm.cmd run lint` | Salida 0 | `.cache/node-compat-lint.log` |
| `npm.cmd run typecheck` | Salida 0 | `.cache/node-compat-typecheck.log` |
| `npm.cmd run build` | Salida 0 | `.cache/node-compat-build.log` |

**No se ejecutó `test:interop` en Fase 2B**: repetirla con el mismo Node no
resuelve el objetivo. Las 20/20 pruebas de
[Fase 2A](JARVIS_REAL_GATEWAY_INTEROP.md) son evidencia histórica. Tampoco se
repitió la suite financiera: no se modificó código compartido ni contratos.

Los cambios de Fase 2A ya presentes en el árbol de trabajo se conservaron.
El único archivo de entrega añadido en Fase 2B es este informe; build regeneró
artefactos locales ignorados. Sin cambios en Jarvis, reglas o migraciones.
La inspección y verificaciones fueron realizadas por el coordinador: no se
necesitaron tareas independientes para otros agentes en este incremento.

## Propuesta concreta, aislada y reversible — requiere autorización

1. Si el operador conoce otro `node.exe` instalado, comprobar su versión/ruta
   y preferirlo antes de descargar nada.
2. De lo contrario, solicitar autorización para descargar una distribución
   **portátil oficial Windows** de Node 24, versión exacta publicada que cumpla
   `>=24.22.1 <25`, en `.cache/runtimes/` de Don Gastón. Confirmar primero su
   disponibilidad en el sitio oficial; este informe no afirma que se haya
   comprobado ni descargado un artefacto concreto. Si no existe una versión
   publicada compatible, detenerse sin cambiar los engines.
3. Comprobar arquitectura, versión exacta y checksum oficial del ZIP antes de
   extraerlo en una carpeta nueva. No ejecutar MSI, modificar registro, instalar
   gestores, alterar symlinks, reemplazar Node global ni ejecutar npm install.
4. En una PowerShell hija efímera, anteponer exclusivamente la carpeta portátil
   al PATH de ese proceso. Verificar `Get-Command node,npm.cmd -All`,
   `node --version`, `node -p process.execPath` y `npm.cmd --version`; npm debe
   ser también compatible. Así scripts npm y procesos hijos usarán ese Node.
   No basta con invocar un npm global que pudiera escoger su Node adyacente.
5. Desde Don Gastón, fijar `JARVIS_INTEROP_REPO` al checkout autorizado y ejecutar
   `npm.cmd run test:interop`, formato, lint, typecheck y build. Conservar logs
   nuevos diferenciados y registrar las rutas exactas. Las tres bases sintéticas
   seguirán separadas y creadas por el harness existente.
6. Cerrar la PowerShell hija restaura el entorno por construcción: no hubo cambio
   de PATH persistente ni reinicio de procesos operativos. Conservar la carpeta
   portátil y fixtures hasta decidir explícitamente su limpieza; no borrar datos
   automáticamente.

La autorización pendiente procede de la instrucción expresa del usuario:
«No instalar dependencias o runtimes sin autorización». No es un bloqueo del
revisor automático ni una incompatibilidad demostrada del código financiero.

Tras obtener runtime compatible, el criterio es reproducir los 20 casos actuales,
incluidos RESULT_EXPIRED, uncertain inmutable tras lookup, reapertura, TLS,
aislamiento y ausencia de duplicación. Si pasan, declarar únicamente
**interoperabilidad local verificada en un runtime soportado**. No habilita
producción, FIN-01, datos reales ni cierre de Fase 1.
