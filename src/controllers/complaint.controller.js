const { ok, fail } = require("../utils/response");
const complaintService = require("../services/complaint.service");
const {
  createComplaintSchema,
  updateComplaintSchema,
  complaintIdParamSchema,
  listComplaintsQuerySchema,
  adminUpdateComplaintSchema,
} = require("../validators/complaint.validator");

async function create(req, res) {
  try {
    const payload = createComplaintSchema.parse(req.body);
    const result = await complaintService.createMyComplaint(
      req.user.id,
      payload,
    );
    return ok(res, result, "Complaint created", 201);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function list(req, res) {
  try {
    const query = listComplaintsQuerySchema.parse(req.query);
    const result = await complaintService.listMyComplaints(req.user.id, query);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function detail(req, res) {
  try {
    const { id } = complaintIdParamSchema.parse(req.params);
    const result = await complaintService.getMyComplaintDetail(req.user.id, id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function update(req, res) {
  try {
    const { id } = complaintIdParamSchema.parse(req.params);
    const payload = updateComplaintSchema.parse(req.body);
    const result = await complaintService.updateMyComplaint(
      req.user.id,
      id,
      payload,
    );
    return ok(res, result, "Complaint updated", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function listAll(req, res) {
  try {
    const query = listComplaintsQuerySchema.parse(req.query);

    const result = await complaintService.listAllComplaints(query);

    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}
async function adminDetail(req, res) {
  try {
    const { id } = complaintIdParamSchema.parse(req.params);
    const result = await complaintService.getComplaintDetailAdmin(id);
    return ok(res, result, "OK", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}

async function adminUpdate(req, res) {
  try {
    const { id } = complaintIdParamSchema.parse(req.params);
    const payload = adminUpdateComplaintSchema.parse(req.body);
    const result = await complaintService.updateComplaintAdmin(id, payload);
    return ok(res, result, "Complaint updated", 200);
  } catch (err) {
    return fail(res, err.message, err.statusCode || 400);
  }
}
module.exports = {
  create,
  list,
  detail,
  update,
  listAll,
  adminDetail,
  adminUpdate,
};
