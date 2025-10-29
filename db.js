const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "hotspot",
  password: "Jadoh@9708",
  port: 5432,
});

module.exports = pool;
