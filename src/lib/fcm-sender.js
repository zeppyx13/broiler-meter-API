const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const logger = require("../config/logger");

if (!getApps().length) {
  const serviceAccount = require(`../../${process.env.FCM_ADMIN_SDK}`);
  initializeApp({
    credential: cert(serviceAccount),
  });
}

async function sendNotification({ fcm_token, title, body, data = {} }) {
  if (!fcm_token) return;
  try {
    await getMessaging().send({
      token: fcm_token,
      notification: { title, body },
      data,
      android: {
        priority: "high",
        notification: {
          sound: "default",
          channelId: "coasther_default",
        },
      },
    });
    logger.info(`[FCM] Sent: ${title} → ${fcm_token.slice(0, 20)}...`);
  } catch (e) {
    logger.error(`[FCM] Error: ${e.message}`);
  }
}

module.exports = { sendNotification };
