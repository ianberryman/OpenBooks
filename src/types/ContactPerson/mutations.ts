import {ContactPerson, CreateContactPersonResponse} from './ContactPerson'

async function createContactPerson(_, { createContactPersonInput }, { dataSources }): Promise<CreateContactPersonResponse> {
    const contactPerson = dataSources.contactPersonApi.createContactPerson(ContactPerson.build(createContactPersonInput))
    return {
        success: true,
        contactPerson,
    }
}

const mutations = {
    createContactPerson,
}

export default mutations