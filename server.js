import express from "express";
import cors from "cors";
import { Client, NoAuth, MessageMedia } from "whatsapp-web.js";
import qrcode from "qrcode";
import multer from "multer";

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
    console.log("WhatsApp is ready!");
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
    try {
        const { number, message } = req.body;

        await client.sendMessage(number + "@c.us", message);

        res.json({ status: true, message: "Pesan terkirim" });
    } catch (error) {
        res.json({ status: false, error: error.toString() });
    }
});

// 🔹 Send file
app.post("/send-file", upload.single("file"), async (req, res) => {
    try {
        const { number, caption } = req.body;

        if (!req.file) {
            return res.json({ status: false, error: "File tidak ditemukan" });
        }

        const media = new MessageMedia(
            req.file.mimetype,
            req.file.buffer.toString("base64"),
            req.file.originalname
        );

        await client.sendMessage(number + "@c.us", media, {
            caption: caption || ""
        });

        res.json({ status: true, message: "File terkirim" });
    } catch (error) {
        res.json({ status: false, error: error.toString() });
    }
});

app.listen(5000, () => {
    console.log("Server running on port 5000");
});
