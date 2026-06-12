require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Clientes API ─────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "taskmail_secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 días
}));

// ── Estado en memoria ─────────────────────────────────────────
// En producción esto se reemplazaría con una base de datos
const store = {
  tasks: [],        // todas las tareas generadas
  lastSync: null,   // fecha de última sincronización
  tokens: null,     // tokens OAuth de Google
  processedIds: new Set() // IDs de correos ya procesados
};

// ── Helpers de Gmail ──────────────────────────────────────────
async function getGmailMessages(auth) {
  const gmail = google.gmail({ version: "v1", auth });

  // Traer últimos 20 correos no procesados
  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: 20,
    q: "in:inbox"
  });

  const messages = listRes.data.messages || [];
  const newMessages = messages.filter(m => !store.processedIds.has(m.id));
  return { gmail, newMessages };
}

async function getEmailContent(gmail, messageId) {
  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full"
  });

  const headers = msg.data.payload.headers;
  const subject = headers.find(h => h.name === "Subject")?.value || "(Sin asunto)";
  const from = headers.find(h => h.name === "From")?.value || "Desconocido";
  const date = headers.find(h => h.name === "Date")?.value || "";

  // Extraer cuerpo del correo
  let body = "";
  const extractBody = (part) => {
    if (part.mimeType === "text/plain" && part.body?.data) {
      body += Buffer.from(part.body.data, "base64").toString("utf-8");
    }
    if (part.parts) part.parts.forEach(extractBody);
  };

  if (msg.data.payload.parts) {
    msg.data.payload.parts.forEach(extractBody);
  } else if (msg.data.payload.body?.data) {
    body = Buffer.from(msg.data.payload.body.data, "base64").toString("utf-8");
  }

  return { id: messageId, subject, from, date, body: body.trim() };
}

// ── Claude: analizar correo y extraer tareas ──────────────────
async function analyzeEmailWithClaude(email) {
  if (!email.body || email.body.length < 10) return [];

  const prompt = `Analiza el siguiente correo electrónico y extrae TODAS las tareas, solicitudes, pendientes o acciones requeridas que menciona.

CORREO:
De: ${email.from}
Asunto: ${email.subject}
Fecha: ${email.date}
Cuerpo:
${email.body}

Responde ÚNICAMENTE con un array JSON con este formato exacto (sin texto adicional, sin markdown):
[
  {
    "tarea": "descripción clara de la tarea",
    "prioridad": "alta" | "media" | "baja",
    "responsable": "nombre si se menciona, si no: 'Por asignar'",
    "fechaLimite": "fecha si se menciona, si no: 'Sin fecha'",
    "estado": "pendiente"
  }
]

Si el correo no contiene ninguna tarea o solicitud concreta, responde con un array vacío: []

Criterios de prioridad:
- alta: palabras como urgente, inmediato, hoy, ASAP, crítico, antes de [fecha próxima]
- media: esta semana, pronto, cuando puedas
- baja: sin urgencia, informativo, a futuro`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const tasks = JSON.parse(clean);

    // Agregar metadata del correo a cada tarea
    return tasks.map(t => ({
      ...t,
      id: `${email.id}_${Math.random().toString(36).substr(2, 6)}`,
      emailId: email.id,
      emailSubject: email.subject,
      emailFrom: email.from,
      emailDate: email.date,
      creadoEn: new Date().toISOString()
    }));
  } catch (err) {
    console.error(`Error analizando correo ${email.id}:`, err.message);
    return [];
  }
}

// ── Proceso principal de sincronización ──────────────────────
async function syncGmail() {
  if (!store.tokens) {
    console.log("⚠️  Sin tokens de Gmail. El usuario debe autenticarse primero.");
    return { success: false, message: "No autenticado" };
  }

  try {
    oauth2Client.setCredentials(store.tokens);
    const { gmail, newMessages } = await getGmailMessages(oauth2Client);

    if (newMessages.length === 0) {
      store.lastSync = new Date().toISOString();
      console.log("✅ Sync completado — sin correos nuevos");
      return { success: true, newTasks: 0 };
    }

    console.log(`📬 Procesando ${newMessages.length} correos nuevos...`);
    let totalNewTasks = 0;

    for (const msg of newMessages) {
      const email = await getEmailContent(gmail, msg.id);
      const tasks = await analyzeEmailWithClaude(email);

      if (tasks.length > 0) {
        store.tasks.unshift(...tasks); // agregar al inicio
        totalNewTasks += tasks.length;
        console.log(`  ✉️  "${email.subject}" → ${tasks.length} tarea(s)`);
      }

      store.processedIds.add(msg.id);
    }

    store.lastSync = new Date().toISOString();
    console.log(`✅ Sync completo — ${totalNewTasks} tareas nuevas generadas`);
    return { success: true, newTasks: totalNewTasks };

  } catch (err) {
    console.error("❌ Error en sync:", err.message);
    return { success: false, message: err.message };
  }
}

// ── CRON: cada 15 minutos ─────────────────────────────────────
cron.schedule("*/15 * * * *", () => {
  console.log("⏰ Sincronización automática iniciada...");
  syncGmail();
});

// ════════════════════════════════════════════════════════════
//  RUTAS
// ════════════════════════════════════════════════════════════

// ── Auth: iniciar login con Google ───────────────────────────
app.get("/auth/login", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    prompt: "consent"
  });
  res.redirect(url);
});

// ── Auth: callback de Google ──────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    store.tokens = tokens;
    req.session.authenticated = true;
    console.log("✅ Usuario autenticado con Gmail");

    // Hacer sync inicial inmediatamente
    await syncGmail();
    res.redirect("/");
  } catch (err) {
    console.error("Error en callback:", err);
    res.redirect("/?error=auth_failed");
  }
});

// ── Auth: estado ──────────────────────────────────────────────
app.get("/api/auth/status", (req, res) => {
  res.json({
    authenticated: !!store.tokens,
    lastSync: store.lastSync
  });
});

// ── API: obtener tareas ───────────────────────────────────────
app.get("/api/tasks", (req, res) => {
  const { estado, prioridad } = req.query;
  let tasks = [...store.tasks];

  if (estado) tasks = tasks.filter(t => t.estado === estado);
  if (prioridad) tasks = tasks.filter(t => t.prioridad === prioridad);

  res.json({
    tasks,
    total: store.tasks.length,
    lastSync: store.lastSync
  });
});

// ── API: actualizar estado de tarea ──────────────────────────
app.patch("/api/tasks/:id", (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  const task = store.tasks.find(t => t.id === id);

  if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

  task.estado = estado;
  res.json({ success: true, task });
});

// ── API: sincronizar manualmente ─────────────────────────────
app.post("/api/sync", async (req, res) => {
  const result = await syncGmail();
  res.json(result);
});

// ── API: estadísticas ─────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const tasks = store.tasks;
  res.json({
    total: tasks.length,
    pendientes: tasks.filter(t => t.estado === "pendiente").length,
    enProceso: tasks.filter(t => t.estado === "en proceso").length,
    completadas: tasks.filter(t => t.estado === "completada").length,
    alta: tasks.filter(t => t.prioridad === "alta").length,
    media: tasks.filter(t => t.prioridad === "media").length,
    baja: tasks.filter(t => t.prioridad === "baja").length,
    lastSync: store.lastSync
  });
});

// ── Servir app frontend ───────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Iniciar servidor ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 TaskMail corriendo en http://localhost:${PORT}`);
  console.log(`📋 Sincronización automática: cada 15 minutos`);
  console.log(`🔑 Para autenticar Gmail visita: http://localhost:${PORT}/auth/login\n`);
});
