"use strict";
const { Pool } = require("pg");
const path = require("path");
const logger = require("../../logger");
const fs = require('fs');

const pool = new Pool();

pool.on('error', (error, client) => {
    console.log("error1", error)
});


module.exports = pool;
