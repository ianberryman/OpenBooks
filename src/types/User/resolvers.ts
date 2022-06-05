import NotFoundError from '../../errors/NotFoundError'
import {IResolvers} from '../IResolvers'

async function users (_, args, { dataSources }) {
    const users = await dataSources.usersApi.getUsers()
    const result = users.map(user => ({
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.user_role
    }))
    return result
}

async function user (parent, { id }, { dataSources }) {
    const result = await dataSources.usersApi.getUserById(id)
    if (!result) throw new NotFoundError(`User with id: ${id} not found`)

    return {
        id: result?.id,
        firstName: result?.first_name,
        lastName: result?.last_name,
        email: result?.email,
        role: result?.user_role
    }
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