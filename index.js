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
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL;

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

async function getOdooProducts() {
  const res = await axios.post(`${ODOO_URL}/xmlrpc/2/object`, `<?xml version="1.0"?><methodCall><methodName>execute_kw</methodName><params><param><value>${ODOO_DB}</value></param><param><value><int>${ODOO_UID}</int></value></param><param><value>${ODOO_KEY}</value></param><param><value>product.template</value></param><param><value>search_read</value></param><param><value><array><data><array><data></data></array></data></array></value></param><param><value><struct><member><name>fields</name><value><array><data><value>id</value><value>name</value><value>list_price</value></data></array></value></member><member><name>limit</name><value><int>20</int></value></member></struct></value></param></params></methodCall>`, { headers: { 'Content-Type': 'text/xml' } });
  const xml = res.data;
  const matches = xml.match(/<member>\s*<name>id<\/name>\s*<value><int>(\d+)<\/int><\/value>\s*<\/member>\s*<member>\s*<name>name<\/name>\s*<value><string>([^<]+)<\/string><\/value>\s*<\/member>\s*<member>\s*<name>list_price<\/name>\s*<value><double>([^<]+)<\/double><\/value>/g) || [];
  return matches.map(m => {
    const p = m.match(/<int>(\d+)<\/int>.*?<string>([^<]+)<\/string>.*?<double>([^<]+)<\/double>/s);
    return p ? { id: p[1], title: p[2], description: `${parseFloat(p[3]).toFixed(2)} € / unité` } : null;
  }).filter(Boolean);
}

app.post('/whatsapp-flow', async (req, res) => {
  try {
    const { decrypted, aesKey, iv } = decrypt(req.body);
    console.log('Decrypted:', JSON.stringify(decrypted));

    let responseData;

    // Chargement initial des produits
    if (decrypted.action === 'INIT' || decrypted.screen === 'SCREEN_PRODUITS') {
      const produits = await getOdooProducts();
      responseData = {
        screen: 'SCREEN_PRODUITS',
        data: { produits }
      };
    }
    // Soumission du formulaire
    else if (decrypted.action === 'data_exchange') {
      const payload = decrypted.data;
      // Envoyer à n8n pour créer le SO
      if (N8N_WEBHOOK) {
        await axios.post(N8N_WEBHOOK, payload).catch(e => console.error('n8n error:', e.message));
      }
      const dateLabel = payload.date_livraison === 'demain' ? 'demain matin' : payload.date_livraison === 'apres_demain' ? 'après-demain matin' : payload.commentaire || 'date à confirmer';
      responseData = {
        screen: 'SCREEN_CONFIRMATION',
        data: {
          recap: `Commande reçue !\nLivraison : ${dateLabel}\n\nVous recevrez une confirmation par message.`
        }
      };
    }
    else {
      const produits = await getOdooProducts();
      responseData = { screen: 'SCREEN_PRODUITS', data: { produits } };
    }

    const encrypted = encrypt(responseData, aesKey, iv);
    res.json({ encrypted_flow_response: encrypted });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flow endpoint running on port ${PORT}`));
