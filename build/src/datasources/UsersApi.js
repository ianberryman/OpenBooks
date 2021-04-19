"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const { DataSource } = require('apollo-datasource');
const logger = require('../../logger');
const db = require('./db');
class UsersApi extends DataSource {
    constructor() {
        super();
    }
    initialize(config) {
        this.context = config.context;
    }
    getUsers() {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield db `SELECT Id, FirstName, LastName, Email, UserRole FROM user`;
            return result;
        });
    }
}
module.exports = UsersApi;
