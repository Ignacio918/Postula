# Postula

Postula busca vacantes, las compara con tu CV, prepara una versión orientada al puesto y permite que un agente local complete y envíe solicitudes compatibles.

## Puesta en marcha

1. Iniciá sesión en [Postula](https://postula-iota.vercel.app/) y abrí **Mi perfil**.
2. Importá tu CV en PDF o TXT. La extracción del PDF se hace en el navegador; revisá los datos de contacto y guardá el perfil.
3. Completá los puestos que buscás. La búsqueda incluye Remotive y Jobicy; Greenhouse y Lever son fuentes adicionales opcionales.
4. Definí modalidad, encaje mínimo y máximo diario. Guardá los cambios.
5. Elegí **Descargar configuración del agente**. El JSON incluye CV y datos personales: queda en tu computadora, no lo subas al repo ni lo compartas.
6. Instalá el agente local siguiendo la sección siguiente.

La app consulta Remotive, Jobicy (hasta 100 resultados), Remote OK, Arbeitnow, UX Jobs y tableros públicos Greenhouse/Lever. El agente local suma Himalayas, Active Vacancies y feeds RSS de We Work Remotely. También ejecuta `agent/public_scraper.py` con Python estándar para seguir hasta 12 anuncios de RSS y extraer datos estructurados `JobPosting` de páginas públicas. No inicia sesión, no evita bloqueos ni resuelve CAPTCHA. Hay boards públicos de Greenhouse/Lever configurables, además de Ashby/Greenhouse/Lever descubiertos al usar búsqueda web opcional. We Work Remotely se consulta con sus RSS de categoría y el feed global. En perfiles de Argentina con modalidad remota, Postula descarta híbridos y ubicaciones restringidas a Reino Unido, EE. UU., Europa y otros mercados; prioriza vacantes globales, Americas y Latinoamérica. Aun así, revisá la ubicación del anuncio antes de postularte.

También puede ampliar la búsqueda a la web con la herramienta `web_search` de OpenAI o, si configurás una clave propia, Brave Search. Cada seis horas hace dos consultas usando tus puestos objetivo, detecta boards públicos de Ashby, Greenhouse y Lever, y revisa páginas de empresas que publican datos estructurados `JobPosting`. Los resultados genéricos del buscador no se guardan como vacantes: se aceptan avisos extraídos del ATS público o de la página oficial del empleo. La fuente original se conserva en cada resultado; UX Jobs y Active Vacancies requieren atribución al mostrar sus avisos.

Para usar OpenAI, primero revisá **ChatGPT → Configuración → Facturación → Créditos de API**. Algunos planes Pro y espacios Business elegibles pueden reclamar créditos de API incluidos; Plus no es elegible para ese beneficio y la disponibilidad depende de la cuenta. ChatGPT/Codex y la API tienen límites de uso separados. Si tenés créditos activos, creá una clave de API y guardala sola en `.postula-agent\openai-api-key.txt` (o definí `OPENAI_API_KEY`). **Desactivá la recarga automática y verificá que el saldo de créditos esté activo**: si no hay créditos, el agente deja de buscar por API y mantiene los feeds públicos gratuitos. La búsqueda de OpenAI tiene costo por consulta y tokens, que se descuentan primero de los créditos disponibles. No guardes la clave en el JSON del perfil, el chat ni GitHub; `.postula-agent` está excluido de Git. Como alternativa, también se admite `.postula-agent\brave-search-api-key.txt`, pero no hace falta usar Brave si OpenAI ya está configurado.

No se automatiza Google Search: Google restringe consultas automatizadas sin permiso expreso, y su Custom Search JSON API ya no admite nuevos clientes ([política de Google](https://developers.google.com/search/docs/essentials/spam-policies), [estado de Custom Search API](https://developers.google.com/custom-search/v1/overview)). Google Jobs puede mostrar avisos como persona desde el navegador, pero esta integración descubre vacantes por la herramienta de búsqueda web y visita páginas de empresas/ATS. Puede encontrar más avisos que los feeds iniciales, aunque ninguna fuente indexa literalmente toda la web. Remotive se consulta como máximo cada seis horas; Jobicy ofrece puestos publicados en los últimos siete días. Las tarjetas **DEMO** son ejemplos, nunca vacantes actuales. El encaje usa TF-IDF y similitud coseno local entre el texto del perfil y cada oferta, más correspondencia del puesto objetivo. No usa un modelo neuronal, API ni tokens; es un ranking orientativo, no una evaluación de contratación. En la web se filtran ofertas remotas y se descartan anuncios con ubicación híbrida o restricciones geográficas identificables. Verificá siempre la elegibilidad en la fuente.

## Instalar y ejecutar el agente local

Requisitos: Node.js 20 o superior y una terminal en la carpeta del repo.

```powershell
npm install
npx playwright install chromium
npm run agent -- "C:\Users\TU_USUARIO\Downloads\postula-agent-config.json"
```

En Windows, guardá el JSON descargado como `.postula-agent\postula-agent-config.json` dentro del repo y abrí `INICIAR_AGENT.bat`. En la ventana nativa **Postula · Agente de escritorio**, elegí **Configurar CV y búsqueda**, cargá PDF/TXT, confirmá los puestos y ubicación, priorizá Argentina/LATAM o elegí solo esas regiones, y definí cada cuántos minutos revisar y tocá **Guardar y buscar ahora**. La frecuencia de búsqueda es independiente del máximo diario de postulaciones; las fuentes aplican caché y límites propios, por lo que no se repiten miles de solicitudes a los sitios. La app extrae el CV localmente y muestra ofertas ordenadas por TF-IDF; **Abrir oferta** abre el aviso o enlace de postulación en tu navegador. El agente de escritorio también recorre fuentes gratuitas con Python y muestra actividad/formularios listos. La ventana permite detener el agente y confirmar cada envío; no registra un formulario abierto como postulación enviada. Chromium funciona oculto; el panel se comunica con el proceso local por `127.0.0.1`. El wordmark y el símbolo vectorial están en `assets/`; `npm run brand:render` regenera el ícono PNG/ICO desde el SVG. Ejecutá `agent\CreateDesktopShortcut.ps1` para crear o actualizar el acceso directo del escritorio.

El agente usa Chromium en segundo plano y vuelve a revisar las ofertas según el intervalo configurado mientras la ventana de escritorio siga abierta. En el primer uso, el navegador crea `.postula-agent/browser-profile`; iniciá sesión allí directamente en los portales donde tengas cuenta. Las contraseñas no se guardan en Postula ni en el JSON; las cookies quedan en ese perfil local del navegador. Si una oferta requiere revisión, **Abrir aviso** la abre en el navegador solo cuando lo pedís.

El agente vuelve a comparar los avisos con tu perfil cada intervalo configurado (1 a 1440 minutos); la consulta web se limita a una vez cada seis horas, y el máximo diario solo limita los envíos. Remotive se cachea seis horas e Himalayas un día; otras fuentes se cachean una hora. Registra las ofertas procesadas en `.postula-agent/results.json` y no vuelve a procesar las excluidas o enviadas aunque aparezcan desde otra fuente. Genera un PDF orientado al puesto y completa campos estándar con datos de tu perfil. El puntaje y la adaptación del CV usan reglas locales: no llaman a OpenAI ni consumen tokens de modelo. Cuando un formulario está completo, el panel muestra la empresa y el puesto: **Confirmar y enviar** autoriza ese envío puntual. Si aparece un CAPTCHA o falta una respuesta, el aviso queda marcado para revisión; usá **Abrir aviso** si querés resolverlo manualmente. El agente no intenta resolver ni esquivar verificaciones. Guarda también los PDFs en `.postula-agent/resumes/`. Para sincronizar estados, abrí **Mi perfil → Importar resultados** y elegí `.postula-agent/results.json`.

## Límites del agente

- Las fuentes públicas no representan literalmente toda la web. Portales privados o sin API pública pueden no aparecer. Los avisos conservan su fuente y enlace de aplicación original; algunas bolsas solo llevan a la página del empleo y no exponen un formulario compatible.
- La adaptación actual destaca el puesto y las competencias encontradas en tu CV, y prioriza bloques de experiencia. Conserva el texto de origen; no inventa datos ni hace una reescritura generativa con IA.
- Antes de cada envío, confirmalo con **Confirmar y enviar** en el panel local, junto al nombre de la empresa y el puesto. El agente se limita a los avisos que pasan el encaje mínimo y al tope de 20 envíos diarios.
- Si un formulario pide un dato ausente, una declaración legal, un CAPTCHA, una verificación o un paso que el agente no reconoce, lo deja pendiente con el enlace y motivo en `results.json`; no vuelve a procesarlo en cada ciclo ni adivina respuestas o evade controles.
- Los formularios cambian por empresa. Revisá el resultado local, especialmente los estados `submitted_unconfirmed` y `needs_attention`.
- El agente funciona en tu computadora, no como tarea de fondo de Vercel. Dejá abierta la app de escritorio y el navegador para que siga buscando cada 30 minutos. Necesita que tu sesión esté iniciada y la PC encendida.

## Desarrollo y despliegue web

El sitio es HTML, CSS y JavaScript estáticos. Vercel publica `main`; el build genera `dist/` e incluye el worker de PDF.js.

```powershell
npm install
$env:POSTULA_AUTH_URL="<Neon Auth URL>"
$env:POSTULA_DATA_API_URL="<Neon Data API URL>"
npm run build
```

En Vercel, configurá el comando `npm run build`, el directorio de salida `dist` y las variables `POSTULA_AUTH_URL` y `POSTULA_DATA_API_URL` para Production. No agregues secretos al repositorio.

La cuenta Postula y sus datos están en Neon. El agente usa una copia local del perfil descargada por la persona usuaria; no recibe la contraseña de Neon ni las claves de portales.

## Licencia

MIT. Ver [LICENSE](LICENSE).
