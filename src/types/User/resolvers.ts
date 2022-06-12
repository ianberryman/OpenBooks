import {IResolvers} from '../IResolvers'

async function users (_, args, { dataSources }) {
    return dataSources.userApi.getUsers()
}

async function user (parent, { id }, { dataSources }) {
    return dataSources.userApi.getUserById(id)
}

const resolvers: IResolvers = {
    api: {
        users,
        user,
    },
    type: {
        User: {}
    }
}
export default resolvers