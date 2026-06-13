require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Redis opcional ────────────────────────────────────────────
let RedisStore, redisClient;
async function setupRedis() {
  if (!process.env.REDIS_URL) return false;
  try {
    const { createClient } = require("redis");
    const connectRedis = require("connect-redis");
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on("error", (e) => console.error("Redis error:", e.message));
    await redisClient.connect();
    RedisStore = connectRedis(session);
    console.log("✅ Redis conectado");
    return true;
  } catch (e) {
    console.error("Redis no disponible, usando memoria:", e.message);
    return false;
  }
}

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Accounts store (en memoria + respaldo Redis manual) ───────
const accounts = {};

function getAccount(email) {
  if (!accounts[email]) {
    accounts[email] = { tokens: null, tasks: [], lastSync: null, processedIds: new Set() };
  }
  return accounts[email];
}

// Persistir tokens en Redis
async function saveTokens(email, tokens) {
  if (!redisClient) return;
  try {
    await redisClient.set(`tokens:${email}`, JSON.stringify(tokens), { EX: 30 * 24 * 3600 });
  } catch(e) {}
}

async function loadAllTokens() {
  if (!redisClient) return;
  try {
    const keys = await redisClient.keys("tokens:*");
    for (const key of keys) {
      const email = key.replace("tokens:", "");
      const raw = await redisClient.get(key);
      if (raw) {
        const tokens = JSON.parse(raw);
        getAccount(email).tokens = tokens;
        console.log(`🔑 Tokens cargados para: ${email}`);
      }
    }
  } catch(e) { console.error("Error cargando tokens:", e.message); }
}

// ── Gmail helpers ─────────────────────────────────────────────
async function getGmailMessages(auth, account) {
  const gmail = google.gmail({ version: "v1", auth });
  const listRes = await gmail.users.messages.list({ userId: "me", maxResults: 20, q: "in:inbox" });
  const messages = listRes.data.messages || [];
  return { gmail, newMessages: messages.filter(m => !account.processedIds.has(m.id)) };
}

async function getEmailContent(gmail, messageId) {
  const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = msg.data.payload.headers;
  const subject = headers.find(h => h.name === "Subject")?.value || "(Sin asunto)";
  const from = headers.find(h => h.name === "From")?.value || "Desconocido";
  const date = headers.find(h => h.name === "Date")?.value || "";
  let body = "";
  const extractBody = (part) => {
    if (part.mimeType === "text/plain" && part.body?.data)
      body += Buffer.from(part.body.data, "base64").toString("utf-8");
    if (part.parts) part.parts.forEach(extractBody);
  };
  if (msg.data.payload.parts) msg.data.payload.parts.forEach(extractBody);
  else if (msg.data.payload.body?.data)
    body = Buffer.from(msg.data.payload.body.data, "base64").toString("utf-8");
  return { id: messageId, subject, from, date, body: body.trim() };
}

async function analyzeEmailWithClaude(email) {
  if (!email.body || email.body.length < 10) return [];
  const prompt = `Analiza el siguiente correo y extrae TODAS las tareas, solicitudes o acciones requeridas.

CORREO:
De: ${email.from}
Asunto: ${email.subject}
Fecha: ${email.date}
Cuerpo:
${email.body}

Responde ÚNICAMENTE con array JSON (sin texto ni markdown):
[{"tarea":"descripción","prioridad":"alta|media|baja","responsable":"nombre o Por asignar","fechaLimite":"fecha o Sin fecha","estado":"pendiente"}]
Si no hay tareas: []
Prioridad: alta=urgente/hoy/ASAP, media=esta semana, baja=sin urgencia`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });
    const clean = response.content[0].text.trim().replace(/```json|```/g, "").trim();
    return JSON.parse(clean).map(t => ({
      ...t,
      id: `${email.id}_${Math.random().toString(36).substr(2, 6)}`,
      emailId: email.id, emailSubject: email.subject,
      emailFrom: email.from, emailDate: email.date,
      creadoEn: new Date().toISOString()
    }));
  } catch (err) {
    console.error(`Error analizando ${email.id}:`, err.message);
    return [];
  }
}

async function syncAccount(email) {
  const account = getAccount(email);
  if (!account.tokens) return { success: false, message: "No autenticado" };
  try {
    const auth = createOAuthClient();
    auth.setCredentials(account.tokens);
    auth.on("tokens", async (tokens) => {
      if (tokens.refresh_token) account.tokens.refresh_token = tokens.refresh_token;
      account.tokens.access_token = tokens.access_token;
      await saveTokens(email, account.tokens);
    });
    const { gmail, newMessages } = await getGmailMessages(auth, account);
    if (newMessages.length === 0) {
      account.lastSync = new Date().toISOString();
      return { success: true, newTasks: 0 };
    }
    let totalNewTasks = 0;
    for (const msg of newMessages) {
      const emailContent = await getEmailContent(gmail, msg.id);
      const tasks = await analyzeEmailWithClaude(emailContent);
      if (tasks.length > 0) { account.tasks.unshift(...tasks); totalNewTasks += tasks.length; }
      account.processedIds.add(msg.id);
    }
    account.lastSync = new Date().toISOString();
    console.log(`✅ [${email}] ${totalNewTasks} tareas nuevas`);
    return { success: true, newTasks: totalNewTasks };
  } catch (err) {
    console.error(`❌ Error sync [${email}]:`, err.message);
    return { success: false, message: err.message };
  }
}

