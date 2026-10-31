# Postula

Postula busca vacantes, las compara con tu CV, prepara una versión orientada al puesto y permite que un agente local complete y envíe solicitudes compatibles.

## Puesta en marcha

1. Iniciá sesión en [Postula](https://postula-iota.vercel.app/) y abrí **Mi perfil**.
2. Importá tu CV en PDF o TXT. La extracción del PDF se hace en el navegador; revisá los datos de contacto y guardá el perfil.
3. Completá los puestos que buscás y agregá los tokens públicos de tus boards Greenhouse o sites Lever.
4. Definí modalidad, encaje mínimo y máximo diario. Guardá los cambios.
5. Elegí **Descargar configuración del agente**. El JSON incluye CV y datos personales: queda en tu computadora, no lo subas al repo ni lo compartas.
6. Instalá el agente local siguiendo la sección siguiente.

La búsqueda en la app también consulta esas fuentes al tocar **Buscar ofertas**. Las tarjetas **DEMO** son ejemplos, nunca vacantes actuales. El encaje usa coincidencias de términos y puestos objetivo; es una señal orientativa, no una evaluación de contratación.

## Instalar y ejecutar el agente local

Requisitos: Node.js 20 o superior y una terminal en la carpeta del repo.

```powershell
npm install
npx playwright install chromium
npm run agent -- "C:\Users\TU_USUARIO\Downloads\postula-agent-config.json"
```

En Windows también podés abrir `INICIAR_AGENT.bat` y pegar o arrastrar el JSON descargado cuando lo pida.

El agente abre Chromium visible y consulta las fuentes cada hora mientras la terminal siga abierta. En el primer uso, el navegador crea `.postula-agent/browser-profile`; iniciá sesión allí directamente en los portales donde tengas cuenta. Las contraseñas no se guardan en Postula ni en el JSON; las cookies quedan en ese perfil local del navegador.

El agente aplica el límite diario y el encaje mínimo configurados. Genera un PDF por vacante, completa campos estándar con datos del perfil y envía el formulario cuando puede resolver todos los campos obligatorios. Guarda el resultado y los PDFs en `.postula-agent/`. Para sincronizar estados, abrí **Mi perfil → Importar resultados** y elegí `.postula-agent/results.json`.

## Límites del agente

- La primera versión consulta boards públicos de Greenhouse y Lever que agregues al perfil; no rastrea toda la web.
- La adaptación actual destaca el puesto y las competencias encontradas en tu CV, y prioriza bloques de experiencia. Conserva el texto de origen; no inventa datos ni hace una reescritura generativa con IA.
- Si un formulario pide un dato ausente, una declaración legal, un CAPTCHA, una verificación o un paso que el agente no reconoce, lo deja pendiente y no adivina la respuesta ni evade el control.
- Los formularios cambian por empresa. Revisá el resultado local, especialmente los estados `submitted_unconfirmed` y `needs_attention`.
- El agente funciona en tu computadora, no como tarea de fondo de Vercel. Dejá abierta la terminal y el navegador para que siga buscando.

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
