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
  const decrypted = JSON.parse(
    Buffer.concat([decipher.update(data.slice(0, -TAG_LENGTH)), decipher.final()]).toString()
  );
  return { decrypted, aesKey, iv };
}

function encrypt(data, aesKey, iv) {
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) {
    flippedIv[i] = ~iv[i];
  }
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), 'utf-8'),
    cipher.final()
  ]);
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
      return p ? { id: p[1], title: p[2].substring(0, 30), description: `${parseFloat(p[3]).toFixed(2)} € / unité` } : null;
    }).filter(Boolean);
  } catch (e) {
    console.error('Odoo error:', e.message);
    return [
      { id: '1', title: 'Baguette tradition', description: '1.20 € / unité' },
      { id: '2', title: 'Pain complet', description: '2.50 € / unité' }
    ];
  }
}

app.post('/whatsapp-flow', async (req, res) => {
  try {
    const { decrypted, aesKey, iv } = decrypt(req.body);
    console.log('Action:', decrypted.action, '| Screen:', decrypted.screen);

    let responseData;

    if (decrypted.action === 'ping') {
      responseData = { data: { status: 'active' } };
    }
    else if (decrypted.action === 'INIT' || decrypted.action === 'BACK') {
      const produits = await getOdooProducts();
      responseData = {
        screen: 'SCREEN_PRODUITS',
        data: { produits }
      };
    }
    else if (decrypted.action === 'data_exchange') {
      const payload = decrypted.data;

      if (N8N_WEBHOOK) {
        axios.post(N8N_WEBHOOK, {
          phone: decrypted.flow_token,
          produit_id: payload.produit_id,
          quantite: payload.quantite,
          date_livraison: payload.date_livraison,
          commentaire: payload.commentaire
        }).catch(e => console.error('n8n error:', e.message));
      }

      const dateLabel = payload.date_livraison === 'demain'
        ? 'demain matin'
        : payload.date_livraison === 'apres_demain'
          ? 'apres-demain matin'
          : payload.commentaire || 'date a confirmer';

      responseData = {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: {
              flow_token: decrypted.flow_token,
              recap: `Commande recue ! Livraison : ${dateLabel}`
            }
          }
        }
      };
    }
    else {
      const produits = await getOdooProducts();
      responseData = {
        screen: 'SCREEN_PRODUITS',
        data: { produits }
      };
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
