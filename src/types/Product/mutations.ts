import {CreateProductResponse, UpdateProductResponse} from './Product'


async function createProduct(_, { createProductInput }, { dataSources }): Promise<CreateProductResponse> {
    const product = await dataSources.productApi.createProduct(createProductInput)
    return {
        success: true,
        product,
    }
}

async function updateProduct(_, { updateProductInput }, { dataSources }): Promise<UpdateProductResponse> {
    const product = await dataSources.productApi.updateProduct(updateProductInput)
    return {
        success: true,
        product,
    }
}

async function deleteProduct(_, { id }, { dataSources }): Promise<UpdateProductResponse> {
    await dataSources.productApi.deleteProduct(id)
    return {
        success: true,
    }
}

const mutations = {
    createProduct,
    updateProduct,
    deleteProduct,
}

export default mutations