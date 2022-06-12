import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {CreateProductInput, Product, UpdateProductInput} from '../types/Product/Product'

export default class ProductApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createProduct(productInput: CreateProductInput): Promise<Product> {
        return Product.create(productInput)
    }

    async updateProduct(productInput: UpdateProductInput): Promise<Product> {
        const product = Product.build(productInput)
        return product.save()
    }

    async deleteProduct(id: string): Promise<void> {
        const product = await this.getProductById(id)
        await product.destroy()
    }

    async getProducts(): Promise<Array<Product>> {
        return Product.findAll()
    }

    async getProductById(id: string): Promise<Product> {
        return Product.findByPk(idToBuffer(id))
    }
}