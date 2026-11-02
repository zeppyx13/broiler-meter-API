const tenantService = require("./tenant.service");
const usageTenantService = require("./usageTenant.service");
const invoiceService = require("./invoice.service");
const announcementService = require("./announcement.service");
const dashboardModel = require("../models/dashboard.model");

async function getTenantDashboard(userId) {
  const [myRoomRes, myUsageRes, announcementsRes] = await Promise.all([
    tenantService.getMyRoom(userId),
    usageTenantService.getMyUsageMonthly(userId, null),
    announcementService.listAnnouncements({ page: 1, limit: 5 }),
  ]);

  let currentInvoice = null;
  try {
    const invRes = await invoiceService.getMyCurrentInvoice(userId);
    currentInvoice = invRes;
  } catch (e) {
    if (e.statusCode === 404) currentInvoice = null;
    else throw e;
  }

  return {
    lease: myRoomRes.lease,
    room: myRoomRes.room,
    usage: myUsageRes,
    invoice_current: currentInvoice,
    announcements: announcementsRes.announcements,
  };
}

function calculateGrowthPercentage(currentValue, previousValue) {
  if (previousValue < 0.001) {
    return currentValue > 0 ? 100 : 0;
  }

  return Number(
    (((currentValue - previousValue) / previousValue) * 100).toFixed(1),
  );
}

function getElectricityStatus(value) {
  if (value === 0) return "Belum ada penggunaan bulan ini";
  if (value < 200) return "Rendah bulan ini";
  if (value < 400) return "Stabil minggu ini";
  return "Penggunaan cukup tinggi";
}

async function getDashboardStats() {
  const [
    totalRooms,
    availableRooms,
    totalTenants,
    activeTenants,
    currentWaterUsage,
    lastWaterUsage,
    currentElectricityUsage,
  ] = await Promise.all([
    dashboardModel.countTotalRooms(),
    dashboardModel.countAvailableRooms(),
    dashboardModel.countTotalTenants(),
    dashboardModel.countActiveTenants(),
    dashboardModel.getCurrentMonthWaterUsage(),
    dashboardModel.getLastMonthWaterUsage(),
    dashboardModel.getCurrentMonthElectricityUsage(),
  ]);

  const waterGrowth = calculateGrowthPercentage(
    currentWaterUsage,
    lastWaterUsage,
  );

  return {
    totalRooms,
    availableRooms,
    totalTenants,
    activeTenants,
    waterUsage: Number(currentWaterUsage.toFixed(1)),
    waterGrowth,
    electricityUsage: Number(currentElectricityUsage.toFixed(1)),
    electricityStatus: getElectricityStatus(currentElectricityUsage),
  };
}

async function getDashboardChart(months = 8) {
  const rows = await dashboardModel.getMonthlyUsageChart(months);
  return { chart: rows };
}

async function getDashboardSummary() {
  const [income, occupancy, invoiceStatus, topRoom] = await Promise.all([
    dashboardModel.getCurrentMonthTotalIncome(),
    dashboardModel.countOccupiedRooms(),
    dashboardModel.countInvoicesByStatus(),
    dashboardModel.getRoomWithHighestUsage(),
  ]);

  return {
    totalIncome: income,
    occupiedRooms: occupancy.occupied,
    totalRooms: occupancy.total,
    paidInvoices: invoiceStatus.paid,
    unpaidInvoices: invoiceStatus.unpaid,
    highestUsageRoom: topRoom,
  };
}

module.exports = {
  getTenantDashboard,
  getDashboardStats,
  getDashboardChart,
  getDashboardSummary,
};
