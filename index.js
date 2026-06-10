const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());

const PRIVATE_KEY = process.env.RSA_PRIVATE_KEY;
const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_UID = parseInt(process.env.ODOO_UID);
const ODOO_KEY = process.env.ODOO_API_KEY;
const WA_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID || '1107381829131462';

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
  const decrypted = JSON.parse(
    Buffer.concat([decipher.update(data.slice(0, -TAG_LENGTH)), decipher.final()]).toString()
  );
  return { decrypted, aesKey, iv };
}

function encrypt(data, aesKey, iv) {
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) flippedIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
}

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
      return p ? { 
        id: p[1], 
        title: p[2].substring(0, 30), 
        description: `${parseFloat(p[3]).toFixed(2)} € / unité`
      } : null;
    }).filter(Boolean);
  } catch (e) {
    console.error('Odoo products error:', e.message);
    return [{ id: '1', title: 'Baguette tradition', description: '1.20 € / unité'}];
  }
}

async function getOdooPrices() {
  try {
    const res = await axios.post(
      `${ODOO_URL}/xmlrpc/2/object`,
      `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>product.template</value></param><param><value>search_read</value></param><param><value><array><data><array><data></data></array></data></array></value></param><param><value><struct><member><name>fields</name><value><array><data><value>id</value><value>name</value><value>list_price</value></data></array></value></member><member><name>limit</name><value><int>20</int></value></member></struct></value></param></params></methodCall>`,
      { headers: { 'Content-Type': 'text/xml' } }
    );
    const xml = res.data;
    const matches = xml.match(/<member>\s*<name>id<\/name>\s*<value><int>(\d+)<\/int><\/value>\s*<\/member>\s*<member>\s*<name>name<\/name>\s*<value><string>([^<]+)<\/string><\/value>\s*<\/member>\s*<member>\s*<name>list_price<\/name>\s*<value><double>([^<]+)<\/double><\/value>/g) || [];
    const prices = {};
    matches.forEach(m => {
      const p = m.match(/<int>(\d+)<\/int>.*?<string>([^<]+)<\/string>.*?<double>([^<]+)<\/double>/s);
      if (p) prices[p[1]] = { nom: p[2], prix: parseFloat(p[3]) };
    });
    return prices;
  } catch (e) {
    return {};
  }
}

