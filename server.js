import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Groq } from 'groq-sdk';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 1. Security Headers (XSS, Clickjacking ကာကွယ်ရန်)
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"], // လိုအပ်ပါက Nonce သို့မဟုတ် Hash ဖြင့် အစားထိုးပါ
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https:"],
            },
        },
    })
);

// 2. DoS ကာကွယ်ရန် Payload Size Limit သတ်မှတ်ခြင်း (10kb ထက်ကြီးသော Data ပိတ်မည်)
app.use(express.json({ limit: '10kb' }));

// 3. CORS Configuration
app.use(cors());

// 4. Rate Limiting (DoS Attack / API Abuse ကာကွယ်ရန်)
const chatRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // ၁၅ မိနစ်
    max: 30, // IP တစ်ခုလျှင် ၁၅ မိနစ်အတွင်း အကြိမ် ၃၀ သာ စာပို့ခွင့်ပြုမည်
    message: { reply: "Request အကြိမ်ရေ များလွန်းပါသည်။ ခဏစောင့်ပြီးမှ ပြန်လည် ကြိုးစားပါ။" },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(express.static(path.join(__dirname, 'public')));

// Environment Variables စစ်ဆေးခြင်း
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const INDEX_NAME = 'pofolio-index';

// 5. MongoDB Connection
mongoose.connect(process.env.MONGO_URI_PORFO)
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.log('MongoDB Connection Error:', err.message));

const Chat = mongoose.model('Chat', new mongoose.Schema({
    user: { type: String, default: 'Anonymous' },
    message: { type: String, required: true },
    botReply: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
}));

// Groq Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 6. API Chat Route (Rate Limiter တပ်ဆင်ထားသည်)
app.post('/api/chat', chatRateLimiter, async (req, res) => {
    const { message, user } = req.body;

    // Input Type & Empty Check Validation
    if (!message || typeof message !== 'string' || message.trim() === "") {
        return res.status(400).json({ reply: "Please provide a valid message." });
    }

    // မလိုလားအပ်ဘဲ စာသား အရှည်ကြီး ပို့ခြင်းကို ကန့်သတ်ခြင်း (DoS Protection)
    if (message.length > 1000) {
        return res.status(400).json({ reply: "Message length exceeds the limit of 1000 characters." });
    }

    const sanitizedMessage = message.trim();
    const sanitizedUser = typeof user === 'string' && user.trim() !== "" ? user.trim().slice(0, 50) : "Guest";

    try {
        // --- အဆင့် (၁): Vector ပြောင်းခြင်း ---
        const embeddingResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text: sanitizedMessage })
        });
        
        const embeddingData = await embeddingResponse.json();
        if (!embeddingData.success) {
            console.error("Embedding Error:", embeddingData.errors);
            return res.status(500).json({ reply: "Vector ပြောင်းခြင်း မအောင်မြင်ပါ။" });
        }
        const queryVector = embeddingData.result.data[0];

        // --- အဆင့် (၂): Vectorize Query ---
        const vectorizeResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                vector: queryVector,
                topK: 3,
                returnMetadata: "all",
                returnVectors: false   
            })
        });

        const vectorizeData = await vectorizeResponse.json();
        if (!vectorizeData.success) {
            console.error("Vectorize Error:", vectorizeData.errors);
            return res.status(500).json({ reply: "Database တွင် ရှာဖွေခြင်း မအောင်မြင်ပါ။" });
        }

        // --- အဆင့် (၃): Context စုစည်းခြင်း ---
        let companyContext = "";
        if (vectorizeData.result?.matches?.length > 0) {
            companyContext = vectorizeData.result.matches
                .map((match) => match.metadata?.content || "")
                .filter(Boolean)
                .join('\n\n');
        } else {
            companyContext = "မည်သည့် အချက်အလက်မှ ရှာမတွေ့ပါ။";
        }

        // --- အဆင့် (၄): Groq Chat Completions ---
        const chatCompletion = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [
                {
                    role: "system",
                    content: `You are a helpful, professional customer support bot for AI Automation & Agent Solutions. Answer based ONLY on the following company information in Burmese. If not found, say you don't know.\n\nCompany Information:\n${companyContext}`
                },
                {
                    role: "user",
                    content: sanitizedMessage
                }
            ],
            temperature: 0.3,
            max_completion_tokens: 2048,
            top_p: 1,
            stream: false
        });

        const botReply = chatCompletion.choices[0]?.message?.content || "No response generated.";

        // --- အဆင့် (၅): MongoDB သိမ်းဆည်းခြင်း ---
        const newChat = new Chat({ 
            user: sanitizedUser, 
            message: sanitizedMessage, 
            botReply 
        });
        await newChat.save();

        res.json({ reply: botReply });
    } catch (error) {
        console.error("Chat API Internal Error:", error.message);
        res.status(500).json({ reply: "Sorry, I am facing some technical issues right now." });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pofolio.html'));
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => {
    console.log(`Server is running securely on port ${PORT}`);
});