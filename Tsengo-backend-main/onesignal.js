// src/utils/onesignal.js
// Frontend: miantso ny backend proxy — tsy misy REST API Key eto intsony

const ONESIGNAL_APP_ID = import.meta.env.VITE_ONESIGNAL_APP_ID || '4906cf47-153d-4eac-bf4a-2d8ca0df0f26';

// URL ny backend proxy ao amin'ny Render
// Aorian'ny deploy, ovao ity ho URL marina anao
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://tsengo-backend.onrender.com';

export function setOneSignalExternalId(uid) {
  try {
    if (window.OneSignalDeferred) {
      window.OneSignalDeferred.push(function(OneSignal) {
        OneSignal.login(uid);
      });
    } else if (window.OneSignal) {
      window.OneSignal.login(uid);
    }
  } catch (err) {
    console.warn('OneSignal setExternalId error:', err);
  }
}

export function removeOneSignalExternalId() {
  try {
    if (window.OneSignalDeferred) {
      window.OneSignalDeferred.push(function(OneSignal) {
        OneSignal.logout();
      });
    } else if (window.OneSignal) {
      window.OneSignal.logout();
    }
  } catch (err) {
    console.warn('OneSignal logout error:', err);
  }
}

export function requestNotificationPermission() {
  try {
    if (window.OneSignalDeferred) {
      window.OneSignalDeferred.push(function(OneSignal) {
        OneSignal.Notifications.requestPermission();
      });
    }
  } catch (err) {
    console.warn('OneSignal permission error:', err);
  }
}

// ✅ Miantso ny backend proxy — tsy mivantana amin'ny OneSignal intsony
export async function sendPushNotification({ toExternalId, title, message, data = {} }) {
  if (!toExternalId) return;

  try {
    const response = await fetch(`${BACKEND_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toExternalId, title, message, data }),
    });

    if (!response.ok) {
      const err = await response.json();
      console.warn('Push notification error:', err);
    }
  } catch (err) {
    console.warn('Push notification fetch error:', err);
  }
}
