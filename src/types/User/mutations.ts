import {CreateUserResponse} from './User'

async function createUser(_, { createUserInput }, { dataSources }): Promise<CreateUserResponse> {
    const user = await dataSources.userApi.createUser(createUserInput)
    return {
        success: true,
        user,
    }
}

const mutations = {
    createUser,
}

export default mutations