const fields = {
  flow_rate_lpm: "flow_rate_lpm", water_total_liter: "water_total_liter",
  voltage: "voltage_v", current: "current_a", power: "power_w",
  energy_kwh_total: "energy_kwh_total", frequency: "frequency_hz", pf: "power_factor",
};

function retentionHours() {
  const configured = Number(process.env.BROILER_TELEMETRY_RETENTION_HOURS || 24);
  return Number.isFinite(configured) ? Math.min(168, Math.max(1, configured)) : 24;
}

function sampleInput(device, payload, source, receivedAt) {
  const time = new Date(payload.recorded_at).getTime();
  const received = new Date(receivedAt).getTime();
  if (!Number.isFinite(time) || !Number.isFinite(received) || time < Date.UTC(2000, 0, 1) || time > received + 300000 || time < received - retentionHours() * 3600000) return null;
  const scalars = {};
  const statuses = {};
  for (const [input, output] of Object.entries(fields)) {
    const value = payload[input];
    const valid = typeof value === "number" && Number.isFinite(value) && value >= 0;
    scalars[output] = valid ? value : null;
    statuses[output] = valid ? "recorded" : "no_data";
  }
  return {
    coop_id: device.coop_id, device_id: device.id,
    source: source === "simulation" ? "simulation" : "real",
    sample_bucket: new Date(Math.floor(time / 5000) * 5000),
    recorded_at: new Date(time), received_at: new Date(received),
    fields_json: scalars,
    quality_json: { field_status: statuses, clock_status: "validated_sensor_timestamp", physical_state_confirmed: false },
  };
}

function json(value) {
  try { return typeof value === "string" ? JSON.parse(value) : value || {}; } catch { return {}; }
}

function bucketSamples(rows, bucketSeconds) {
  const buckets = new Map();
  for (const row of rows) {
    const at = new Date(row.recorded_at).getTime();
    if (!Number.isFinite(at)) continue;
    const bucket = Math.floor(at / (bucketSeconds * 1000)) * bucketSeconds * 1000;
    if (!buckets.has(bucket)) buckets.set(bucket, new Map());
    const devices = buckets.get(bucket);
    const previous = devices.get(String(row.device_id));
    if (!previous || new Date(previous.recorded_at).getTime() < at) devices.set(String(row.device_id), row);
  }
  return [...buckets].sort(([a], [b]) => a - b).map(([at, devices]) => {
    const selected = [...devices.values()];
    const result = { recorded_at: new Date(at).toISOString(), sample_count: selected.length, device_ids: selected.map((r) => Number(r.device_id)), field_status: {} };
    for (const field of Object.values(fields)) {
      const values = selected.map((r) => json(r.fields_json)[field]).filter((v) => typeof v === "number" && Number.isFinite(v));
      result[field] = values.length === 1 ? values[0] : null;
      result.field_status[field] = values.length === 1 ? "recorded" : values.length ? "not_available" : "no_data";
    }
    result.status = Object.values(result.field_status).includes("not_available") ? "not_available" : "partial";
    result.received_at = selected.map((r) => new Date(r.received_at).toISOString()).sort().at(-1);
    return result;
  });
}

function calibrationSummary(entries) {
  const groups = new Map();
  for (const row of entries) {
    const key = `${row.device_id || "unassigned"}:${row.type}:${row.unit}:${row.verification_state}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((rows) => {
    const errors = rows.map((row) => Math.abs(Number(row.sensor_value) - Number(row.reference_value)) / Number(row.reference_value) * 100).filter(Number.isFinite);
    return {
      device_id: rows[0].device_id, type: rows[0].type, unit: rows[0].unit,
      verification_state: rows[0].verification_state,
      repetitions: rows.length,
      mean_error_pct: errors.length ? errors.reduce((sum, v) => sum + v, 0) / errors.length : null,
      physical_accuracy_confirmed: false,
      interpretation: "Manually entered instrument comparisons; independent verification is an operator attestation, not automatic physical validation",
    };
  });
}

module.exports = { fields, sampleInput, bucketSamples, retentionHours, calibrationSummary, json };
