# Postula

**Encontrá mejores oportunidades. Prepará cada candidatura con tu experiencia real.**

Postula es una pequeña app web en español para reunir ofertas públicas, comparar requisitos, preparar un CV por puesto y seguir tus postulaciones.

## Probarla

- **Modo local:** abrí `INICIAR.bat` o `index.html` y elegí “Usar Postula en este dispositivo”. Los datos quedan en ese navegador.
- **Modo con cuenta:** requiere Neon Auth + Data API. Seguí “Conectar Neon” más abajo; el login no queda activo hasta configurar esas URLs.
- **En Vercel:** cada push a `main` publica automáticamente una versión. Para usar Neon, configurá `npm run build` y `dist` como se explica abajo.

## Primeros pasos

1. En **Mi perfil**, cargá contacto, objetivos, experiencia y habilidades.
2. En **Fuentes para búsqueda en vivo**, agregá nombres públicos de boards Greenhouse o sites Lever.
3. Tocá **Buscar ofertas** y revisá encaje, requisitos y fuente.
4. Abrí una oferta, revisá y autorizá la candidatura. Postula descarga el CV adaptado y abre la página de empleo para continuar allí.

También se puede explorar la interfaz con ejemplos marcados **DEMO**. No son vacantes vigentes.

## Qué puede hacer

- Consultar feeds públicos de Greenhouse y Lever.
- Filtrar y guardar ofertas.
- Comparar términos del perfil con los requisitos y mostrar una coincidencia orientativa.
- Reorganizar la información aportada para generar una vista previa y descargar un CV en texto por oferta.
- Abrir el portal de empleo de la empresa y registrar el estado de seguimiento.

## Qué no hace

Esta versión no inicia sesión ni completa o envía formularios de terceros. Los portales usan preguntas, controles y reglas distintas; las credenciales se introducen directamente en el sitio de la empresa. LinkedIn e Indeed restringen bots de terceros. No se eluden CAPTCHAs ni controles de acceso.

El porcentaje de encaje es orientativo, basado en coincidencias de texto. Revisá el CV, las respuestas y la publicación antes de postularte.

## Privacidad

En modo local, perfil, preferencias y seguimiento quedan en `localStorage`. Al configurar la cuenta Neon, el perfil, las ofertas guardadas y las postulaciones se sincronizan en Postgres con políticas RLS por usuario. La identidad y las sesiones las administra Neon Auth. No guardes aquí contraseñas de LinkedIn, Greenhouse, Lever ni otros portales. El código del repositorio es público; no agregues `.env` ni datos personales al repositorio.

## Publicar en Vercel o Netlify

El código ya está en GitHub. En cualquiera de los proveedores:

1. Elegí **Add New Project / Add a site → Import from GitHub** y autorizá el repositorio `Ignacio918/Postula`.
2. Configurá el proyecto con directorio raíz `.`. Para la versión básica sin cuenta, podés dejar vacíos el comando de build y el directorio de salida.
3. Publicá y abrí la URL temporal que te da el proveedor. Para conectar Neon, configurá las variables de entorno y el build antes de publicar, o redeplegá después de agregarlos.

El sitio usa HTML, CSS y JavaScript y tiene `index.html` en la raíz. Si vas a usar Neon, seguí los pasos y el build indicados más abajo para generar el `config.js` público con los endpoints de Neon. Para búsqueda en vivo, abrilo desde el dominio de Vercel/Netlify o desde un servidor local, no desde `file://`.

## Conectar Neon (una vez)

1. Creá la base Neon desde la integración de Vercel y vinculala al proyecto `postula`.
2. En Neon abrí **Better Auth → Configure Auth**, agregá el dominio de producción a trusted domains y dejá habilitado el acceso por email/contraseña.
3. En **Data API**, habilitala para `main`. La integración de Vercel agrega `NEON_AUTH_BASE_URL` y `NEON_DATA_API_URL` cuando los servicios están habilitados.
4. En **SQL Editor**, ejecutá el contenido de [`neon/schema.sql`](neon/schema.sql). Esta tabla usa RLS para que cada persona solo lea y escriba su propia fila.
5. En **Vercel → Postula → Settings → Environment Variables**, agregá:

   - Preferentemente, usá las variables que agrega la integración: `NEON_AUTH_BASE_URL` y `NEON_DATA_API_URL`.
   - También se aceptan `POSTULA_AUTH_URL` y `POSTULA_DATA_API_URL` si las querés cargar manualmente con los valores de Neon.

   Marcá **Production**, **Preview** y **Development** según dónde vayas a probarlo. El build genera `config.js` dentro de `dist/` a partir de esas variables; el archivo está ignorado por Git y solo contiene URLs públicas del proyecto.
6. Configurá Vercel **Build Command** `npm run build` y **Output Directory** `dist`. Guardá y hacé **Redeploy**. No publiques el directorio raíz si querés login: ahí no se genera el `config.js` con Neon.
7. Abrí el sitio. Tocá **Crear cuenta**, registrate con tu email y contraseña de Postula, y cargá el perfil. Al primer ingreso, Postula intentará importar el perfil local de ese navegador.

El cliente solo recibe endpoints públicos de Neon, nunca una contraseña de base ni un token de administrador. La seguridad del perfil depende de las políticas RLS de [`neon/schema.sql`](neon/schema.sql); ejecutalas antes de cargar datos reales. La cuenta de Postula es distinta de tus credenciales de portales de empleo.

### Protección del sitio público

Vercel **Deployment Protection → All Deployments** puede restringir producción a miembros del equipo que tengan una cuenta Vercel. En Hobby puede variar la disponibilidad del alcance de producción. Esta barrera es aparte del login de Postula y no sirve para dar acceso fácil a otros usuarios. El login de Postula más RLS protege cada perfil aunque la página sea pública.

## Ejecutar un servidor local opcional

Desde esta carpeta, ejecutá:

```powershell
python -m http.server 8000
```

Después abrí <http://localhost:8000>. El servidor local evita restricciones que algunos navegadores aplican a llamadas de red desde `file://`.

## Tecnología

HTML, CSS y JavaScript nativos; SDK oficial `@neon/neon-js` cargado como módulo ESM. La app estática requiere hosting HTTPS y acceso de red para Neon Auth/Data API.

## Licencia

MIT. Ver [LICENSE](LICENSE).
