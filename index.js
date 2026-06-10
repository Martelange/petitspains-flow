const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { Client } = require('pg');

const app = express();
app.use(express.json());

const PRIVATE_KEY = process.env.RSA_PRIVATE_KEY;
const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_UID = parseInt(process.env.ODOO_UID);
const ODOO_KEY = process.env.ODOO_API_KEY;
const WA_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID || '1107381829131462';
const DB_URL = process.env.DATABASE_URL;

// ── Postgres session helpers ──────────────────────────────────────────────────
async function dbQuery(sql, params = []) {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try { return await client.query(sql, params); }
  finally { await client.end(); }
}

async function savePendingOrder(phone, data) {
  await dbQuery(
    `CREATE TABLE IF NOT EXISTS pending_flow_orders (phone VARCHAR(20) PRIMARY KEY, data TEXT, created_at TIMESTAMP DEFAULT NOW())`
  );
  await dbQuery(
    `INSERT INTO pending_flow_orders (phone, data) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET data = $2, created_at = NOW()`,
    [phone, JSON.stringify(data)]
  );
}

async function getPendingOrder(phone) {
  await dbQuery(`CREATE TABLE IF NOT EXISTS pending_flow_orders (phone VARCHAR(20) PRIMARY KEY, data TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  const res = await dbQuery('SELECT data FROM pending_flow_orders WHERE phone = $1', [phone]);
  return res.rows[0] ? JSON.parse(res.rows[0].data) : null;
}

async function deletePendingOrder(phone) {
  await dbQuery('DELETE FROM pending_flow_orders WHERE phone = $1', [phone]);
}

// ── Crypto ────────────────────────────────────────────────────────────────────
function decrypt(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  const aesKey = crypto.privateDecrypt(
    { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encrypted_aes_key, 'base64')
  );
  const iv = Buffer.from(initial_vector, 'base64');
  const data = Buffer.from(encrypted_flow_data, 'base64');
  const TAG_LENGTH = 16;
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(data.slice(-TAG_LENGTH));
  const decrypted = JSON.parse(Buffer.concat([decipher.update(data.slice(0, -TAG_LENGTH)), decipher.final()]).toString());
  return { decrypted, aesKey, iv };
}

function encrypt(data, aesKey, iv) {
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) flippedIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
}

// ── Odoo helpers ──────────────────────────────────────────────────────────────
async function getOdooProducts() {
  try {
    const res = await axios.post(
      `${ODOO_URL}/xmlrpc/2/object`,
      `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>product.template</value></param><param><value>search_read</value></param><param><value><array><data><array><data></data></array></data></array></value></param><param><value><struct><member><name>fields</name><value><array><data><value>id</value><value>name</value><value>list_price</value></data></array></value></member><member><name>limit</name><value><int>20</int></value></member></struct></value></param></params></methodCall>`,
      { headers: { 'Content-Type': 'text/xml' } }
    );
    const xml = res.data;
    const matches = xml.match(/<member>\s*<name>id<\/name>\s*<value><int>(\d+)<\/int><\/value>\s*<\/member>\s*<member>\s*<name>name<\/name>\s*<value><string>([^<]+)<\/string><\/value>\s*<\/member>\s*<member>\s*<name>list_price<\/name>\s*<value><double>([^<]+)<\/double><\/value>/g) || [];
    return matches.map(m => {
      const p = m.match(/<int>(\d+)<\/int>.*?<string>([^<]+)<\/string>.*?<double>([^<]+)<\/double>/s);
      if (!p) return null;
      const price = parseFloat(p[3]);
      return {
        id: p[1],
        title: p[2].substring(0, 30),
        description: `${price.toFixed(2)} € / unité`,
        price  // gardé pour le calcul interne, retiré avant d'envoyer au Dropdown
      };
    }).filter(Boolean);
  } catch (e) {
    console.error('Odoo products error:', e.message);
    return [{ id: '1', title: 'Baguette tradition', description: '1.20 € / unité', price: 1.20 }];
  }
}

async function findOrCreatePartner(phone, name) {
  try {
    const phoneClean = phone.replace('+', '').replace(/\s/g, '');
    console.log('Searching partner:', phoneClean);

    // Chercher par phone
    const searchRes = await axios.post(
      `${ODOO_URL}/xmlrpc/2/object`,
      `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>res.partner</value></param><param><value>search_read</value></param><param><value><array><data><array><data><value><array><data><value>phone</value><value>like</value><value>${phoneClean}</value></data></array></value></data></array></data></array></value></param><param><value><struct><member><name>fields</name><value><array><data><value>id</value><value>name</value></data></array></value></member><member><name>limit</name><value><int>1</int></value></member></struct></value></param></params></methodCall>`,
      { headers: { 'Content-Type': 'text/xml' } }
    );
    console.log('Partner search:', searchRes.data.substring(0, 200));

    const idMatch = searchRes.data.match(/<name>id<\/name>\s*<value><int>(\d+)<\/int>/);
    if (idMatch) { console.log('Partner found:', idMatch[1]); return parseInt(idMatch[1]); }

    // Créer nouveau partenaire
    const createRes = await axios.post(
      `${ODOO_URL}/xmlrpc/2/object`,
      `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>res.partner</value></param><param><value>create</value></param><param><value><array><data><value><struct><member><name>name</name><value><string>${name}</string></value></member><member><name>phone</name><value><string>+${phoneClean}</string></value></member><member><name>comment</name><value><string>Créé via WhatsApp Flow</string></value></member></struct></value></data></array></value></param><param><value><struct/></value></param></params></methodCall>`,
      { headers: { 'Content-Type': 'text/xml' } }
    );
    console.log('Partner create:', createRes.data.substring(0, 200));

    const newIdMatch = createRes.data.match(/<params>\s*<param>\s*<value><int>(\d+)<\/int>/);
    const newId = newIdMatch ? parseInt(newIdMatch[1]) : 1;
    console.log('New partner ID:', newId);
    return newId;
  } catch (e) {
    console.error('Partner error:', e.message);
    return 1;
  }
}

async function createOdooSO(partnerId, lignes, dateLivraison, dateRaw, phone, commentaire) {
  try {
    const orderLinesXml = lignes.map(item =>
      `<value><array><data><value><int>0</int></value><value><int>0</int></value><value><struct><member><name>product_id</name><value><int>${item.produit_id}</int></value></member><member><name>product_uom_qty</name><value><double>${item.qte}</double></value></member><member><name>price_unit</name><value><double>${item.prix}</double></value></member><member><name>name</name><value><string>${item.nom}</string></value></member></struct></value></data></array></value>`
    ).join('');

    const note = `WhatsApp Flow - ${phone}${commentaire ? ' - ' + commentaire : ''}`;
    const commitmentDateXml = (dateRaw && dateRaw.match(/^\d{4}-\d{2}-\d{2}$/))
      ? `<member><name>commitment_date</name><value><string>${dateRaw} 08:00:00</string></value></member>`
      : '';

    const res = await axios.post(
      `${ODOO_URL}/xmlrpc/2/object`,
      `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>sale.order</value></param><param><value>create</value></param><param><value><array><data><value><struct><member><name>partner_id</name><value><int>${partnerId}</int></value></member>${commitmentDateXml}<member><name>order_line</name><value><array><data>${orderLinesXml}</data></array></value></member><member><name>note</name><value><string>${note}</string></value></member><member><name>origin</name><value><string>WhatsApp Flow</string></value></member></struct></value></data></array></value></param><param><value><struct/></value></param></params></methodCall>`,
      { headers: { 'Content-Type': 'text/xml' } }
    );
    console.log('SO response:', res.data.substring(0, 300));

    // Extraire l'ID du SO depuis la réponse success (pas depuis une fault)
    if (res.data.includes('<fault>')) { console.error('SO fault:', res.data); return null; }
    const idMatch = res.data.match(/<params>\s*<param>\s*<value><int>(\d+)<\/int>/);
    return idMatch ? idMatch[1] : null;
  } catch (e) {
    console.error('SO error:', e.message);
    return null;
  }
}

async function sendWhatsAppMessage(to, message) {
  if (!WA_TOKEN) return;
  await axios.post(
    `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: message, preview_url: false } },
    { headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ── Webhook principal ─────────────────────────────────────────────────────────
app.post('/whatsapp-flow', async (req, res) => {
  try {
    const { decrypted, aesKey, iv } = decrypt(req.body);
    console.log('Action:', decrypted.action, '| Screen:', decrypted.screen);

    let responseData;

    // Ping santé
    if (decrypted.action === 'ping') {
      responseData = { data: { status: 'active' } };
    }
    // Chargement initial
    else if (decrypted.action === 'INIT' || decrypted.action === 'BACK') {
      const produits = await getOdooProducts();
      // Retirer "price" avant d'envoyer au Dropdown WhatsApp
      responseData = { screen: 'SCREEN_PRODUITS', data: { produits: produits.map(({ price, ...p }) => p) } };
    }
    // Soumission formulaire produits
    else if (decrypted.action === 'data_exchange' && decrypted.screen === 'SCREEN_PRODUITS') {
      const payload = decrypted.data || {};
      const phone = decrypted.flow_token;
      const produits = await getOdooProducts();
      const priceMap = {};
      produits.forEach(p => { priceMap[p.id] = { nom: p.title, prix: p.price }; });
      console.log('Price map keys:', Object.keys(priceMap));

      const lignes = [];
      for (let i = 1; i <= 3; i++) {
        const id = payload[`produit_${i}_id`];
        const qte = parseInt(payload[`produit_${i}_qte`]);
        console.log(`Produit ${i}: id=${id} qte=${qte} info=${JSON.stringify(priceMap[id])}`);
        if (id && qte > 0 && priceMap[id]) {
          lignes.push({ produit_id: id, nom: priceMap[id].nom, qte, prix: priceMap[id].prix });
        }
      }

      if (lignes.length === 0) {
        responseData = { screen: 'SCREEN_PRODUITS', data: { produits: produits.map(({ price, ...p }) => p), error_message: 'Veuillez sélectionner au moins un produit.' } };
      } else {
        const dateRaw = payload.date_livraison;
        let dateLabel = dateRaw || 'non précisée';
        if (dateRaw && dateRaw.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const d = new Date(dateRaw + 'T12:00:00');
          dateLabel = d.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        }
        await savePendingOrder(phone, { lignes, dateLivraison: dateLabel, dateRaw, commentaire: payload.commentaire || '' });

        const recapLines = lignes.map(l => `• ${l.nom} × ${l.qte} = ${(l.prix * l.qte).toFixed(2)} €`).join('\n');
        const total = lignes.reduce((s, l) => s + l.prix * l.qte, 0);
        const recap = `${recapLines}\n\nTotal estimé : ${total.toFixed(2)} €\nLivraison : ${dateLabel}${payload.commentaire ? '\nCommentaire : ' + payload.commentaire : ''}`;
        responseData = { screen: 'SCREEN_CONFIRMATION', data: { recap } };
      }
    }
    // Confirmation finale
    else if (decrypted.action === 'data_exchange' && decrypted.screen === 'SCREEN_CONFIRMATION') {
      const phone = decrypted.flow_token;
      const pending = await getPendingOrder(phone);

      if (pending) {
        const partnerId = await findOrCreatePartner(phone, 'Client WhatsApp');
        const soId = await createOdooSO(partnerId, pending.lignes, pending.dateLivraison, pending.dateRaw, phone, pending.commentaire);
        await deletePendingOrder(phone);

        const soRef = soId ? `#SO${soId}` : '';
        const recapLines = pending.lignes.map(l => `• ${l.nom} × ${l.qte}`).join('\n');
        const confirmMsg = `Commande ${soRef} enregistrée !\n\n${recapLines}\n\nLivraison : ${pending.dateLivraison}\n\nMerci et à bientôt ! 🍞`;
        setTimeout(() => sendWhatsAppMessage(phone, confirmMsg).catch(e => console.error('WA error:', e.message)), 1500);
      }

      responseData = { screen: 'SUCCESS', data: { extension_message_response: { params: { flow_token: decrypted.flow_token } } } };
    }
    else {
      const produits = await getOdooProducts();
      responseData = { screen: 'SCREEN_PRODUITS', data: { produits: produits.map(({ price, ...p }) => p) } };
    }

    const encrypted = encrypt(responseData, aesKey, iv);
    res.setHeader('Content-Type', 'text/plain');
    res.send(encrypted);

  } catch (err) {
    console.error('Error:', err.message);
    res.status(421).send('Decryption failed');
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flow endpoint running on port ${PORT}`));
