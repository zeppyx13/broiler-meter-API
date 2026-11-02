const { ok, fail } = require("../utils/response");
const dashboardService = require("../services/dashboard.service");

async function tenantDashboard(req, res) {
  try {
    const result = await dashboardService.getTenantDashboard(req.user.id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function getDashboardStats(req, res, next) {
  try {
    const stats = await dashboardService.getDashboardStats();

    return res.status(200).json({
      success: true,
      message: "Dashboard stats fetched successfully",
      data: stats,
    });
  } catch (error) {
    next(error);
  }
}

async function getDashboardChart(req, res, next) {
  try {
    const months = Math.min(Number(req.query.months) || 8, 12);
    const data = await dashboardService.getDashboardChart(months);
    res.json({ success: true, message: "OK", data });
  } catch (err) {
    next(err);
  }
}

async function getDashboardSummary(req, res, next) {
  try {
    const data = await dashboardService.getDashboardSummary();
    return res.status(200).json({
      success: true,
      message: "Dashboard summary fetched successfully",
      data,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  tenantDashboard,
  getDashboardStats,
  getDashboardChart,
  getDashboardSummary,
};
