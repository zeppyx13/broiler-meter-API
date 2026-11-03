function staleSeconds() {
  const value = Number(process.env.BROILER_DEVICE_STALE_SECONDS || 120);
  return Number.isFinite(value) && value >= 10 ? value : 120;
}

function presentDevice(row, now = new Date()) {
  const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
  const connectivity = !row.is_active
    ? "disabled"
    : seen == null
      ? "unknown"
      : now.getTime() - seen <= staleSeconds() * 1000
        ? "online"
        : "offline";
  return {
    ...row,
    connectivity_status: connectivity,
    stale_after_seconds: staleSeconds(),
  };
}

module.exports = { presentDevice, staleSeconds };