async function findOrCreatePartner(phone, name) {
  try {
    const phoneClean = phone.replace('+', '').replace(/\s/g, '');
    console.log('Searching partner with phone:', phoneClean);
    const searchRes = await axios.post(...);
    console.log('Partner search response:', searchRes.data.substring(0, 500));

    // 1. Chercher par téléphone mobile
    const searchRes = await axios.post(
      `${ODOO_URL}/xmlrpc/2/object`,
      `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>res.partner</value></param><param><value>search_read</value></param><param><value><array><data><array><data><value><array><data><value>|</value></data></array></value><value><array><data><value>mobile</value><value>like</value><value>${phoneClean}</value></data></array></value><value><array><data><value>phone</value><value>like</value><value>${phoneClean}</value></data></array></value></data></array></data></array></value></param><param><value><struct><member><name>fields</name><value><array><data><value>id</value><value>name</value></data></array></value></member><member><name>limit</name><value><int>1</int></value></member></struct></value></param></params></methodCall>`,
      { headers: { 'Content-Type': 'text/xml' } }
    );

    const idMatch = searchRes.data.match(/<name>id<\/name>\s*<value><int>(\d+)<\/int>/);
    if (idMatch) {
      console.log(`Partner found: ID ${idMatch[1]}`);
      return parseInt(idMatch[1]);
    }

    // 2. Créer un nouveau partenaire
    console.log(`Creating new partner: ${name} (${phone})`);
    const createRes = await axios.post(
      `${ODOO_URL}/xmlrpc/2/object`,
      `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>res.partner</value></param><param><value>create</value></param><param><value><array><data><value><struct><member><name>name</name><value><string>${name}</string></value></member><member><name>mobile</name><value><string>+${phoneClean}</string></value></member><member><name>comment</name><value><string>Client créé automatiquement via WhatsApp Bot</string></value></member></struct></value></data></array></value></param><param><value><struct/></value></param></params></methodCall>`,
      { headers: { 'Content-Type': 'text/xml' } }
    );

    const newIdMatch = createRes.data.match(/<value><int>(\d+)<\/int><\/value>/);
    const newId = newIdMatch ? parseInt(newIdMatch[1]) : 1;
    console.log(`New partner created: ID ${newId}`);
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

    // Construire la date ISO pour commitment_date (format Odoo: YYYY-MM-DD HH:MM:SS)
    let commitmentDate = '';
    if (dateRaw && dateRaw.match(/^\d{4}-\d{2}-\d{2}$/)) {
      commitmentDate = `${dateRaw} 08:00:00`;
    }

    const commitmentDateXml = commitmentDate
      ? `<member><name>commitment_date</name><value><string>${commitmentDate}</string></value></member>`
      : '';

    const res = await axios.post(
      `${ODOO_URL}/xmlrpc/2/object`,
      `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>sale.order</value></param><param><value>create</value></param><param><value><array><data><value><struct><member><name>partner_id</name><value><int>${partnerId}</int></value></member>${commitmentDateXml}<member><name>order_line</name><value><array><data>${orderLinesXml}</data></array></value></member><member><name>note</name><value><string>${note}</string></value></member><member><name>origin</name><value><string>WhatsApp Flow</string></value></member></struct></value></data></array></value></param><param><value><struct/></value></param></params></methodCall>`,
      { headers: { 'Content-Type': 'text/xml' } }
    );
    console.log('SO creation response:', res.data.substring(0, 500));
    const idMatch = res.data.match(/<value><int>(\d+)<\/int><\/value>/);
    return idMatch ? idMatch[1] : null;
  } catch (e) {
    console.error('SO creation error:', e.message);
    return null;
  }
}

