const { staleSeconds } = require("../utils/deviceStatus");
const { localDate } = require("../utils/farmDate");

function createEngine({ maxKeys = 512, maxSamples = 4096 } = {}) {
  const history = new Map();
  function observe(key, at, value, now, valid = true) {
    if (!history.has(key) && history.size >= maxKeys)
      history.delete(history.keys().next().value);
    const points = history.get(key) || [];
    if (!points.length || at > points[points.length - 1].at)
      points.push({ at, value, valid });
    while (
      points.length &&
      (points[0].at < now - 2400000 || points.length > maxSamples)
    )
      points.shift();
    history.set(key, points);
    return points;
  }
  function window(points, now, seconds, gap, minimum) {
    const since = now - seconds * 1000;
    let anchor = -1;
    for (let i = 0; i < points.length; i++)
      if (points[i].at <= since) anchor = i;
    if (anchor < 0) return null;
    const selected = points.slice(anchor);
    if (
      selected.length < minimum ||
      selected.some((point) => !point.valid) ||
      now - selected[selected.length - 1].at > gap * 1000
    )
      return null;
    for (let i = 1; i < selected.length; i++)
      if (selected[i].at - selected[i - 1].at > gap * 1000) return null;
    return selected;
  }
  function metadata(snapshot) {
    try {
      const value =
        typeof snapshot?.phase_data_json === "string"
          ? JSON.parse(snapshot.phase_data_json)
          : snapshot?.phase_data_json;
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  }
  function sample(snapshot, field, devices, source, now, gap) {
    const meta = metadata(snapshot);
    const expected = source === "simulation" ? "simulation" : "sensor";
    const deviceId = meta.metric_device_id?.[field] ?? snapshot?.device_id;
    const device = devices.find((item) => String(item.id) === String(deviceId));
    const at = new Date(
      meta.metric_recorded_at?.[field] ?? snapshot?.recorded_at ?? NaN,
    ).getTime();
    const value = snapshot?.[field] == null ? NaN : Number(snapshot[field]);
    const reason =
      snapshot?.source !== expected
        ? "unavailable_source"
        : Array.isArray(meta.ambiguous_metrics) &&
            meta.ambiguous_metrics.includes(field)
          ? "ambiguous_metric"
          : !device?.is_active
            ? "unavailable_device"
            : !Number.isFinite(value) || value < 0 || !Number.isFinite(at)
              ? "missing_measurement"
              : at > now || now - at > Math.min(staleSeconds(), gap) * 1000
                ? "stale_measurement"
                : null;
    return { device_id: deviceId ?? null, at, value, reason };
  }
  function result(rule, deviceId, status, reason, evidence = {}) {
    return {
      rule_id: rule.id,
      rule_code: rule.rule_code,
      device_id: deviceId,
      status,
      reason,
      evidence,
    };
  }
  function evaluateRule(
    rule,
    { coopId, snapshot, devices, now = new Date(), source = "rule", production, timezone = "Asia/Makassar" },
  ) {
    const clock = now.getTime();
    const p = rule.parameters_json;
    if (!rule.is_active)
      return [result(rule, null, "not_evaluated", "rule_disabled")];
    if (["daily_record_missing", "cycle_overdue"].includes(rule.rule_code)) {
      if (!production) return [result(rule, null, "insufficient_data", "production_context_unavailable")];
      const date = localDate(timezone, now);
      if (!production.cycle) return [result(rule, null, "recovery", "no_active_cycle", { local_date: date })];
      const evidence = { local_date: date, timezone, cycle_id: production.cycle.id, interpretation: "Production record reminder; no physical fault is inferred" };
      if (rule.rule_code === "cycle_overdue") {
        const target = production.cycle.planned_harvest_date;
        if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return [result(rule, null, "insufficient_data", "planned_harvest_date_missing", evidence)];
        const days = Math.floor((Date.parse(date) - Date.parse(target)) / 86400000);
        return [result(rule, null, days > p.grace_days ? "trigger" : "recovery", days > p.grace_days ? "planned_harvest_date_passed" : "within_harvest_target", { ...evidence, planned_harvest_date: target, overdue_days: Math.max(0, days), grace_days: p.grace_days })];
      }
      if (!production.daily_records_available) return [result(rule, null, "insufficient_data", "daily_records_migration_required", evidence)];
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
      const part = (key) => Number(parts.find((item) => item.type === key).value);
      const elapsed = (part("hour") - p.due_hour) * 3600 + part("minute") * 60 + part("second");
      const status = production.recorded_today ? "recovery" : elapsed >= rule.evaluation_window_sec ? "trigger" : "normal";
      return [result(rule, null, status, production.recorded_today ? "daily_record_present" : elapsed >= rule.evaluation_window_sec ? "daily_record_due" : "daily_record_deadline_pending", { ...evidence, due_hour: p.due_hour, recorded_today: production.recorded_today, evaluation_window_sec: rule.evaluation_window_sec })];
    }
    if (rule.rule_code === "device_offline") {
      const subjects = devices.filter(
        (device) =>
          device.is_active &&
          (!p.device_id || String(p.device_id) === String(device.id)),
      );
      if (!subjects.length)
        return [
          result(
            rule,
            p.device_id || null,
            "insufficient_data",
            "no_active_device",
          ),
        ];
      return subjects.map((device) => {
        const seen =
          device.last_seen_at == null
            ? NaN
            : new Date(device.last_seen_at).getTime();
        const age = (clock - seen) / 1000;
        const evidence = {
          last_seen_at: Number.isFinite(seen)
            ? new Date(seen).toISOString()
            : null,
          stale_after_seconds: p.stale_after_seconds,
          observed_age_seconds: Number.isFinite(age) ? age : null,
          interpretation:
            "Monitoring communication unavailable; this does not prove a physical power or fan failure",
        };
        const key = `${coopId}:${rule.id}:${device.id}:offline:${source}`;
        if (!Number.isFinite(seen) || age < 0)
          return result(
            rule,
            device.id,
            "insufficient_data",
            "no_trusted_receipt",
            evidence,
          );
        const invalidAt =
          device.last_invalid_timestamp_at == null
            ? NaN
            : new Date(device.last_invalid_timestamp_at).getTime();
        if (
          age >= p.stale_after_seconds &&
          Number.isFinite(invalidAt) &&
          invalidAt <= clock &&
          clock - invalidAt <=
            Math.max(p.stale_after_seconds, staleSeconds()) * 1000
        ) {
          observe(key, clock, 0, clock, false);
          evidence.last_invalid_timestamp_at = new Date(
            invalidAt,
          ).toISOString();
          return result(
            rule,
            device.id,
            "insufficient_data",
            "invalid_timestamp_received",
            evidence,
          );
        }
        if (age >= p.stale_after_seconds + rule.evaluation_window_sec) {
          observe(key, clock, 0, clock, false);
          return result(
            rule,
            device.id,
            "trigger",
            "sustained_monitoring_unavailable",
            evidence,
          );
        }
        const healthy = age <= p.stale_after_seconds / 2;
        const points = observe(key, clock, 1, clock, healthy);
        const recovered =
          healthy &&
          window(
            points,
            clock,
            p.recovery_window_sec,
            Math.max(30, p.stale_after_seconds / 2),
            2,
          );
        return result(
          rule,
          device.id,
          recovered ? "recovery" : "normal",
          healthy ? "fresh_receipt_recovery_window" : "offline_window_pending",
          evidence,
        );
      });
    }
    if (
      rule.rule_code === "no_water_flow" &&
      (!p.expected_flow ||
        !p.context_note ||
        !p.expected_flow_until ||
        Date.parse(p.expected_flow_until) <= clock)
    ) {
      return [
        result(
          rule,
          null,
          "insufficient_evidence",
          "expected_flow_context_missing_or_expired",
        ),
      ];
    }
    const field =
      rule.rule_code === "suspected_power_anomaly"
        ? "power_w"
        : rule.rule_code === "voltage_abnormal" ? "voltage_v"
          : rule.rule_code === "low_power_factor" ? "power_factor" : "flow_rate_lpm";
    const measurement = sample(
      snapshot,
      field,
      devices,
      source,
      clock,
      p.max_sample_gap_sec,
    );
    if (!measurement.reason && field === "power_w") {
      const voltage = sample(
        snapshot,
        "voltage_v",
        devices,
        source,
        clock,
        p.max_sample_gap_sec,
      );
      if (
        measurement.value <= 0 ||
        voltage.reason ||
        voltage.value < p.min_voltage_v ||
        String(voltage.device_id) !== String(measurement.device_id) ||
        Math.abs(voltage.at - measurement.at) > p.max_sample_gap_sec * 1000
      ) {
        measurement.reason = "invalid_or_unsupported_panel_measurement";
      }
    }
    if (!measurement.reason && field === "voltage_v" && measurement.value <= 0) measurement.reason = "invalid_or_unsupported_voltage_measurement";
    if (!measurement.reason && field === "power_factor") {
      const power = sample(snapshot, "power_w", devices, source, clock, p.max_sample_gap_sec);
      if (measurement.value <= 0 || power.reason || power.value < p.min_power_w || String(power.device_id) !== String(measurement.device_id) || Math.abs(power.at - measurement.at) > p.max_sample_gap_sec * 1000) measurement.reason = "power_factor_requires_valid_panel_load";
    }
    const key = `${coopId}:${rule.id}:${measurement.device_id || "unknown"}:${field}:${source}`;
    const points = observe(
      key,
      measurement.reason ? clock : measurement.at,
      measurement.value,
      clock,
      !measurement.reason,
    );
    const evidence = {
      metric: field,
      latest_value: !measurement.reason ? measurement.value : null,
      measurement_at: Number.isFinite(measurement.at)
        ? new Date(measurement.at).toISOString()
        : null,
      window_seconds: rule.evaluation_window_sec,
      recovery_window_sec: p.recovery_window_sec,
      threshold: field === "power_w" ? p.min_power_w : field === "voltage_v" ? { min: p.min_voltage_v, max: p.max_voltage_v } : field === "power_factor" ? p.min_power_factor : p.max_flow_lpm,
      recovery_threshold:
        field === "power_w" ? p.recovery_power_w : field === "voltage_v" ? { min: p.recovery_min_voltage_v, max: p.recovery_max_voltage_v } : field === "power_factor" ? p.recovery_power_factor : p.recovery_flow_lpm,
      interpretation:
        field === "power_w"
          ? "Suspected aggregate load anomaly, not confirmation of an individual fan failure"
          : field === "voltage_v" ? "Sustained panel voltage anomaly; an individual appliance fault is not established"
            : field === "power_factor" ? "Low power factor with valid panel load; advisory inspection only"
          : rule.rule_code === "no_water_flow"
            ? "Expected tank-inlet flow absent; drinking intake is not measured"
            : "Sustained high tank-inlet flow; leakage is not confirmed",
    };
    if (rule.rule_code === "no_water_flow") {
      evidence.expected_flow_until = p.expected_flow_until;
      evidence.context_note = p.context_note;
    }
    if (measurement.reason)
      return [
        result(
          rule,
          measurement.device_id,
          "insufficient_data",
          measurement.reason,
          evidence,
        ),
      ];
    const sustained = window(
      points,
      clock,
      rule.evaluation_window_sec,
      p.max_sample_gap_sec,
      p.min_samples,
    );
    const recovery = window(
      points,
      clock,
      p.recovery_window_sec,
      p.max_sample_gap_sec,
      p.min_samples,
    );
    const breach = (point) =>
      field === "power_w"
        ? point.value < p.min_power_w
        : field === "voltage_v" ? point.value < p.min_voltage_v || point.value > p.max_voltage_v
          : field === "power_factor" ? point.value < p.min_power_factor
        : rule.rule_code === "no_water_flow"
          ? point.value <= p.max_flow_lpm
          : point.value > p.max_flow_lpm;
    const healthy = (point) =>
      field === "power_w"
        ? point.value >= p.recovery_power_w
        : field === "voltage_v" ? point.value >= p.recovery_min_voltage_v && point.value <= p.recovery_max_voltage_v
          : field === "power_factor" ? point.value >= p.recovery_power_factor
        : rule.rule_code === "no_water_flow"
          ? point.value >= p.recovery_flow_lpm
          : point.value <= p.recovery_flow_lpm;
    if (sustained?.every(breach)) {
      evidence.samples = sustained.length;
      evidence.window_started_at = new Date(sustained[0].at).toISOString();
      return [
        result(
          rule,
          measurement.device_id,
          "trigger",
          "sustained_configured_threshold",
          evidence,
        ),
      ];
    }
    if (recovery?.every(healthy))
      return [
        result(
          rule,
          measurement.device_id,
          "recovery",
          "sustained_recovery_threshold",
          evidence,
        ),
      ];
    return [
      result(
        rule,
        measurement.device_id,
        sustained ? "normal" : "insufficient_data",
        sustained
          ? "threshold_not_sustained_or_hysteresis"
          : "observation_window_incomplete",
        evidence,
      ),
    ];
  }
  function clearCoop(coopId) {
    for (const key of history.keys())
      if (key.startsWith(`${coopId}:`)) history.delete(key);
  }
  return {
    evaluateRule,
    clearCoop,
    historyStats: () => ({
      keys: history.size,
      samples: [...history.values()].reduce(
        (sum, points) => sum + points.length,
        0,
      ),
    }),
  };
}

module.exports = { createEngine };
