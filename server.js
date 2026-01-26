// ================= IMPORTS =================
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mineflayer = require('mineflayer');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { status } = require('minecraft-server-util');
require('dotenv').config();

const app = express();

// ================= MIDDLEWARE =================
app.use(cors({
    origin: 'https://uzbsmp.uz',
    methods: ['GET','POST','PUT','DELETE'],
    credentials: true
}));
app.use(bodyParser.json());
app.use(express.static('public'));

// ================= POSTGRESQL =================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password TEXT NOT NULL,
                coins INTEGER DEFAULT 0,
                rank VARCHAR(20) DEFAULT 'PLAYER',
                ban_until TIMESTAMP
            );
            
            CREATE TABLE IF NOT EXISTS pending_items (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                item VARCHAR(100) NOT NULL,
                amount INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS promocodes (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                coins INTEGER NOT NULL,
                expire_date DATE
            );

            CREATE TABLE IF NOT EXISTS redeem_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                promo_id INTEGER REFERENCES promocodes(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('PostgreSQL: tablelar tayyor');
    } catch (err) {
        console.error('DB init xatosi:', err);
        process.exit(1);
    }
}

// ================= MINECRAFT BOT =================
let bot = null;
const onlinePlayers = new Set();

function createBot() {
    if (bot) {
        try { bot.removeAllListeners(); bot.quit(); } catch {}
        bot = null;
        onlinePlayers.clear();
    }

    bot = mineflayer.createBot({
        host: 'mc.uzbsmp.uz',
        port: 25705,
        username: 'QQjon',
        version: '1.20.1'
    });

    bot.on('end', () => setTimeout(createBot, 5000));
    bot.on('error', err => console.error('Bot xato:', err));

    bot.on('playerJoined', async (player) => {
        onlinePlayers.add(player.username);
        try {
            const res = await pool.query(
                'SELECT item, amount FROM pending_items WHERE username=$1',
                [player.username]
            );
            for (const row of res.rows) {
                bot.chat(`/give ${player.username} minecraft:${row.item} ${row.amount}`);
            }
            await pool.query('DELETE FROM pending_items WHERE username=$1', [player.username]);
        } catch (err) {
            console.error(err);
        }
    });

    bot.on('playerLeft', (player) => {
        onlinePlayers.delete(player.username);
    });
}
createBot();

// ================= AUTH =================
const JWT_SECRET = process.env.JWT_SECRET;

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username va password kerak' });

    const hash = await bcrypt.hash(password, 10);
    try {
        await pool.query(
            'INSERT INTO users (username, password, coins, rank) VALUES ($1,$2,$3,$4)',
            [username, hash, 100, 'PLAYER']
        );
        res.json({ success: true, message: 'Ro‘yxatdan o‘tildi' });
    } catch {
        res.status(400).json({ success: false, message: 'Username mavjud' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: 'Username va password kerak' });

    try {
        const userRes = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
        if (userRes.rows.length === 0) return res.json({ success: false, message: 'Username yoki parol noto‘g‘ri' });

        const user = userRes.rows[0];
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.json({ success: false, message: 'Username yoki parol noto‘g‘ri' });

        // Ban tekshirish
        const now = new Date();
        if (user.ban_until && new Date(user.ban_until) > now) {
            return res.json({ success: false, message: `Siz ban qilingan. Ban tugash vaqti: ${new Date(user.ban_until).toLocaleString()}` });
        }

        const token = jwt.sign({ id: user.id, username: user.username, rank: user.rank }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server xatosi' });
    }
});

// ================= MIDDLEWARE =================
function auth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success:false, message:'Token yo‘q' });

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ success:false, message:'Token formati noto‘g‘ri' });
    }

    try {
        req.user = jwt.verify(parts[1], JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({ success:false, message:'Token yaroqsiz' });
    }
}

async function adminAuth(req, res, next) {
    try {
        const userRes = await pool.query('SELECT rank FROM users WHERE id=$1', [req.user.id]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi' });
        if (userRes.rows[0].rank !== 'ADMIN') return res.status(403).json({ success: false, message: 'Siz admin emassiz' });
        next();
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server xatosi' });
    }
}

// ================= USER INFO =================
app.get('/me', auth, async (req, res) => {
    try {
        const userRes = await pool.query(
            'SELECT username, coins, tokens, rank FROM users WHERE id=$1',
            [req.user.id]
        );
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi' });
        res.json({ success: true, user: userRes.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server xatosi' });
    }
});

// ================= MC STATUS =================
const MC_HOST = 'mc.uzbsmp.uz';
const MC_PORT = 25705;

app.get('/mc-status', async (req, res) => {
    try {
        const result = await status(MC_HOST, MC_PORT, { timeout: 3000 });
        res.json({ online: true, playersOnline: result.players.online, playersMax: result.players.max, version: result.version.name });
    } catch (err) {
        res.json({ online: false, playersOnline: 0, playersMax: 0 });
    }
});

// ================= ITEMS & RANKS =================
const ITEMS = [
    { id: 1, name: 'Totem', item: 'totem_of_undying', price: 1500, amount: 1 },
    { id: 2, name: 'Enchanted Golden Apple', item: 'enchanted_golden_apple', price: 2500, amount: 1 },
    { id: 3, name: 'Mace', item: 'mace', price: 20000, amount: 1 },
    { id: 4, name: 'Elytra', item: 'elytra', price: 10000, amount: 1 },
    { id: 5, name: 'Villager Spawn Egg', item: 'villager_spawn_egg', price: 10000, amount: 1 },
    { id: 6, name: 'Wind Charge (64)', item: 'wind_charge', price: 1500, amount: 64 },
    { id: 7, name: 'End Crystal', item: 'end_crystal', price: 700, amount: 1 },
    { id: 8, name: 'Respawn Anchor', item: 'respawn_anchor', price: 1000, amount: 1 },
    { id: 9, name: 'Trident', item: 'trident', price: 5000, amount: 1},
    { id: 10, name: 'Nether Star', item: 'nether_star', price: 3000, amount: 1 },
    { id: 11, name: "bottle o' enchanting (64)", item: 'experience_bottle', price: 4000, amount: 64 },
    { id: 12, name: 'Smithing Template', item: 'netherite_upgrade_smithing_template', price: 5000, amount: 1 }
];

const RANKS = {
    PLAYER: {},
    VIP: { type: 'coin', price: 50000, lpGroup: 'vip' },
    MVP: { type: 'money', price: 5, lpGroup: 'mvp' },
    LEGEND: { type: 'money', price: 10, lpGroup: 'legend' },
    ADMIN: {}
};

// ================= SERVER START =================
const PORT = process.env.PORT || 3000;

(async () => {
    await initDatabase();
    app.listen(PORT, () => console.log(`🚀 Server ${PORT}-portda ishga tushdi`));
})();
