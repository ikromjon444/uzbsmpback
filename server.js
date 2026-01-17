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
const { log } = require('console');
require('dotenv').config();  // eng yuqori qatorda, boshqa koddan oldin


const app = express();
app.use(cors({
    origin: 'https://uzbsmp.uz', // HTTPS ishlatilsa
    methods: ['GET','POST','PUT','DELETE'], // kerakli HTTP metodlar
    credentials: true // agar cookie yuborish kerak bo'lsa
}));

app.use(bodyParser.json());
app.use(express.static('public'));

// ================= PostgreSQL =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        coins INTEGER DEFAULT 0,
        rank VARCHAR(20) DEFAULT 'PLAYER'
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

// ================= Bot =================
let bot = null;
const onlinePlayers = new Set();
function createBot() {
  if (bot) {
    try {
      bot.removeAllListeners();
      bot.quit();
    } catch {}
    bot = null;
    onlinePlayers.clear();
  }

  bot = mineflayer.createBot({
    host: 'mc.uzbsmp.uz',
    port: 25705,
    username: 'QQjon',
    version: '1.20.1'
  });

  bot.on('end', () => {
    setTimeout(createBot, 5000);
  });

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

// ================= Auth =================
const JWT_SECRET = process.env.JWT_SECRET;

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username va password kerak' });
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query('INSERT INTO users (username, password, coins, rank) VALUES ($1,$2,$3,$4)', [username, hash, 100, 'PLAYER']);
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
      return res.json({
        success: false,
        message: `Siz ban qilingan. Ban tugash vaqti: ${new Date(user.ban_until).toLocaleString()}`
      });
    }

    const token = jwt.sign({ id: user.id, username: user.username, rank: user.rank }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server xatosi' });
  }
});



// ================= Middleware =================
function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ success: false, message: 'Token yo‘q' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token xato' });
  }
}

// Admin middleware
async function adminAuth(req, res, next) {
  try {
    const userRes = await pool.query('SELECT rank FROM users WHERE id=$1', [req.user.id]);
    if (userRes.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi' });
    if (userRes.rows[0].rank !== 'ADMIN')
      return res.status(403).json({ success: false, message: 'Siz admin emassiz' });
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server xatosi' });
  }
}

// ================= User info =================
// ================= User info =================
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
  { id: 7, name: 'End Crystal', item: 'end_crystal', price: 1500, amount: 1 },
  { id: 8, name: 'Respawn Anchor', item: 'respawn_anchor', price: 1000, amount: 1 },
  { id: 9, name: 'Trident', item: 'trident', price: 5000, amount: 1},
  { id: 10, name: 'Nether Star', item: 'nether_star', price: 3000, amount: 1 },
  { id: 11, name: 'bottle o\' enchanting (64)', item: 'experience_bottle', price: 4000, amount: 64 },
  { id: 12, name: 'Smithing Template', item: 'netherite_upgrade_smithing_template', price: 5000, amount: 1 }
];

const RANKS = {
  PLAYER: {},
  VIP: { type: 'coin', price: 50000, lpGroup: 'vip' },
  MVP: { type: 'money', price: 5, lpGroup: 'mvp' },
  LEGEND: { type: 'money', price: 10, lpGroup: 'legend' },
  ADMIN: {} // Admin rank
};

// ================= ADMIN PROMOCODE =================
// ================= Promokod qo'shish (admin) =================
app.post('/admin/add-promo', auth, async (req, res) => {
    const { code, coins, expire_date } = req.body;

    // Oddiy tekshiruvlar
    if (!code || !coins) {
        return res.status(400).json({ success: false, message: 'Code va coins kerak' });
    }

    // Muddati formatini tekshirish (agar kiritilgan bo‘lsa)
    if (expire_date && isNaN(Date.parse(expire_date))) {
        return res.status(400).json({ success: false, message: 'Expire date noto‘g‘ri formatda' });
    }

    try {
        // Jadvalga qo‘shish
        await pool.query(
            'INSERT INTO promocodes (code, coins, expire_date) VALUES ($1, $2, $3)',
            [code, coins, expire_date || null]  // expire_date null bo‘lishi mumkin
        );

        res.json({ success: true, message: `Promokod ${code} qo‘shildi!` });
    } catch (err) {
        console.error(err);
        if (err.code === '23505') { // UNIQUE constraint
            return res.status(400).json({ success: false, message: 'Bu promokod mavjud' });
        }
        res.status(500).json({ success: false, message: 'Server xatosi' });
    }
});
// Banner rasm saqlash sozlamasi
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, 'banner' + path.extname(file.originalname))
});
const upload = multer({ storage });

