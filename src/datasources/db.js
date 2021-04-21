"use strict";
const { Pool } = require("pg");
const path = require("path");
const logger = require("../../logger");
const fs = require('fs');
require('dotenv').config();

const pool = new Pool();

module.exports = pool;
