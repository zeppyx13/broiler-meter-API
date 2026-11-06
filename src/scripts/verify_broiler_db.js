require("dotenv").config({ quiet: true });
const db = require("../config/db");
const { verify } = require("../services/schemaCompatibility.service");

verify().then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
  }).finally(() => db.end());
