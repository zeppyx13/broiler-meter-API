const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  timezone: "Z",
});

// mysql2's timezone controls serialization, not the server session's TIMESTAMP conversion.
pool.on("connection", (connection) => {
  connection.query("SET time_zone = ?", ["+00:00"], (error) => {
    if (error) connection.destroy();
  });
});

module.exports = pool;