async function sendWhatsAppMessage(to, message) {
  if (!WA_TOKEN) { console.log('No WA_TOKEN set'); return; }
  await axios.post(
    `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: message, preview_url: false } },
    { headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// Stockage temporaire des commandes en attente
const pendingOrders = {};

app.post('/whatsapp-flow', async (req, res) => {
  try {
    const { decrypted, aesKey, iv } = decrypt(req.body);
    console.log('Full decrypted:', JSON.stringify(decrypted));
    console.log('Action:', decrypted.action, '| Screen:', decrypted.screen);

    let responseData;

    // Health check ping
    if (decrypted.action === 'ping') {
      responseData = { data: { status: 'active' } };
    }
    // Chargement initial
    else if (decrypted.action === 'INIT' || decrypted.action === 'BACK') {
      const produits = await getOdooProducts();
      responseData = { screen: 'SCREEN_PRODUITS', data: { produits } };
    }
    // Soumission formulaire produits → afficher récap
    else if (decrypted.action === 'data_exchange' && (decrypted.screen === 'SCREEN_PRODUITS' || !decrypted.screen)) {
      const payload = decrypted.data;
      const phone = decrypted.flow_token;
      const produits = await getOdooProducts();

      // Construire les lignes
      const lignes = [];
      for (let i = 1; i <= 3; i++) {
        const id = payload[`produit_${i}_id`];
        const qte = parseInt(payload[`produit_${i}_qte`]);
        if (id && qte > 0) {
          const prod = produits.find(p => p.id === id);
          if (prod) {
            lignes.push({ produit_id: id, nom: prod.title, qte, prix: prod.price });
          }
        }
      }

      if (lignes.length === 0) {
        const produits2 = await getOdooProducts();
        responseData = {
          screen: 'SCREEN_PRODUITS',
          data: { produits: produits2, error_message: 'Veuillez sélectionner au moins un produit.' }
        };
      } else {
        // Formater la date
        const dateRaw = payload.date_livraison;
        let dateLabel = dateRaw || 'non précisée';
        if (dateRaw && dateRaw.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const d = new Date(dateRaw + 'T12:00:00');
          dateLabel = d.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        }

        // Stocker en attente
        pendingOrders[phone] = { lignes, dateLivraison: dateLabel, dateRaw, commentaire: payload.commentaire || '' };

        // Construire le récap
        const recapLines = lignes.map(l => `• ${l.nom} × ${l.qte} = ${(l.prix * l.qte).toFixed(2)} €`).join('\n');
        const total = lignes.reduce((s, l) => s + l.prix * l.qte, 0);
        const recap = `${recapLines}\n\nTotal estimé : ${total.toFixed(2)} €\nLivraison : ${dateLabel}${payload.commentaire ? '\nCommentaire : ' + payload.commentaire : ''}`;

        responseData = { screen: 'SCREEN_CONFIRMATION', data: { recap } };
      }
    }
    // Soumission formulaire produits → afficher récap
else if (decrypted.action === 'data_exchange') {
  const payload = decrypted.data || {};
  const phone = decrypted.flow_token;

  // Confirmation finale si on a une commande en attente et pas de produits soumis
  if (pendingOrders[phone] && !payload.produit_1_id) {
      const pending = pendingOrders[phone];
      const waName = 'Client WhatsApp';
      const partnerId = await findOrCreatePartner(phone, waName);
      const soId = await createOdooSO(
        partnerId,
        pending.lignes,
        pending.dateLivraison,
        pending.dateRaw,
        phone,
        pending.commentaire
      );
      delete pendingOrders[phone];
      const soRef = soId ? `#SO${soId}` : '';
      const recapLines = pending.lignes.map(l => `• ${l.nom} × ${l.qte}`).join('\n');
      const confirmMsg = `Commande ${soRef} enregistrée !\n\n${recapLines}\n\nLivraison : ${pending.dateLivraison}\n\nMerci et à bientôt ! 🍞`;
      setTimeout(() => {
        sendWhatsAppMessage(phone, confirmMsg).catch(e => console.error('WA confirm error:', e.message));
      }, 1500);
      responseData = {
        screen: 'SUCCESS',
        data: { extension_message_response: { params: { flow_token: phone } } }
      };
    }
    // Soumission des produits → afficher récap
    else {
      const produits = await getOdooProducts();
      const prices = await getOdooPrices();
      const lignes = [];
      for (let i = 1; i <= 3; i++) {
        const id = payload[`produit_${i}_id`];
        const qte = parseInt(payload[`produit_${i}_qte`]);
        if (id && qte > 0) {
          const info = prices[id];
          if (info) lignes.push({ produit_id: id, nom: info.nom, qte, prix: info.prix });
        }
      }
      if (lignes.length === 0) {
        responseData = {
          screen: 'SCREEN_PRODUITS',
          data: { produits, error_message: 'Veuillez sélectionner au moins un produit.' }
        };
      } else {
        const dateRaw = payload.date_livraison;
        let dateLabel = dateRaw || 'non précisée';
        if (dateRaw && dateRaw.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const d = new Date(dateRaw + 'T12:00:00');
          dateLabel = d.toLocaleDateString('fr-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        }
        pendingOrders[phone] = { lignes, dateLivraison: dateLabel, dateRaw, commentaire: payload.commentaire || '' };
        const recapLines = lignes.map(l => `• ${l.nom} × ${l.qte} = ${(l.prix * l.qte).toFixed(2)} €`).join('\n');
        const total = lignes.reduce((s, l) => s + l.prix * l.qte, 0);
        const recap = `${recapLines}\n\nTotal estimé : ${total.toFixed(2)} €\nLivraison : ${dateLabel}${payload.commentaire ? '\nCommentaire : ' + payload.commentaire : ''}`;
        responseData = { screen: 'SCREEN_CONFIRMATION', data: { recap } };
      }
    }
  }
  else {
    const produits = await getOdooProducts();
    responseData = { screen: 'SCREEN_PRODUITS', data: { produits } };
  }

    const encrypted = encrypt(responseData, aesKey, iv);
    res.setHeader('Content-Type', 'text/plain');
    res.send(encrypted);

  } catch (err) {
    console.error('Error:', err.message, err.stack);
    res.status(421).send('Decryption failed');
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flow endpoint running on port ${PORT}`));
