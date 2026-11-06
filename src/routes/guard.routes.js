const { Router } = require("express");
const auth = require("../middlewares/auth.middleware");
const controller = require("../controllers/guard.controller");

const rulesRouter = Router();
rulesRouter.use(auth);
rulesRouter.get("/", controller.listRules);
rulesRouter.post("/", controller.createRule);
rulesRouter.get("/:id", controller.getRule);
rulesRouter.patch("/:id", controller.updateRule);
rulesRouter.put("/:id", controller.updateRule);

const alertsRouter = Router();
alertsRouter.use(auth);
alertsRouter.get("/", controller.listAlerts);
alertsRouter.get("/:id", controller.getAlert);
alertsRouter.patch("/:id/ack", controller.acknowledge);
alertsRouter.patch("/:id/resolve", controller.resolve);

const statusRouter = Router();
statusRouter.use(auth);
statusRouter.get("/status", controller.status);

module.exports = { rulesRouter, alertsRouter, statusRouter };
