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
const resolvers = {
    Query: {
        users: (_, __, { dataSources }) => __awaiter(void 0, void 0, void 0, function* () {
            const users = yield dataSources.usersApi.getUsers();
            var result = users.map(user => ({
                id: user.Id,
                firstName: user.FirstName,
                lastName: user.LastName,
                email: user.Email,
                role: user.UserRole
            }));
            return result;
        }),
        accounts: (_, __, { dataSources }) => __awaiter(void 0, void 0, void 0, function* () {
            const accounts = yield dataSources.accountsApi.getAccounts();
            var result = accounts.map(account => ({
                id: account.id,
                name: account.account_name,
                accountType: account.account_type,
                balance: account.balance,
                isSystemAccount: account.is_system_account
            }));
            return result;
        }),
        account: (_, args, { dataSources }) => __awaiter(void 0, void 0, void 0, function* () {
            const account = yield dataSources.accountsApi.getAccountById(args.id);
            var result = {
                id: account.id,
                name: account.account_name,
                accountType: account.account_type,
                balance: account.balance,
                isSystemAccount: account.is_system_account
            };
            return result;
        })
    },
};
module.exports = resolvers;
