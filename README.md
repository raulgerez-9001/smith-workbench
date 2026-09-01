# Smith Workbench (versión estática)

Corre 100% en el navegador — sin backend, sin instalar nada. El motor
de backtesting está reescrito en JavaScript puro y validado con
paridad numérica exacta contra la versión en Python.

## Probar en tu máquina

No hace falta más que un servidor de archivos estático (los navegadores
bloquean `fetch`/IndexedDB si abrís el `index.html` directo con
`file://`). La forma más simple:

```bash
cd smith_static
python3 -m http.server 8090
```

Y abrís `http://127.0.0.1:8090`.

## Publicar en GitHub Pages

1. Creá un repositorio en GitHub y subí el contenido de esta carpeta.
2. En el repo: **Settings → Pages → Source** → elegí la rama `main` y
   la carpeta `/ (root)`.
3. GitHub te da una URL tipo `https://tu-usuario.github.io/tu-repo/` —
   esa es la que abrís desde cualquier dispositivo, incluido el celular.

## Cómo se organiza la información

- **Datos**: los CSV que subís quedan guardados en el navegador
  (IndexedDB), por par + temporalidad. Hoy se cargan a mano; en la
  Etapa 3 se van a poder pedir directo a IQ Option.
- **Estrategias**: indicadores tildados + parámetros + gestión de
  capital, con su propio ID. No están atadas a ningún par ni resultado
  — se reutilizan en distintos backtests.
- **Backtests guardados**: una corrida concreta (estrategia + par +
  temporalidad + resultados + curva de capital completa), con su
  propio ID, para comparar entre corridas.

## Importante: qué funciona hoy y qué falta

Esta versión **ya se conecta a IQ Option de verdad**, siempre que le
apuntes a un servidor desplegado (Etapa 2 — ver `smith_webapp/DEPLOY.md`).
Desde la pestaña **Datos**, la sección "⚙ Configuración del servidor"
guarda la URL de tu backend y el token de acceso en este navegador
(en `localStorage`); con eso configurado, el formulario "Pedir datos a
IQ Option" pide usuario/contraseña, pares, temporalidad, cantidad de
velas y fecha de fin, y muestra el progreso de la descarga en vivo,
por par. Cuando termina, los datos quedan disponibles automáticamente
en la pestaña Backtest — sin tocar ningún archivo CSV a mano.

La pestaña **Operar** ya está conectada también: elegís una estrategia
guardada, un par y temporalidad, y el modo:
- **Simulado**: reproduce datos ya descargados como si llegaran en
  vivo — sin tocar tu cuenta, para validar que la estrategia hace lo
  esperado antes de arriesgar nada.
- **Demo**: opera en tu cuenta PRACTICE de IQ Option de verdad.
- **Real**: exige escribir literalmente `ACEPTO-EL-RIESGO` para
  habilitarse — el mismo gesto explícito que ya tenía `live_executor.py`
  por línea de comandos.

La sesión corre en el servidor, no en tu navegador — podés cerrar la
pestaña y seguir corriendo; el botón "Reconectar" en la lista de
sesiones te vuelve a mostrar el log en vivo desde donde quedó.

**Sincronización entre dispositivos (Etapa 5, ya funciona):** con el
servidor configurado, las estrategias y los backtests que guardás se
mandan también al servidor — cualquier otro dispositivo apuntando al
mismo servidor (misma URL + mismo token) ve exactamente la misma
biblioteca, sin haber creado nada localmente. Sirve como respaldo
offline también: si el servidor no responde en un momento dado, la
pestaña muestra la última copia que tenía guardada en este navegador.

Los **datasets** (velas históricas) funcionan igual: cualquier par que
se haya descargado desde cualquier dispositivo queda disponible en la
sección "Disponibles en el servidor" de la pestaña Datos, con un botón
para importarlo al dispositivo actual sin volver a pedírselo a IQ
Option.

## Publicar en GitHub Pages (para usarlo desde cualquier lado)

Ya está listo para publicar — el checklist:

1. Desplegá el backend (`smith_webapp/`) siguiendo `DEPLOY.md`.
2. Creá un repositorio en GitHub y subí el contenido de esta carpeta
   (`smith_static/`).
3. En el repo: **Settings → Pages → Source** → rama `main`, carpeta
   `/ (root)`. GitHub te da una URL tipo
   `https://tu-usuario.github.io/tu-repo/`.
4. **Importante**: en el servidor, actualizá `ALLOWED_ORIGIN` en el
   `.env` para que sea exactamente esa URL de GitHub Pages (sin barra
   al final), y reiniciá el backend (`docker compose up -d --build`).
5. Abrí esa URL desde cualquier dispositivo (con tu cuenta de Gmail
   basta para entrar a GitHub, no hace falta nada más), configurá el
   servidor una vez en la pestaña Datos, y listo — todo sincronizado.
