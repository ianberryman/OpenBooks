const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: "localhost",
    user: "openbooks",
    password: "password",
    database: "openbooks",
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });

module.exports = pool;