-- Web push for paired viewer devices (docs/notifications.md): at most one subscription per device,
-- made by the device itself and removed with it. `endpoint` is the browser's push service address
-- (only known push services are accepted); `p256dh` and `auth` are the device's public key and
-- secret the messages are encrypted to, base64url as the browser gives them.
CREATE TABLE push_subscriptions (
  device_id TEXT PRIMARY KEY REFERENCES viewer_devices (id),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
