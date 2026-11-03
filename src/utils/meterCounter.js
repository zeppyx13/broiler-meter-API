const RESET_THRESHOLD = 0.5;
const scaled = (value) => BigInt(Number(value).toFixed(6).replace(".", ""));
function decimal(value) {
  return `${value / 1000000n}.${String(value % 1000000n).padStart(6, "0")}`;
}

function classify(previous, value, recordedAt, cycleId) {
  const current = scaled(value);
  const epoch = previous ? Number(previous.counter_epoch) : 0;
  if (!previous)
    return {
      reading_status: "baseline",
      delta_value: "0.000000",
      counter_epoch: epoch,
      is_latest: true,
    };
  const elapsed =
    recordedAt.getTime() - new Date(previous.recorded_at).getTime();
  const prior = scaled(previous.reading_value);
  if (elapsed < 0)
    return {
      reading_status: "out_of_order",
      delta_value: "0.000000",
      counter_epoch: epoch,
      is_latest: false,
    };
  if (elapsed === 0)
    return {
      reading_status: "suspect",
      delta_value: "0.000000",
      counter_epoch: epoch,
      is_latest: false,
    };
  if (current < prior) {
    // Heuristic, not proof: firmware has no reset ID/sequence. Smaller drops stay suspect.
    if (prior > 0n && Number(current) / Number(prior) < 1 - RESET_THRESHOLD) {
      return {
        reading_status: "reset",
        delta_value: "0.000000",
        counter_epoch: epoch + 1,
        is_latest: true,
      };
    }
    return {
      reading_status: "suspect",
      delta_value: "0.000000",
      counter_epoch: epoch,
      is_latest: false,
    };
  }
  // Never attribute a pre-placement/cross-cycle accumulation to the new flock.
  if (String(previous.flock_cycle_id) !== String(cycleId)) {
    return {
      reading_status: "baseline",
      delta_value: "0.000000",
      counter_epoch: epoch,
      is_latest: true,
    };
  }
  return {
    reading_status: "accepted",
    delta_value: decimal(current - prior),
    counter_epoch: epoch,
    is_latest: true,
  };
}

module.exports = { RESET_THRESHOLD, classify, scaled };
