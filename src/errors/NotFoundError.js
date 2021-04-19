const { ApolloError } = require('apollo-server-errors');

class NotFoundError extends ApolloError {
    constructor(message) {
        super(message, 'NOT_FOUND');
        
        Object.defineProperty(this, 'name', { value: 'NotFoundError' });
    }
}

module.exports = NotFoundError;