cron.schedule("*/15 * * * *", () => {
  const emails = Object.keys(accounts).filter(e => accounts[e].tokens);
  if (emails.length) { console.log(`⏰ Auto-sync ${emails.length} cuenta(s)`); emails.forEach(syncAccount); }
});

// ══════════════════════════════════════════════════════════════
//  RUTAS
// ══════════════════════════════════════════════════════════════

app.get("/auth/login", (req, res) => {
  const oauth2Client = createOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/userinfo.email"],
    prompt: "consent"
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;
    const account = getAccount(email);
    account.tokens = tokens;
    await saveTokens(email, tokens);
    req.session.email = email;
    req.session.authenticated = true;
    console.log(`✅ Autenticado: ${email}`);
    await syncAccount(email);
    res.redirect("/");
  } catch (err) {
    console.error("Error callback:", err.message);
    res.redirect("/?error=auth_failed");
  }
});

app.get("/api/auth/status", (req, res) => {
  const email = req.session.email;
  if (!email || !accounts[email]?.tokens) return res.json({ authenticated: false });
  res.json({ authenticated: true, email, lastSync: accounts[email].lastSync });
});

app.get("/api/accounts", (req, res) => {
  const list = Object.entries(accounts)
    .filter(([, a]) => a.tokens)
    .map(([email, a]) => ({
      email, lastSync: a.lastSync,
      totalTasks: a.tasks.length,
      pendientes: a.tasks.filter(t => t.estado === "pendiente").length
    }));
  res.json({ accounts: list });
});

app.post("/api/accounts/switch", (req, res) => {
  const { email } = req.body;
  if (!accounts[email]?.tokens) return res.status(404).json({ error: "Cuenta no encontrada" });
  req.session.email = email;
  res.json({ success: true, email });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/tasks", (req, res) => {
  const email = req.session.email;
  if (!email || !accounts[email]) return res.json({ tasks: [], total: 0 });
  const { estado, prioridad } = req.query;
  let tasks = [...accounts[email].tasks];
  if (estado) tasks = tasks.filter(t => t.estado === estado);
  if (prioridad) tasks = tasks.filter(t => t.prioridad === prioridad);
  res.json({ tasks, total: accounts[email].tasks.length, lastSync: accounts[email].lastSync });
});

app.patch("/api/tasks/:id", (req, res) => {
  const email = req.session.email;
  if (!email || !accounts[email]) return res.status(401).json({ error: "No autenticado" });
  const task = accounts[email].tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Tarea no encontrada" });
  task.estado = req.body.estado;
  res.json({ success: true, task });
});

app.post("/api/sync", async (req, res) => {
  const email = req.session.email;
  if (!email) return res.json({ success: false, message: "No autenticado" });
  const result = await syncAccount(email);
  res.json(result);
});

app.get("/api/stats", (req, res) => {
  const email = req.session.email;
  if (!email || !accounts[email]) return res.json({ total:0,pendientes:0,enProceso:0,completadas:0,alta:0,media:0,baja:0 });
  const tasks = accounts[email].tasks;
  res.json({
    total: tasks.length,
    pendientes: tasks.filter(t => t.estado === "pendiente").length,
    enProceso: tasks.filter(t => t.estado === "en proceso").length,
    completadas: tasks.filter(t => t.estado === "completada").length,
    alta: tasks.filter(t => t.prioridad === "alta").length,
    media: tasks.filter(t => t.prioridad === "media").length,
    baja: tasks.filter(t => t.prioridad === "baja").length,
    lastSync: accounts[email].lastSync
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Arrancar ──────────────────────────────────────────────────
async function start() {
  const redisOk = await setupRedis();

  let sessionStore = undefined;
  if (redisOk && RedisStore) {
    sessionStore = new RedisStore({ client: redisClient });
  }

  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "taskmail_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
  }));

  if (redisOk) await loadAllTokens();

  app.listen(PORT, () => {
    console.log(`\n🚀 TaskMail Multi-cuenta en http://localhost:${PORT}`);
    console.log(`💾 Persistencia: ${redisOk ? "Redis ✅" : "Memoria ⚠️"}\n`);
  });
}

start();
