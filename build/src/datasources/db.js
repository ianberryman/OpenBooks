"use strict";
const postgres = require("postgres");
const path = require("path");
const logger = require("../../logger");
const pool = postgres({
    host: "localhost",
    user: "openbooks",
    password: "password",
    database: "openbooks",
    max: 5,
});
function init() {
    logger.info("Connecting to PostgreSQL database...");
    logger.debug("Creating tables");
    pool.file(path.join(__dirname, "../../sql/schema.sql"))
        .then(() => {
        logger.debug("Tables created");
        logger.info("Database connection successful");
    })
        .catch(error => {
        logger.error("An error occurred connecting to PostgreSQL...");
        logger.error(error);
        process.kill(process.pid, 'SIGTERM');
    });
}
init();
module.exports = pool;
