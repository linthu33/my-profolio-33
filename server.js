import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
// fs (file system) ကို မသုံးတော့သဖြင့် ဖယ်ရှားလိုက်ပါသည်
import { Groq } from 'groq-sdk'; 

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Cloudflare Credentials (သင့်အချက်အလက်များ ပြင်ထည့်ပါ သို့မဟုတ် .env တွင် ထည့်ပါ)
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const INDEX_NAME = 'pofolio-index';

// 1. MongoDB Connection
mongoose.connect(process.env.MONGO_URI_PORFO)
    .then(() => console.log('MongoDB Connected...'))
    .catch(err => console.log('MongoDB Error:', err));

const Chat = mongoose.model('Chat', new mongoose.Schema({
    user: String, message: String, botReply: String, timestamp: { type: Date, default: Date.now }
}));

// 2. Groq Client Initialize လုပ်ခြင်း
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 3. API Chat Route (Vectorize + Groq LLM)
app.post('/api/chat', async (req, res) => {
    const { message, user } = req.body;

    // User မေးခွန်း အလွတ်ဖြစ်နေပါက တားဆီးရန်
    if (!message || message.trim() === "") {
        return res.status(400).json({ reply: "Please provide a valid message." });
    }

    try {
        // --- အဆင့် (၁): မေးခွန်းကို Vector ပြောင်းခြင်း ---
        const embeddingResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text: message })
        });
        
        const embeddingData = await embeddingResponse.json();
        if (!embeddingData.success) {
            console.error("Embedding Error:", embeddingData.errors);
            return res.status(500).json({ reply: "Vector ပြောင်းခြင်း မအောင်မြင်ပါ။" });
        }
        const queryVector = embeddingData.result.data[0];

        // --- အဆင့် (၂): Vectorize တွင် ဆင်တူသော Data ကို ရှာဖွေခြင်း ---
        const vectorizeResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                vector: queryVector,
                topK: 3, // အနီးစပ်ဆုံး ၃ ခုကိုသာ ယူမည်
                returnMetadata: "all",
                returnVectors: false   
            })
        });

        const vectorizeData = await vectorizeResponse.json();
        if (!vectorizeData.success) {
            console.error("Vectorize Error:", vectorizeData.errors);
            return res.status(500).json({ reply: "Database တွင် ရှာဖွေခြင်း မအောင်မြင်ပါ။" });
        }

        // --- အဆင့် (၃): ရရှိလာသော Data များကို စာသား (Context) အဖြစ် စုစည်းခြင်း ---
        let companyContext = "";
        if (vectorizeData.result.matches && vectorizeData.result.matches.length > 0) {
            companyContext = vectorizeData.result.matches
                .map((match) => match.metadata.content)
                .join('\n\n');
        } else {
            companyContext = "မည်သည့် အချက်အလက်မှ ရှာမတွေ့ပါ။";
        }

        // --- အဆင့် (၄): Groq Chat Completions သို့ Vectorize မှ အချက်အလက်များ ထည့်ပေးခြင်း ---
        const chatCompletion = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b", // လက်ရှိ အလုပ်လုပ်သော Groq Model ကို အသုံးပြုထားပါသည်
            messages: [
                {
                    role: "system",
                    content: `You are a helpful, professional customer support bot for AI Automation & Agent Solutions. Answer based ONLY on the following company information in Burmese. If not found, say you don't know.\n\nCompany Information:\n${companyContext}`
                },
                {
                    role: "user",
                    content: message
                }
            ],
            temperature: 0.3,
            max_completion_tokens: 2048,
            top_p: 1,
            stream: false // Streaming အစား တစ်ခါတည်း အပြည့်အစုံယူရန် 
        });

        const botReply = chatCompletion.choices[0]?.message?.content || "No response generated.";

        // --- အဆင့် (၅): MongoDB တွင် သိမ်းဆည်းခြင်း ---
        const newChat = new Chat({ user: user || 'Anonymous', message, botReply });
        await newChat.save();

        res.json({ reply: botReply });
    } catch (error) {
        console.error("Chat Error:", error);
        res.status(500).json({ reply: "Sorry, I am facing some technical issues right now." });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pofolio.html'));
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});