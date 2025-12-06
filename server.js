const express = require('express');
const cors = require('cors');
const pkg = require('whatsapp-web.js');
const { Client, NoAuth, MessageMedia } = pkg;
const qrcode = require('qrcode');
const multer = require('multer');
const fetch = require("node-fetch");

const app = express();

// ----- CORS CONFIG -----
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : ["*"];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true); // allow mobile apps / postman
        if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    }
}));

app.use(express.json());

// Upload handler for send-file
const upload = multer({ storage: multer.memoryStorage() });

// QR data
let qrBase64 = null;
// readiness flag
let isReady = false;

// WhatsApp Client
const client = new Client({
    authStrategy: new NoAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-gpu"
        ]
    }
});

// --- WhatsApp Events ---
client.on("qr", async (qr) => {
    qrBase64 = await qrcode.toDataURL(qr);
    console.log("QR Received");
});

client.on("authenticated", () => {
    console.log("Authenticated");
});

client.on("ready", () => {
  isReady = true;
  qrBase64 = null;
  console.log("WhatsApp is ready!");
});

client.on("auth_failure", (msg) => {
  console.error("Auth failure:", msg);
  isReady = false;
  qrBase64 = null;
});

client.on("disconnected", (reason) => {
  console.log("Client disconnected:", reason);
  isReady = false;
  qrBase64 = null;
});

client.initialize();

// --- ROUTES ---

// 🔹 GET QR (RETURN JSON BASE64)
app.get("/qr", (req, res) => {
    if (!qrBase64) {
        return res.json({ status: false, message: "QR belum tersedia" });
    }

    return res.json({
        status: true,
        qr: qrBase64
    });
});

// 🔹 Check WhatsApp status
app.get("/status", (req, res) => {
    res.json({
        ready: client.info ? true : false,
        info: client.info || null
    });
});

// 🔹 Send text message
app.post("/send", async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message)
    return res.status(400).json({ error: "Missing number or message" });

  // normalize number before sending
  const normalized = normalizeNumber(number);
  if (!normalized)
    return res.status(400).json({ error: "Invalid phone number format" });
  const targetChatId = normalized.includes("@")
    ? normalized
    : `${normalized}@c.us`;

  try {
    if (!client)
      return res
        .status(500)
        .json({ ok: false, error: "Client not initialized" });
    const sent = await client.sendMessage(targetChatId, message);
    res.json({ ok: true, id: sent.id._serialized });
  } catch (err) {
    console.error("send error", err);
    res.status(500).json({ ok: false, error: err.toString() });
  }
});

// 🔹 Send file
app.post("/send-file", upload.single("file"), async (req, res) => {
  // Debug: log headers, body, and file info for troubleshooting
  console.log("--- /send-file request ---");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  if (req.file) {
    console.log("File field:", {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      bufferLength: req.file.buffer ? req.file.buffer.length : null,
    });
  } else {
    console.log("No file uploaded (req.file is undefined)");
  }

  const { number, caption } = req.body;
  if (!number) return res.status(400).json({ error: "Missing number" });

  const normalized = normalizeNumber(number);
  if (!normalized)
    return res.status(400).json({ error: "Invalid phone number format" });
  const targetChatId = normalized.includes("@")
    ? normalized
    : `${normalized}@c.us`;

  if (!client)
    return res.status(500).json({ ok: false, error: "Client not initialized" });
  if (!isReady)
    return res.status(503).json({
      ok: false,
      error: "Client not ready; try again in a few seconds",
    });

  try {
    let buffer = null;
    let mimeType = "application/pdf";
    let filename = "file.pdf";

    if (req.file && req.file.buffer) {
      buffer = req.file.buffer;
      mimeType = req.file.mimetype || mimeType;
      filename = req.file.originalname || filename;
    } else if (req.body.fileBase64) {
      const b64 = req.body.fileBase64;
      const match = /^data:(.+);base64,(.+)$/.exec(b64);
      let base64data = b64;
      if (match) {
        mimeType = match[1] || mimeType;
        base64data = match[2];
      } else if (req.body.mimeType) {
        mimeType = req.body.mimeType;
      }
      buffer = Buffer.from(base64data, "base64");
      if (req.body.filename) filename = req.body.filename;
    } else if (req.body.fileUrl) {
      const resp = await fetch(req.body.fileUrl);
      if (!resp.ok)
        return res.status(400).json({ error: "Failed to fetch file from URL" });
      const arrayBuf = await resp.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
      mimeType = resp.headers.get("content-type") || mimeType;
      const urlParts = req.body.fileUrl.split("/");
      filename = urlParts[urlParts.length - 1] || filename;
    } else {
      return res.status(400).json({
        error:
          "No file provided. Use multipart upload (file), fileBase64, or fileUrl.",
      });
    }

    if (!mimeType || !mimeType.includes("pdf")) {
      return res.status(400).json({
        error: "Only PDF files are allowed (mime-type application/pdf)",
      });
    }

    if (!buffer || buffer.length === 0)
      return res.status(400).json({ error: "Empty file" });

    const media = new MessageMedia(
      mimeType,
      buffer.toString("base64"),
      filename
    );
    console.log("Sending file to", targetChatId, "file:", filename);
    const sent = await client.sendMessage(targetChatId, media, {
      caption: caption || "",
    });
    console.log("File sent successfully:", sent.id._serialized);
    return res.json({ ok: true, id: sent.id._serialized });
  } catch (err) {
    console.error("send-file error:", err.message || err);
    // Common Puppeteer errors that are temporary
    if (err.message && err.message.includes("Evaluation failed")) {
      return res.status(503).json({
        ok: false,
        error: "WhatsApp client evaluation error; try again",
      });
    }
    return res.status(500).json({ ok: false, error: err.toString() });
  }
});

function normalizeNumber(input) {
  if (!input || typeof input !== "string") return null;
  // If already contains @ (chat id), return as-is
  if (input.includes("@")) return input;

  // Remove all non-digit characters, but keep leading + for detection
  const cleaned = input.trim();
  // remove spaces, dashes, parentheses
  let digits = cleaned.replace(/[^+0-9]/g, "");
  if (!digits) return null;

  // Remove leading plus
  if (digits.startsWith("+")) digits = digits.slice(1);

  // If starts with 0, replace with country code 62 (Indonesia)
  if (digits.startsWith("0")) {
    digits = "62" + digits.slice(1);
  }

  // Basic validation: must be at least 8 digits after normalization
  const onlyDigits = digits.replace(/\D/g, "");
  if (onlyDigits.length < 8) return null;

  return onlyDigits;
}

app.listen(5000, () => {
    console.log("Server running on port 5000");
});
