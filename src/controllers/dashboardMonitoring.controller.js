const service = require("../services/dashboardMonitoring.service");
const validator = require("../validators/dashboardMonitoring.validator");
const { ok } = require("../utils/response");

async function summary(req, res) {
  return ok(
    res,
    await service.summary(req.user, validator.summaryQuery.parse(req.query)),
  );
}

async function charts(req, res) {
  return ok(
    res,
    await service.charts(req.user, validator.chartsQuery.parse(req.query)),
  );
}

module.exports = { summary, charts };