// Admin uchun banner yuklash
app.post('/admin/upload-banner', auth, adminAuth, upload.single('banner'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Rasm tanlanmadi' });
  res.json({ success: true, message: 'Banner muvaffaqiyatli yuklandi!', url: `/uploads/${req.file.filename}` });
});
// ================= PROMOCODE REDEEM =================
app.post('/redeem', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ success:false, message:'Promokod kerak' });
  try {
    const promoRes = await pool.query('SELECT * FROM promocodes WHERE code=$1', [code]);
    const promo = promoRes.rows[0];
    if (!promo) return res.status(400).json({ success:false, message:'Noto‘g‘ri promokod' });
    const today = new Date().toISOString().split('T')[0];
    if (promo.expire_date && promo.expire_date < today) return res.status(400).json({ success:false, message:'Kod muddati tugagan' });
    const logRes = await pool.query('SELECT * FROM redeem_log WHERE user_id=$1 AND promo_id=$2', [req.user.id, promo.id]);
    if (logRes.rows.length > 0) return res.status(400).json({ success:false, message:'Siz allaqachon ishlatgansiz' });
    await pool.query('UPDATE users SET coins=coins+$1 WHERE id=$2', [promo.coins, req.user.id]);
    await pool.query('INSERT INTO redeem_log(user_id, promo_id) VALUES($1,$2)', [req.user.id, promo.id]);
    res.json({ success:true, coins: promo.coins, message:`Siz ${promo.coins} coin oldingiz!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server xatosi' });
  }
});

// ================= BUY VIP =================
app.post('/buy-rank/vip', auth, async (req, res) => {
  const rank = RANKS.VIP;
  try {
    const userRes = await pool.query('SELECT coins, username, rank FROM users WHERE id=$1', [req.user.id]);
    const user = userRes.rows[0];
    if (user.rank !== 'PLAYER') return res.status(400).json({ success:false, message:'Sizda allaqachon rank bor' });
    if (user.coins < rank.price) return res.status(400).json({ success:false, message:'Coin yetarli emas' });
    await pool.query('UPDATE users SET coins=coins-$1, rank=$2 WHERE id=$3', [rank.price, 'VIP', req.user.id]);
    if (onlinePlayers.has(user.username)) bot.chat(`/lp user ${user.username} parent set ${rank.lpGroup}`);
    res.json({ success:true, message:'VIP rank muvaffaqiyatli sotib olindi!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server xatosi' });
  }
});

// ================= GIVE RANK (ADMIN) =================
app.post('/give-rank', auth, adminAuth, async (req, res) => {
  const { username, rank } = req.body;
  if (!RANKS[rank]) return res.status(400).json({ success:false, message:'Noto‘g‘ri rank' });
  try {
    await pool.query('UPDATE users SET rank=$1 WHERE username=$2', [rank, username]);
    if (onlinePlayers.has(username)) bot.chat(`/lp user ${username} parent set ${RANKS[rank].lpGroup || ''}`);
    res.json({ success:true, message:`${username} ga ${rank} berildi` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false });
  }
});

// ================= GIVE COIN (ADMIN ONLY) =================
app.post('/givecoin', auth, adminAuth, async (req, res) => {
  const { username, coins } = req.body;

  if (!username || !coins)
    return res.status(400).json({ success: false, message: 'Username va coins kerak' });

  const coinAmount = parseInt(coins);
  if (isNaN(coinAmount) || coinAmount <= 0)
    return res.status(400).json({ success: false, message: 'Coins noto‘g‘ri' });

  try {
    const userRes = await pool.query(
      'SELECT id, coins FROM users WHERE username=$1',
      [username]
    );

    if (userRes.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi' });

    await pool.query(
      'UPDATE users SET coins = coins + $1 WHERE username=$2',
      [coinAmount, username]
    );

    res.json({
      success: true,
      message: `${username} ga ${coinAmount} coin berildi`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server xatosi' });
  }
});


// ================= BUY ITEM =================
app.post('/buy-item', auth, async (req, res) => {
  const { itemId, quantity } = req.body;
  const item = ITEMS.find(i => i.id === itemId);
  if (!item) return res.status(400).json({ success: false, message: 'Item topilmadi' });
  const qty = parseInt(quantity) || 1;
  if (qty <= 0) return res.status(400).json({ success: false, message: 'Miqdor 1 dan kichik bo‘lishi mumkin emas' });
  const totalPrice = item.price * qty;
  const userRes = await pool.query('SELECT coins, username FROM users WHERE id=$1', [req.user.id]);
  const user = userRes.rows[0];
  if (user.coins < totalPrice) return res.status(400).json({ success: false, message: 'Coin yetarli emas' });
  await pool.query('UPDATE users SET coins=coins-$1 WHERE id=$2', [totalPrice, req.user.id]);
  if (onlinePlayers.has(user.username)) bot.chat(`/give ${user.username} minecraft:${item.item} ${item.amount * qty}`);
  else await pool.query('INSERT INTO pending_items (username, item, amount) VALUES ($1,$2,$3)', [user.username, item.item, item.amount * qty]);
  res.json({ success: true, message: `Siz ${item.name} ni ${qty} dona sotib oldingiz!` });
});

// ================= MINI GAME =================
app.post('/play-game', auth, async (req, res) => {
  let coinsEarned = req.body.coinsEarned;
  if (!coinsEarned || coinsEarned <= 0) coinsEarned = Math.floor(Math.random() * 16) + 5;
  try {
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [coinsEarned, req.user.id]);
    res.json({ success: true, message: `Siz ${coinsEarned} coin yutdingiz!`, coinsEarned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Coin berishda xatolik' });
  }
});

// Faqat adminlar ko‘ra oladi
app.get('/admin/users', auth, async (req, res) => {
  try {
    const userRes = await pool.query('SELECT rank FROM users WHERE id=$1', [req.user.id]);
    if (userRes.rows[0].rank !== 'ADMIN') return res.status(403).json({ success:false, message:'Siz admin emassiz' });

    const users = await pool.query('SELECT username, coins, rank FROM users ORDER BY id ASC');
    res.json({ success:true, users: users.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server xatosi' });
  }
});
// ================= LEADERBOARD =================
// Leaderboard endpoint
// ================= LEADERBOARD (adminlarsiz) =================
app.get('/leaderboard', async (req, res) => {
  try {
    const now = new Date();
    const result = await pool.query(
      `SELECT username, coins, rank 
       FROM users 
       WHERE rank != 'ADMIN' 
         AND (ban_until IS NULL OR ban_until < $1)
       ORDER BY coins DESC 
       LIMIT 100`,
      [now]
    );
    res.json({ success: true, leaderboard: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server xatosi' });
  }
});

app.post('/admin/ban', auth, adminAuth, async (req, res) => {
    const { username, duration, unit } = req.body; // unit: 'seconds', 'minutes', 'hours', 'days', 'months'
    if (!username) return res.status(400).json({ success: false, message: 'Username kerak' });

    try {
        const userRes = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Foydalanuvchi topilmadi' });

        let banUntil = null;
        let timeString = 'doimiy';

        if (duration && duration > 0) {
            const now = new Date();
            let ms = 0;

            switch(unit) {
                case 'seconds': ms = duration * 1000; break;
                case 'minutes': ms = duration * 60 * 1000; break;
                case 'hours': ms = duration * 60 * 60 * 1000; break;
                case 'days': ms = duration * 24 * 60 * 60 * 1000; break;
                case 'months': ms = duration * 30 * 24 * 60 * 60 * 1000; break;
                default: ms = duration * 60 * 60 * 1000; 
            }

            banUntil = new Date(now.getTime() + ms);

            let remainingMs = ms;
            const days = Math.floor(remainingMs / 1000 / 60 / 60 / 24);
            remainingMs -= days * 24 * 60 * 60 * 1000;
            const hours = Math.floor(remainingMs / 1000 / 60 / 60);
            remainingMs -= hours * 60 * 60 * 1000;
            const minutes = Math.floor(remainingMs / 1000 / 60);
            remainingMs -= minutes * 60 * 1000;
            const seconds = Math.floor(remainingMs / 1000);

            timeString = '';
            if (days > 0) timeString += `${days} kun `;
            if (hours > 0) timeString += `${hours} soat `;
            if (minutes > 0) timeString += `${minutes} min `;
            if (seconds > 0) timeString += `${seconds} sek`;
        }

        await pool.query('UPDATE users SET ban_until=$1 WHERE username=$2', [banUntil, username]);

        const message = banUntil
            ? `${username} ${duration} ${unit}ga ban qilindi (${timeString})`
            : `${username} doimiy ban qilindi`;

        res.json({ success: true, message, banUntil });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server xatosi' });
    }
});


// UNBAN
app.post('/admin/unban', auth, adminAuth, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ success:false, message:'Username kerak' });

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ success:false, message:'Foydalanuvchi topilmadi' });

    await pool.query('UPDATE users SET ban_until=NULL WHERE username=$1', [username]);
    res.json({ success:true, message:`${username} unban qilindi` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server xatosi' });
  }
});
app.post('/token/sell', auth, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0)
    return res.status(400).json({ success:false });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const marketRes = await client.query(
      'SELECT * FROM token_market WHERE id=1 FOR UPDATE'
    );
    const market = marketRes.rows[0];

    const price = calculateTokenPrice(
      market.base_price,
      market.slope,
      market.total_supply
    );

    const sellPrice = price * 0.85; // 15% fee

    const userRes = await client.query(
      'SELECT tokens FROM users WHERE id=$1 FOR UPDATE',
      [req.user.id]
    );

    if (userRes.rows[0].tokens < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success:false, message:'Token yetarli emas' });
    }

    await client.query(
      'UPDATE users SET tokens=tokens-$1, coins=coins+$2 WHERE id=$3',
      [amount, sellPrice * amount, req.user.id]
    );

    await client.query(
      'UPDATE token_market SET total_supply=total_supply-$1 WHERE id=1',
      [amount]
    );

    await client.query(
      'INSERT INTO token_log (user_id,type,amount,price) VALUES ($1,$2,$3,$4)',
      [req.user.id, 'SELL', amount, sellPrice]
    );

    await client.query('COMMIT');
    res.json({ success:true, sold: amount, price: sellPrice });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success:false });
  } finally {
    client.release();
  }
});
// calculateTokenPrice funksiyasi
function calculateTokenPrice(basePrice, slope, totalSupply) {
    // Oddiy linear bonding curve: price = basePrice + slope * totalSupply
    return basePrice + slope * totalSupply;
}
app.post('/token/buy', auth, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0)
    return res.status(400).json({ success:false, message:'Amount noto‘g‘ri' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const marketRes = await client.query(
      'SELECT * FROM token_market WHERE id=1 FOR UPDATE'
    );
    const market = marketRes.rows[0];

    const price = calculateTokenPrice(
      market.base_price,
      market.slope,
      market.total_supply
    );

    const totalCost = price * amount;

    const userRes = await client.query(
      'SELECT coins FROM users WHERE id=$1 FOR UPDATE',
      [req.user.id]
    );

    if (userRes.rows[0].coins < totalCost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success:false, message:'Coin yetarli emas' });
    }

    await client.query(
      'UPDATE users SET coins=coins-$1, tokens=tokens+$2 WHERE id=$3',
      [totalCost, amount, req.user.id]
    );

    await client.query(
      'UPDATE token_market SET total_supply=total_supply+$1 WHERE id=1',
      [amount]
    );

    await client.query(
      'INSERT INTO token_log (user_id,type,amount,price) VALUES ($1,$2,$3,$4)',
      [req.user.id, 'BUY', amount, price]
    );

    await client.query('COMMIT');
    res.json({ success:true, bought: amount, price });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success:false });
  } finally {
    client.release();
  }
});
// Token bozorini olish
app.get('/token/market', async (req, res) => {
  try {
    const marketRes = await pool.query('SELECT * FROM token_market WHERE id=1');
    const market = marketRes.rows[0];

    if (!market) return res.status(404).json({ success:false, message:'Market topilmadi' });

    // Token narxini hisoblash
    const price = calculateTokenPrice(market.base_price, market.slope, market.total_supply);

    res.json({
      success: true,
      price,
      supply: market.total_supply
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server xatosi' });
  }
});

// Helper: token narxini hisoblovchi funksiya
function calculateTokenPrice(basePrice, slope, totalSupply) {
  // Oddiy lineer bonding curve formula
  return basePrice + slope * totalSupply;
}

// ================= SERVER =================
const PORT = process.env.PORT || 3000;

(async () => {
  await initDatabase();
  app.listen(PORT, () =>
    console.log(`🚀 Server ${PORT}-portda ishga tushdi`)
  );
})();
