const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3001;

const FRONTEND_URL          = process.env.FRONTEND_URL || 'https://tsengo.vercel.app';
const ONESIGNAL_APP_ID      = process.env.ONESIGNAL_APP_ID      || '4906cf47-153d-4eac-bf4a-2d8ca0df0f26';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const NOTIFY_SECRET          = process.env.NOTIFY_SECRET || '';

// ✅ CORS : Vercel + Render + localhost
app.use(cors({
  origin: [
    FRONTEND_URL,
    'https://tsengo.onrender.com',
    'http://localhost:5173',
    'http://localhost:4173',
    'http://localhost:3000',
  ],
}));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Tsengo Backend OK 🌸', version: '2.1.0' });
});

app.post('/notify', async (req, res) => {
  // Vérification du secret
  if (NOTIFY_SECRET && req.headers['x-notify-secret'] !== NOTIFY_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { toExternalId, title, message, data } = req.body;
  if (!toExternalId || !title || !message) {
    return res.status(400).json({ error: 'toExternalId, title, message required' });
  }
  if (!ONESIGNAL_REST_API_KEY) {
    return res.status(500).json({ error: 'ONESIGNAL_REST_API_KEY not configured' });
  }

  try {
    const notifType      = data?.type || 'general';
    const conversationId = data?.conversationId || '';
    const postId         = data?.postId || '';
    const iconUrl        = `${FRONTEND_URL}/icon-192.png`;

    // ── Boutons selon le type de notification ─────────────────
    let webButtons = [];
    let buttons    = [];

    if (notifType === 'message') {
      // Message → bouton Répondre
      webButtons = [
        {
          id:   'reply',
          text: '💬 Répondre',
          url:  `${FRONTEND_URL}/messages/${conversationId}`,
        },
      ];
      buttons = [
        { id: 'reply', text: '💬 Répondre' },
      ];
    } else {
      // Autre (commentaire, demande d'ami, réaction, publication boostée...)
      let targetUrl = FRONTEND_URL;
      if (notifType === 'comment' || notifType === 'reaction' || notifType === 'post') {
        targetUrl = `${FRONTEND_URL}/post/${postId}`;
      } else if (notifType === 'friend_request' || notifType === 'friend_accept') {
        targetUrl = `${FRONTEND_URL}/friends`;
      } else if (notifType === 'notification') {
        targetUrl = `${FRONTEND_URL}/notifications`;
      }

      webButtons = [
        {
          id:   'view',
          text: '👁️ Voir',
          url:  targetUrl,
        },
      ];
      buttons = [
        { id: 'view', text: '👁️ Voir' },
      ];
    }

    const payload = {
      app_id:            ONESIGNAL_APP_ID,
      include_aliases:   { external_id: [toExternalId] },
      target_channel:    'push',

      // Texte de la notification
      headings:  { en: title,   fr: title,   mg: title   },
      contents:  { en: message, fr: message, mg: message },

      // ✅ Logo Tsengo
      large_icon:       iconUrl,
      chrome_web_icon:  iconUrl,
      firefox_icon:     iconUrl,
      app_icon:         iconUrl,

      // ✅ Grande image optionnelle (si passé dans data)
      ...(data?.imageUrl ? { big_picture: data.imageUrl, chrome_web_image: data.imageUrl } : {}),

      // ✅ Boutons d'action
      buttons,
      web_buttons: webButtons,

      // ✅ Son de notification
      android_sound: 'notification',  // fichier notification.mp3 dans l'appli Android
      ios_sound:     'default',

      // Priorité & TTL
      priority: 10,
      ttl:      86400,

      // Données supplémentaires pour deep-link dans l'appli
      data: { ...data, notifType },
    };

    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Basic ' + ONESIGNAL_REST_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (response.ok) {
      res.json({ success: true, result });
    } else {
      console.error('OneSignal error:', result);
      res.status(response.status).json({ success: false, error: result });
    }
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('🌸 Tsengo Backend running on port ' + PORT);
});
