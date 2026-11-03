const meterService = require("./meterBroiler.service");
const model = require("../models/meterHistory.model");

async function list(user, id, query) {
  const { meter } = await meterService.detail(user, id);
  const readings = await model.list(id, query);
  return {
    meter,
    readings,
    meta: {
      limit: query.limit,
      source: query.source,
      next_before_id:
        readings.length === query.limit ? readings.at(-1).id : null,
      order: "received_id_desc",
      units: { water: "liter", electricity: "kwh" },
    },
  };
}

module.exports = { list };
