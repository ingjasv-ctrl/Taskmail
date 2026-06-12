# TaskMail 📬

Analiza tus correos de Gmail automáticamente con Claude AI y genera una tabla de tareas.

## Archivos del proyecto

```
taskmail/
├── server.js          ← Servidor principal (Node.js + Express)
├── package.json       ← Dependencias
├── .env               ← Variables de entorno (tus credenciales)
└── public/
    └── index.html     ← App web (frontend)
```

## Configuración paso a paso

### 1. Edita el archivo .env con tus credenciales:

```
GOOGLE_CLIENT_ID=     ← Tu Client ID de Google Cloud
GOOGLE_CLIENT_SECRET= ← Tu Client Secret de Google Cloud
ANTHROPIC_API_KEY=    ← Tu API Key de Anthropic (sk-ant-...)
```

### 2. Para probar en tu PC (opcional):
Instala Node.js desde nodejs.org, luego:
```bash
npm install
node server.js
```
Abre http://localhost:3000

### 3. Deploy en Railway (producción):

1. Crea cuenta en railway.app
2. "New Project" → "Deploy from GitHub" (sube los archivos a GitHub primero)
   O usa "New Project" → "Empty project" → arrastra la carpeta
3. En Railway, ve a "Variables" y agrega las mismas variables del .env
4. IMPORTANTE: Cambia GOOGLE_REDIRECT_URI a:
   https://TU-APP.railway.app/auth/callback
5. También agrega esa misma URL en Google Cloud Console →
   Credenciales → Tu cliente OAuth → URIs de redireccionamiento

## Cómo funciona

1. Entras a la app y conectas tu Gmail (una sola vez)
2. El servidor revisa correos nuevos cada 15 minutos automáticamente
3. Claude analiza el cuerpo de cada correo y extrae tareas
4. Las tareas aparecen en la tabla con prioridad, responsable y fecha
5. Puedes cambiar el estado de cada tarea (pendiente/en proceso/completada)
6. Cualquier PC puede acceder a la URL de Railway

## Costo aproximado

- Google Cloud (Gmail API): GRATIS
- Railway: GRATIS (tier hobby, $5/mes si necesitas más)
- Anthropic API: ~$0.003 por correo analizado (muy económico)
