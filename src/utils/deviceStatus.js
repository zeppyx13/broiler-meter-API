function staleSeconds() {
  const value = Number(process.env.BROILER_DEVICE_STALE_SECONDS || 120);
  return Number.isFinite(value) && value >= 10 ? value : 120;
}

function presentDevice(row, now = new Date()) {
  const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : NaN;
  const age = now.getTime() - seen;
  const connectivity = !row.is_active
    ? "disabled"
    : !Number.isFinite(age) || age < 0
      ? "unknown"
      : age <= staleSeconds() * 1000
        ? "online"
        : "offline";
  return {
    ...row,
    data_provenance: row.data_provenance || "no_data",
    connectivity_status: connectivity,
    stale_after_seconds: staleSeconds(),
  };
}

module.exports = { presentDevice, staleSeconds };
